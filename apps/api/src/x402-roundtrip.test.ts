import { describe, expect, it, vi } from "vitest";
import { PrivateKey } from "@hiero-ledger/sdk";
import { x402Client } from "@x402/core/client";
import type { FacilitatorClient } from "@x402/core/server";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import type { Route, Venue } from "@crossfare/core";
import { createApp } from "./app.ts";
import { createPaidPost } from "./demo-payer.ts";
import { createStore } from "./store.ts";
import { createX402Gateway } from "./x402-gateway.ts";

const NETWORK = "hedera:testnet" as const;
const AGENT = "0xC9bebBA9f481b12cE6f3EA54c4B182c9636ec421";
const PAYER = "0.0.51234";

const route: Route = {
  venue: "uniswap",
  from: "base:usdc",
  to: "base:eth",
  amountIn: "2000000",
  amountOut: "1000000000000000",
  minAmountOut: "990000000000000",
  fees: {},
  etaSeconds: 30,
  validUntil: new Date(Date.now() + 60_000).toISOString(),
  venueData: null,
};

const venue: Venue = {
  name: "uniswap",
  quote: async () => [route],
  prepare: async () => ({ transactions: [] }),
  track: async () => ({ status: "confirming" }),
};

function fakeFacilitator() {
  let settled = 0;
  const seen: unknown[] = [];
  const facilitator: FacilitatorClient = {
    getSupported: async () => ({
      kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK, extra: { feePayer: "0.0.9185802" } }],
      extensions: [],
      signers: {},
    }),
    verify: vi.fn(async (payload) => {
      seen.push(payload);
      return { isValid: true, payer: PAYER };
    }),
    settle: vi.fn(async () => ({
      success: true,
      transaction: `0.0.9185802@1762339200.${++settled}`,
      network: NETWORK,
      payer: PAYER,
    })),
  };
  return { facilitator, seen };
}

async function setup() {
  const { facilitator, seen } = fakeFacilitator();
  const app = createApp({
    venues: [venue],
    store: createStore(":memory:"),
    gateway: await createX402Gateway({ facilitator, payTo: "0.0.999", usdcTokenId: "0.0.429274" }),
    audit: { log: async () => {} },
    publisher: {
      publishQuote: async () => "0xkey",
      updateQuote: async () => {},
      quotesByPayer: async () => [],
      recentQuotes: async () => [],
    },
    payTo: "0.0.999",
    onError: () => {},
  });
  return { app, facilitator, seen };
}

const quoteBody = {
  from: { asset: "base:usdc", amount: "2", address: AGENT },
  to: { asset: "base:eth", address: AGENT },
};

/** The official client signs a real Hedera transfer offline. Only the facilitator is fake. */
describe("x402 round trip", () => {
  it("pays a 402 with the official client and gets the quote", async () => {
    const { app, facilitator, seen } = await setup();
    const signer = createClientHederaSigner(PAYER, PrivateKey.generateECDSA(), { network: NETWORK });
    const client = new x402Client().register(NETWORK, new ExactHederaScheme(signer));
    const paying = wrapFetchWithPayment(
      async (input, init) => app.fetch(new Request(input as Request, init)),
      client,
    );

    const response = await paying("http://crossfare.test/v1/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(quoteBody),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.routes).toHaveLength(1);
    expect(body.payment.transactionId).toBe("0.0.9185802@1762339200.1");
    expect(facilitator.verify).toHaveBeenCalledOnce();
    expect(facilitator.settle).toHaveBeenCalledOnce();

    const payment = seen[0] as any;
    expect(payment.accepted).toMatchObject({ amount: "10000", asset: "0.0.429274", payTo: "0.0.999" });
    expect(payment.payload.transaction).toEqual(expect.any(String));
  });

  it("pays from the demo account, inside the same process", async () => {
    const { app, facilitator } = await setup();
    const paidPost = createPaidPost({
      fetch: (request) => app.fetch(request),
      accountId: PAYER,
      privateKey: PrivateKey.generateECDSA().toStringDer(),
    });
    const result = await paidPost("/v1/quote", quoteBody);
    expect(result.status).toBe(200);
    expect((result.body as any).routes).toHaveLength(1);
    expect(facilitator.settle).toHaveBeenCalledOnce();
  });

  it("passes a failed request through without settling", async () => {
    const { app, facilitator } = await setup();
    const paidPost = createPaidPost({
      fetch: (request) => app.fetch(request),
      accountId: PAYER,
      privateKey: PrivateKey.generateECDSA().toStringDer(),
    });
    const result = await paidPost("/v1/quote", { ...quoteBody, to: { asset: "base:doge", address: AGENT } });
    expect(result.status).toBe(422);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });
});
