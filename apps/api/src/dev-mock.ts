// Local UI development only: fake venues, payments and Arkiv. Spends nothing and
// never runs in production, where main.ts is the entry point.
import { serve } from "@hono/node-server";
import type { Route, Venue } from "@crossfare/core";
import { createApp } from "./app.ts";
import { mountDemo } from "./demo.ts";
import { createStore } from "./store.ts";

const validUntil = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

function fakeVenue(name: string, routes: () => Partial<Route>[], eta: number): Venue {
  let polls = 0;
  return {
    name,
    async quote(request) {
      return routes().map((route) => ({
        venue: name,
        from: request.from.asset,
        to: request.to.asset,
        amountIn: "1000000",
        amountOut: "400000000000000",
        minAmountOut: "398000000000000",
        fees: {},
        etaSeconds: eta,
        validUntil: validUntil(180),
        venueData: null,
        depositable: name === "swapkit",
        ...route,
      }));
    },
    async prepare(_route, request) {
      polls = 0;
      const transfer = { kind: "swap" as const, chainId: 8453, to: "0x000000000000000000000000000000000000dEaD", data: "0x", value: "0x0" };
      if (name !== "swapkit") return { transactions: [transfer] };
      return {
        transactions: [transfer],
        deposit: {
          asset: request.from.asset,
          address: "0x2e1ee6c27e66243A6301878E5036e327D48b64B3",
          amount: request.from.amount,
          expiresAt: validUntil(86_400),
          channelId: "mock-channel",
        },
      };
    },
    async track(input) {
      polls += 1;
      if (polls <= 1 && input.txHashes.length === 0 && input.prepared.deposit) return { status: "awaiting_deposit" };
      if (polls < 3) return { status: "exchanging" };
      return { status: "completed", amountReceived: "0.0004" };
    },
  };
}

const rows: unknown[] = [];
let settled = 0;

const app = createApp({
  venues: [
    fakeVenue("uniswap", () => [{}], 30),
    fakeVenue(
      "swapkit",
      () => [{ provider: "chainflip", amountOut: "399000000000000", minAmountOut: "395500000000000" }],
      120,
    ),
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
