import { readFileSync } from "node:fs";
import {
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { assembleJupiterTransaction, associatedTokenAccount, createSolanaReader, type SolanaRpcLike } from "./solana.ts";

const build = JSON.parse(readFileSync(new URL("./fixtures/jupiter/build-sol-usdc.json", import.meta.url), "utf8"));
const TAKER = "GZRiD2TR1oiSXXFDsGhLR5fZWbfHqY9KyfHkiChUuVBR";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function decode(wire: string) {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  // Typed as any version; these are always v0.
  return { transaction, message: message as typeof message & { instructions: unknown[]; addressTableLookups?: { lookupTableAddress: string }[] } };
}

describe("assembleJupiterTransaction", () => {
  it("makes an unsigned v0 transaction the taker pays for, on the quote's blockhash", async () => {
    const { transaction, lastValidBlockHeight } = await assembleJupiterTransaction(build, TAKER);
    const { transaction: decoded, message } = decode(transaction);
    expect(lastValidBlockHeight).toBe(build.blockhashWithMetadata.lastValidBlockHeight);
    expect(message.version).toBe(0);
    expect(message.staticAccounts[0]).toBe(TAKER);
    expect(message.lifetimeToken).toBe(getBase58Decoder().decode(Uint8Array.from(build.blockhashWithMetadata.blockhash)));
    // Only the taker signs, and nothing has signed yet.
    expect(Object.entries(decoded.signatures)).toEqual([[TAKER, null]]);
  });

  it("keeps every instruction, in Jupiter's order, through its lookup table", async () => {
    const { message } = decode((await assembleJupiterTransaction(build, TAKER)).transaction);
    const count = build.computeBudgetInstructions.length + build.setupInstructions.length + 1 + (build.cleanupInstruction ? 1 : 0) + build.otherInstructions.length;
    expect(message.instructions).toHaveLength(count);
    expect(message.addressTableLookups?.map((lookup) => lookup.lookupTableAddress)).toEqual(Object.keys(build.addressesByLookupTableAddress));
  });
});

describe("associatedTokenAccount", () => {
  it("matches the account Jupiter itself creates for the taker's USDC", async () => {
    const created = build.setupInstructions.find(
      (instruction: { programId: string; accounts: { pubkey: string }[] }) => instruction.programId.startsWith("ATok") && instruction.accounts[3]!.pubkey === USDC_MINT,
    );
    expect(await associatedTokenAccount(TAKER, USDC_MINT, TOKEN_PROGRAM)).toBe(created.accounts[1].pubkey);
  });
});

describe("createSolanaReader", () => {
  const FEE_ACCOUNT = "CeZCzj2zHBt9X2BCuywcXjp9WwWm1YJosicMmYuwwLnM";

  function fakeRpc(accounts: Record<string, string>, landed: unknown = null) {
    return {
      getAccountInfo: vi.fn((account: string) => ({ send: async () => ({ value: accounts[account] ? { owner: accounts[account] } : null }) })),
      getTransaction: vi.fn(() => ({ send: async () => landed })),
    } as unknown as SolanaRpcLike & { getTransaction: ReturnType<typeof vi.fn> };
  }

  it("finds the owner's token account for a mint when it exists", async () => {
    const reader = createSolanaReader({ rpc: fakeRpc({ [USDC_MINT]: TOKEN_PROGRAM, [FEE_ACCOUNT]: TOKEN_PROGRAM }) });
    expect(await reader.feeTokenAccount(TAKER, USDC_MINT)).toBe(FEE_ACCOUNT);
  });

  it("finds none when the account was never created", async () => {
    const reader = createSolanaReader({ rpc: fakeRpc({ [USDC_MINT]: TOKEN_PROGRAM }) });
    expect(await reader.feeTokenAccount(TAKER, USDC_MINT)).toBeNull();
  });

  it("reads a landed transaction's payer, error and token changes per owner", async () => {
    const balance = (owner: string, amount: string) => ({ accountIndex: 1, mint: USDC_MINT, owner, uiTokenAmount: { amount } });
    const reader = createSolanaReader({
      rpc: fakeRpc({}, {
        meta: { err: null, preTokenBalances: [balance(TAKER, "1000")], postTokenBalances: [balance(TAKER, "824368")] },
        transaction: { message: { accountKeys: [{ pubkey: TAKER }] } },
      }),
    });
    expect(await reader.getTransaction("5sig")).toEqual({
      failed: false,
      feePayer: TAKER,
      tokenChanges: [{ owner: TAKER, mint: USDC_MINT, change: "823368" }],
    });
  });

  it("reads nothing until the transaction lands, and an error as a failure", async () => {
    expect(await createSolanaReader({ rpc: fakeRpc({}) }).getTransaction("5sig")).toBeNull();
    const failed = createSolanaReader({ rpc: fakeRpc({}, { meta: { err: { InstructionError: [3, "Custom"] } }, transaction: { message: { accountKeys: [{ pubkey: TAKER }] } } }) });
    expect((await failed.getTransaction("5sig"))?.failed).toBe(true);
  });
});
