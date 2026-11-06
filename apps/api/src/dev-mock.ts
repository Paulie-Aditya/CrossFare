// Local UI development only: fake venues, payments and Arkiv. Spends nothing and
// never runs in production, where main.ts is the entry point.
import { serve } from "@hono/node-server";
import type { Route, Venue } from "@crossfare/core";
import { createApp } from "./app.ts";
import { mountDemo } from "./demo.ts";
import { createStore } from "./store.ts";

const MOCK_STAGE_MS = Number(process.env.MOCK_STAGE_MS ?? 8_000);
const validUntil = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

const MOCK_ETH_PRICE = 2240;
const HASH = (digit: string) => `0x${digit.repeat(64)}`;

/** Walks an order through each stage on a clock, so the UI's feedback can be watched. */
function fakeVenue(name: string, routes: () => Partial<Route>[], eta: number, share: number): Venue {
  let preparedAt = 0;
  return {
    name,
    async quote(request) {
      const sameChain = request.from.asset.split(":")[0] === request.to.asset.split(":")[0];
      if (name === "uniswap" && !sameChain) return [];
      const usdIn = Number(request.from.amount);
      const out = (usdIn * share) / MOCK_ETH_PRICE;
      const amountOut = BigInt(Math.round(out * 1e18));
      return routes().map((route) => ({
        venue: name,
        from: request.from.asset,
        to: request.to.asset,
        amountIn: String(Math.round(usdIn * 1e6)),
        amountOut: amountOut.toString(),
        minAmountOut: ((amountOut * 97n) / 100n).toString(),
        fees: {},
        etaSeconds: eta,
        validUntil: validUntil(180),
        venueData: null,
        depositable: name === "swapkit",
        usd: { in: usdIn, out: usdIn * share },
        ...route,
      }));
    },
    async prepare(_route, request) {
      preparedAt = Date.now();
      const transfer = { kind: "swap" as const, chainId: 8453, to: "0x000000000000000000000000000000000000dEaD", data: "0x", value: "0x0" };
      if (name !== "swapkit") return { transactions: [transfer] };
      return {
        transactions: [transfer],
        deposit: {
          asset: request.from.asset,
          address: "0x2e1ee6c27e66243A6301878E5036e327D48b64B3",
          amount: request.from.amount,
          expiresAt: validUntil(1800),
          channelId: "mock-channel",
          minAmount: String(Number(request.from.amount) * 0.97),
        },
      };
    },
    async track(input) {
      const age = Date.now() - preparedAt;
      // Typing 7 sends too little and 8 sends too much, so the UI's handling of each can be seen.
      const typed = input.request.from.amount;
      if (typed === "7" && age >= MOCK_STAGE_MS) {
        if (age >= MOCK_STAGE_MS * 4) return { status: "refunded", amountSent: "6", refundReason: "INCOMPLETE_DEPOSIT" };
        return { status: "confirming", amountSent: "6" };
      }
      const sent = typed === "8" ? { amountSent: "9" } : {};
      if (age < MOCK_STAGE_MS && input.prepared.deposit) return { status: "awaiting_deposit" };
      if (age < MOCK_STAGE_MS * 2) return { status: "confirming", txHashes: [HASH("a")], ...sent };
      if (age < MOCK_STAGE_MS * 3) return { status: "exchanging", txHashes: [HASH("a"), "5i7QpCFZ2wpgSTV8okZbEgpitmxtZ91k8MMX5z6Mbcrr"] };
      const received = (Number(input.route.amountOut) * 1.002) / 1e18;
      return {
        status: "completed",
        ...sent,
        amountReceived: received.toFixed(18),
        txHashes: [HASH("a"), "5i7QpCFZ2wpgSTV8okZbEgpitmxtZ91k8MMX5z6Mbcrr", HASH("b")],
      };
    },
  };
}

const rows: unknown[] = [];
let settled = 0;

const app = createApp({
  venues: [
    fakeVenue("uniswap", () => [{}], 30, 0.996),
    fakeVenue("swapkit", () => [{ provider: "near" }, { provider: "flashnet" }], 49, 0.998),
  ],
  store: createStore(":memory:"),
  gateway: {
    paymentRequired: async () => ({ body: {}, headers: {} }),
    verify: async () => ({ valid: true, payer: "0.0.51234" }),
    settle: async () => ({ success: true, transactionId: `0.0.51234@1762339200.${++settled}`, payer: "0.0.51234" }),
  },
  audit: { log: async () => {} },
  publisher: {
    async publishQuote(quote) {
      const entityKey = `0x${quote.quoteId.padEnd(64, "0")}`;
      rows.unshift({ ...quote, entityKey });
      return entityKey;
    },
    async updateQuote() {},
    quotesByPayer: async () => rows,
    recentQuotes: async () => rows,
  },
  payTo: "0.0.999",
  trackIntervalMs: 500,
  priceIntervalMs: 0,
});

let payment = 0;
mountDemo(app, {
  limits: { perIpPerHour: 1000, perDay: 1000 },
  async paidPost(path, body) {
    const response = await app.request(path, {
      method: "POST",
      headers: { "payment-signature": `mock-${++payment}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  },
});

serve({ fetch: app.fetch, port: 8787 }, () => console.log("Mock Crossfare API on http://localhost:8787"));
