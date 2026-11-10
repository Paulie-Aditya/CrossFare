import { createInterface } from "node:readline/promises";
import { createPublicClient as createArkivReader } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createPublicClient, createWalletClient, formatUnits, hexToString, http, parseUnits, type Hex } from "viem";
import { createKeyPairSignerFromBytes, createSolanaRpc, getBase58Encoder } from "@solana/kit";
import { nativeHub, spendableAfterGas } from "./gas.ts";
import { signSolanaTransaction } from "./solana.ts";
import { privateKeyToAccount } from "viem/accounts";
import { QuoteSchema } from "@crossfare/core/arkiv-schema";
import { chainFor } from "./chains.ts";
import { loadAgentConfig, resolveGoal } from "./config.ts";
import { createSpendPolicy, type Charge } from "./policy.ts";
import { runAgent, type AgentTransaction } from "./run.ts";
import { parseHederaKey } from "@crossfare/core/hedera-key";

const config = loadAgentConfig(process.env);
const account = privateKeyToAccount(config.evmPrivateKey);

/** Asks the owner in the terminal. With no terminal, the owner must pass --recipient. */
async function askOwner(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("No terminal to ask in, so pass --recipient");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await prompt.question(question);
  } finally {
    prompt.close();
  }
}

const solanaSigner = config.solanaSecretKey ? await createKeyPairSignerFromBytes(getBase58Encoder().encode(config.solanaSecretKey)) : null;
const solanaRpc = createSolanaRpc(config.solanaRpcUrl);

const goal = await resolveGoal(process.argv.slice(2), account.address, askOwner, solanaSigner?.address);

/** Signs Crossfare's unsigned Solana transaction with the agent's own key and sends it. */
async function sendSolanaTransaction(input: { transaction: string }): Promise<string> {
  if (!solanaSigner) throw new Error("AGENT_SOLANA_KEY isn't set");
  const { wire, signature } = await signSolanaTransaction(input.transaction, solanaSigner.keyPair);
  await solanaRpc.sendTransaction(wire as never, { encoding: "base64", preflightCommitment: "confirmed" }).send();
  return signature;
}

/** Generous gas for a second leg: a swap, approvals included, at twice the current price. */
const SECOND_LEG_GAS = 600_000n;

async function spendableHub(hub: string, received: string): Promise<string | null> {
  const native = nativeHub(hub);
  if (!native) return received;
  const { chain, rpcUrl } = chainFor(native.chainId, config.rpcUrls);
  const reader = createPublicClient({ chain, transport: http(rpcUrl) });
  const [balance, gasPrice] = await Promise.all([reader.getBalance({ address: account.address }), reader.getGasPrice()]);
  const amount = spendableAfterGas(parseUnits(received, native.decimals), balance, gasPrice * SECOND_LEG_GAS * 2n);
  return amount === null ? null : formatUnits(amount, native.decimals);
}

const policy = createSpendPolicy({
  perCallCap: config.perCallCap,
  totalBudget: config.totalBudget,
  allowedPayTo: config.allowedPayTo,
  asset: config.usdcTokenId,
});

const signer = createClientHederaSigner(config.hederaAccount, parseHederaKey(config.hederaKey), {
  network: "hedera:testnet",
});

let pendingCharge: Charge | null = null;
const client = new x402Client()
  .register("hedera:testnet", new ExactHederaScheme(signer))
  .onBeforePaymentCreation(async ({ selectedRequirements: { payTo, amount, asset } }) => {
    const decision = policy.check({ payTo, amount, asset });
    if (!decision.allowed) return { abort: true, reason: decision.reason };
    pendingCharge = { payTo, amount, asset };
    return undefined;
  });
const payingFetch = wrapFetchWithPayment(globalThis.fetch, client);

async function postPaid(path: string, body: unknown) {
  pendingCharge = null;
  const response = await payingFetch(`${config.apiUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // Only a 200 settles, so only a 200 counts against the budget.
  if (response.status === 200 && pendingCharge) policy.record(pendingCharge);
  return { status: response.status, body: await response.json() };
}

const arkiv = createArkivReader({ chain: rabdi({ accessKey: config.arkivAccessKey }), transport: http() });

async function sendTransaction(transaction: AgentTransaction): Promise<string> {
  const { chain, rpcUrl } = chainFor(transaction.chainId, config.rpcUrls);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const reader = createPublicClient({ chain, transport: http(rpcUrl) });
  const hash = await wallet.sendTransaction({
    to: transaction.to as Hex,
    data: transaction.data as Hex,
    value: BigInt(transaction.value),
  });
  // A swap depends on the approval before it, so each must land before the next.
  await reader.waitForTransactionReceipt({ hash });
  return hash;
}

async function getJson(path: string) {
  return (await fetch(`${config.apiUrl}${path}`)).json() as Promise<any>;
}

const result = await runAgent(
  {
    discover: () => getJson("/.well-known/x402"),
    requestQuote: (request) => postPaid("/v1/quote", request),
    async readQuote(entityKey) {
      const entity = await arkiv.getEntity(entityKey as Hex, QuoteSchema);
      return { owner: entity.$owner, payload: JSON.parse(hexToString(entity.payload.value as Hex)) };
    },
    listQuotes: async () => (await getJson(`/v1/quotes?payer=${config.hederaAccount}`)).quotes,
    requestSwap: (quoteId, swapToken) => postPaid("/v1/swap", { quoteId, swapToken }),
    async requestNextLeg(swapId, swapToken, amount) {
      const response = await fetch(`${config.apiUrl}/v1/swaps/${swapId}/next`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ swapToken, ...(amount ? { amount } : {}) }),
      });
      return { status: response.status, body: await response.json() };
    },
    sendTransaction,
    spendableHub,
    ...(solanaSigner ? { sendSolanaTransaction } : {}),
    ownAddresses: [account.address, ...(solanaSigner ? [solanaSigner.address] : [])],
    async submitHash(swapId, hash) {
      await fetch(`${config.apiUrl}/v1/swaps/${swapId}/tx`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hash }),
      });
    },
    getStatus: (swapId) => getJson(`/v1/swaps/${swapId}`),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(line),
    allowLiveSwaps: config.allowLiveSwaps,
    allowedPayTo: config.allowedPayTo,
    pollIntervalMs: 15_000,
    maxPolls: 240,
  },
  goal,
);

console.log(`Outcome: ${result.outcome}${result.reason ? ` (${result.reason})` : ""}`);
console.log(`Spent ${Number(policy.spent()) / 1_000_000} USDC on Crossfare calls`);
process.exit(result.outcome === "completed" || result.outcome === "dry_run" ? 0 : 1);
