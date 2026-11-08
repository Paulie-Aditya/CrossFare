import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetUnlistedAssets, type QuoteRequest, type Route, type Venue } from "@crossfare/core";
import { createApp, type AppDeps } from "./app.ts";
import type { AuditLog, PaymentGateway } from "./payment.ts";
import type { QuotePublisher } from "./publisher.ts";
import { createStore, type Store } from "./store.ts";
import { createTokenLookup, type ReadToken } from "./token-lookup.ts";

const AGENT = "0xC9bebBA9f481b12cE6f3EA54c4B182c9636ec421";
const PASTED = "0x9999999999999999999999999999999999999999";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NOW = new Date("2026-11-09T10:00:00.000Z");
const PAID = { "payment-signature": "signed-payment" };

let store: Store;
let readToken: ReturnType<typeof vi.fn<ReadToken>>;
let venue: Venue & { quote: ReturnType<typeof vi.fn> };

beforeEach(() => {
  store = createStore(":memory:");
  readToken = vi.fn<ReadToken>(async (chainId) => (chainId === 8453 ? { symbol: "PEPE", name: "Pepe", decimals: 18 } : null));
  venue = {
    name: "uniswap",
    quote: vi.fn(async (request: QuoteRequest): Promise<Route[]> => [
      {
        venue: "uniswap",
        from: request.from.asset,
        to: request.to.asset,
        amountIn: "2000000",
        amountOut: "5000000000000000000",
        minAmountOut: "4900000000000000000",
        fees: {},
        etaSeconds: 30,
        validUntil: "2026-11-09T10:01:00.000Z",
        venueData: null,
      },
    ]),
    prepare: vi.fn(),
  } as never;
});

afterEach(() => forgetUnlistedAssets());

function app(overrides: Partial<AppDeps> = {}) {
  let counter = 0;
  return createApp({
    venues: [venue],
    store,
    gateway: {
      paymentRequired: vi.fn(async () => ({ body: { x402Version: 2 }, headers: {} })),
      verify: vi.fn(async () => ({ valid: true, payer: "0.0.51234" })),
      settle: vi.fn(async () => ({ success: true, transactionId: "0.0.1@1.1", payer: "0.0.51234" })),
    } as unknown as PaymentGateway,
    audit: { log: async () => {} } as AuditLog,
    publisher: {
      publishQuote: vi.fn(async () => "0xentity"),
      updateQuote: vi.fn(async () => {}),
      quotesByPayer: vi.fn(async () => []),
      recentQuotes: vi.fn(async () => []),
    } as unknown as QuotePublisher,
    payTo: "0.0.999",
    now: () => NOW,
    newId: (prefix) => `${prefix}_${++counter}`,
    publishTimeoutMs: 50,
    onError: () => {},
    tokens: createTokenLookup({ readToken, store, now: () => NOW }),
    ...overrides,
  });
}

const quote = (target: ReturnType<typeof app>, from: string, to: string) =>
  target.request("/v1/quote", {
    method: "POST",
    headers: { "content-type": "application/json", ...PAID },
    body: JSON.stringify({
      from: { asset: from, amount: "2", address: AGENT },
      to: { asset: to, address: AGENT },
      refundAddress: AGENT,
    }),
  });

describe("GET /v1/tokens/:address", () => {
  it("finds a listed token by contract, marked verified, for free", async () => {
    const response = await app().request(`/v1/tokens/${BASE_USDC.toLowerCase()}?chain=base`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tokens: [expect.objectContaining({ id: "base:usdc", symbol: "usdc", decimals: 6, verified: true, venues: ["uniswap", "swapkit"] })],
    });
    expect(readToken).not.toHaveBeenCalled();
  });

  it("reads an unlisted token from the chain and marks it unverified", async () => {
    const body = (await (await app().request(`/v1/tokens/${PASTED}?chain=base`)).json()) as any;
    expect(body.tokens).toEqual([
      expect.objectContaining({ id: `base:pepe-${PASTED}`, chain: "base", symbol: "PEPE", name: "Pepe", evm: true, verified: false, venues: ["uniswap"] }),
    ]);
  });

  it("searches every Uniswap chain when none is given", async () => {
    const body = (await (await app().request(`/v1/tokens/${PASTED}`)).json()) as any;
    expect(body.tokens.map((token: { chain: string }) => token.chain)).toEqual(["base"]);
    expect(readToken.mock.calls.length).toBeGreaterThan(10);
  });

  it("refuses a malformed address or a chain Uniswap doesn't trade on", async () => {
    expect((await app().request("/v1/tokens/0x123")).status).toBe(400);
    expect((await app().request(`/v1/tokens/${PASTED}?chain=btc`)).status).toBe(400);
  });

  it("answers an empty list when nothing is there", async () => {
    readToken.mockResolvedValue(null);
    expect(await (await app().request(`/v1/tokens/${PASTED}?chain=base`)).json()).toEqual({ tokens: [] });
  });
});

describe("quoting a token by contract", () => {
  it("accepts chain:contract for a listed token and quotes it under its own ID", async () => {
    const response = await quote(app(), `base:${BASE_USDC}`, "base:eth");
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body).toMatchObject({ from: "base:usdc", to: "base:eth" });
    expect(body).not.toHaveProperty("warnings");
    expect(venue.quote.mock.calls[0]![0].from.asset).toBe("base:usdc");
  });

  it("looks up an unlisted token and warns that it's on no token list", async () => {
    const response = await quote(app(), "base:usdc", `base:${PASTED}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.to).toBe(`base:pepe-${PASTED}`);
    expect(body.warnings).toEqual([{ code: "unlisted_token", asset: `base:pepe-${PASTED}` }]);
  });

  it("answers 422 for a contract that isn't a token, before asking a venue", async () => {
    readToken.mockResolvedValue(null);
    const response = await quote(app(), "base:usdc", `base:${PASTED}`);
    expect(response.status).toBe(422);
    expect(venue.quote).not.toHaveBeenCalled();
  });
});
