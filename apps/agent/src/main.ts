import { createPublicClient as createArkivReader } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createPublicClient, createWalletClient, hexToString, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { QuoteSchema } from "@crossfare/core/arkiv-schema";
import { loadAgentConfig, parseGoalArgs } from "./config.ts";
import { createSpendPolicy, type Charge } from "./policy.ts";
import { runAgent, type AgentTransaction } from "./run.ts";
import { parseHederaKey } from "@crossfare/core/hedera-key";

const config = loadAgentConfig(process.env);
const account = privateKeyToAccount(config.evmPrivateKey);
const goal = parseGoalArgs(process.argv.slice(2), account.address);

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
const reader = createPublicClient({ chain: base, transport: http(config.baseRpcUrl) });
const wallet = createWalletClient({ account, chain: base, transport: http(config.baseRpcUrl) });


async function sendTransaction(transaction: AgentTransaction): Promise<string> {
  if (transaction.chainId !== base.id) throw new Error(`Agent only signs on Base, not ${transaction.chainId}`);
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
    sendTransaction,
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
