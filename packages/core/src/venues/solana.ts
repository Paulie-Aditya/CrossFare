import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createSolanaRpc,
  createTransactionMessage,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
} from "@solana/kit";
import type { JupiterBuild, SolanaReader, SolanaTransactionOutcome } from "./jupiter.ts";
import type { SolanaTransaction } from "./types.ts";

/**
 * Solana for the Jupiter venue: assembling /build's instructions into a transaction, and reading
 * the chain. Server-only: it is its own package entry so the web app never bundles it.
 */

const ASSOCIATED_TOKEN_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];

interface BuildInstruction {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}

interface BuildShape {
  computeBudgetInstructions?: BuildInstruction[];
  setupInstructions?: BuildInstruction[];
  swapInstruction: BuildInstruction;
  cleanupInstruction?: BuildInstruction | null;
  otherInstructions?: BuildInstruction[];
  tipInstruction?: BuildInstruction | null;
  addressesByLookupTableAddress?: Record<string, string[]> | null;
  blockhashWithMetadata: { blockhash: number[]; lastValidBlockHeight: number };
}

const role = ({ isSigner, isWritable }: { isSigner: boolean; isWritable: boolean }) =>
  isSigner ? (isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : isWritable ? AccountRole.WRITABLE : AccountRole.READONLY;

const base64 = getBase64Encoder();

function toInstruction(instruction: BuildInstruction): Instruction {
  return {
    programAddress: address(instruction.programId),
    accounts: instruction.accounts.map((account) => ({ address: address(account.pubkey), role: role(account) })),
    data: base64.encode(instruction.data),
  };
}

/** /build's instructions, in Jupiter's order, as a v0 transaction the taker pays for and signs. */
export async function assembleJupiterTransaction(build: JupiterBuild, taker: string): Promise<SolanaTransaction> {
  const parts = build as unknown as BuildShape;
  const instructions = [
    ...(parts.computeBudgetInstructions ?? []),
    ...(parts.setupInstructions ?? []),
    parts.swapInstruction,
    ...(parts.cleanupInstruction ? [parts.cleanupInstruction] : []),
    ...(parts.otherInstructions ?? []),
    ...(parts.tipInstruction ? [parts.tipInstruction] : []),
  ].map(toInstruction);
  const { blockhash, lastValidBlockHeight } = parts.blockhashWithMetadata;
  const lookupTables = Object.fromEntries(
    Object.entries(parts.addressesByLookupTableAddress ?? {}).map(([table, addresses]) => [address(table), addresses.map((entry) => address(entry))]),
  ) as Record<Address, Address[]>;

  const message = compressTransactionMessageUsingAddressLookupTables(
    pipe(
      createTransactionMessage({ version: 0 }),
      (draft) => setTransactionMessageFeePayer(address(taker), draft),
      (draft) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: getBase58Decoder().decode(Uint8Array.from(blockhash)) as Blockhash, lastValidBlockHeight: BigInt(lastValidBlockHeight) },
          draft,
        ),
      (draft) => appendTransactionMessageInstructions(instructions, draft),
    ),
    lookupTables,
  );
  return { transaction: getBase64EncodedWireTransaction(compileTransaction(message)), lastValidBlockHeight };
}

/** The associated token account where `owner` holds `mint` under a token program. */
export async function associatedTokenAccount(owner: string, mint: string, tokenProgram: string): Promise<string> {
  const encoder = getAddressEncoder();
  const [account] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [encoder.encode(address(owner)), encoder.encode(address(tokenProgram)), encoder.encode(address(mint))],
  });
  return account;
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

/** The few RPC methods the reader uses, so tests can stand in for a node. */
export interface SolanaRpcLike {
  getAccountInfo(account: Address, config: { encoding: "base64" }): { send(): Promise<{ value: { owner: string } | null }> };
  getTransaction(
    signature: never,
    config: { encoding: "jsonParsed"; maxSupportedTransactionVersion: 0; commitment: "confirmed" },
  ): {
    send(): Promise<{
      meta: { err: unknown; preTokenBalances?: TokenBalance[] | null; postTokenBalances?: TokenBalance[] | null } | null;
      transaction: { message: { accountKeys: { pubkey: string }[] } };
    } | null>;
  };
}

export function createSolanaReader(options: { rpcUrl?: string; rpc?: SolanaRpcLike }): SolanaReader {
  const rpc = options.rpc ?? (createSolanaRpc(options.rpcUrl ?? "https://api.mainnet-beta.solana.com") as unknown as SolanaRpcLike);

  return {
    async feeTokenAccount(owner, mint) {
      // A mint is owned by the token program it lives under, which the account's address depends on.
      const mintInfo = (await rpc.getAccountInfo(address(mint), { encoding: "base64" }).send()).value;
      if (!mintInfo || !TOKEN_PROGRAMS.includes(mintInfo.owner)) return null;
      const account = await associatedTokenAccount(owner, mint, mintInfo.owner);
      const info = (await rpc.getAccountInfo(address(account), { encoding: "base64" }).send()).value;
      return info && info.owner === mintInfo.owner ? account : null;
    },

    async getTransaction(signature): Promise<SolanaTransactionOutcome | null> {
      const landed = await rpc
        .getTransaction(signature as never, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" })
        .send();
      if (!landed?.meta) return null;
      const changes = new Map<string, { owner: string; mint: string; change: bigint }>();
      const add = (balances: TokenBalance[] | null | undefined, sign: bigint) => {
        for (const balance of balances ?? []) {
          if (!balance.owner) continue;
          const key = `${balance.owner}:${balance.mint}`;
          const entry = changes.get(key) ?? { owner: balance.owner, mint: balance.mint, change: 0n };
          entry.change += sign * BigInt(balance.uiTokenAmount.amount);
          changes.set(key, entry);
        }
      };
      add(landed.meta.preTokenBalances, -1n);
      add(landed.meta.postTokenBalances, 1n);
      return {
        failed: landed.meta.err !== null && landed.meta.err !== undefined,
        feePayer: landed.transaction.message.accountKeys[0]?.pubkey ?? "",
        tokenChanges: [...changes.values()].map((entry) => ({ ...entry, change: entry.change.toString() })),
      };
    },
  };
}
