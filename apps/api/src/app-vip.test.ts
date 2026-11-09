import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Route, Venue } from "@crossfare/core";
import { createApp, type AppDeps } from "./app.ts";
import type { AuditLog, PaymentGateway } from "./payment.ts";
import type { QuotePublisher } from "./publisher.ts";
import { createStore, type Store, type VipScope } from "./store.ts";
import { generateVipKey, hashVipKey, signVipRequest } from "./vip.ts";

const AGENT = "0xC9bebBA9f481b12cE6f3EA54c4B182c9636ec421";
const NOW = new Date("2026-11-08T10:00:00.000Z");

const quoteBody = {
  from: { asset: "base:usdc", amount: "2", address: AGENT },
  to: { asset: "base:eth", address: AGENT },
  refundAddress: AGENT,
};

function route(): Route {
  return {
    venue: "uniswap",
    from: "base:usdc",
    to: "base:eth",
    amountIn: "2000000",
    amountOut: "1000000",
    minAmountOut: "1000000",
    fees: { networkUsd: "0.01" },
    etaSeconds: 30,
    validUntil: "2026-11-08T10:01:00.000Z",
    venueData: null,
  };
}

let store: Store;
let gateway: { [K in keyof PaymentGateway]: ReturnType<typeof vi.fn> };
let publisher: { [K in keyof QuotePublisher]: ReturnType<typeof vi.fn> };
let venue: Venue & { quote: ReturnType<typeof vi.fn>; prepare: ReturnType<typeof vi.fn> };

beforeEach(() => {
  store = createStore(":memory:");
  gateway = {
    paymentRequired: vi.fn(async () => ({ body: { x402Version: 2 }, headers: {} })),
    verify: vi.fn(async () => ({ valid: true, payer: "0.0.51234" })),
    settle: vi.fn(async () => ({ success: true, transactionId: "0.0.1@1.1", payer: "0.0.51234" })),
  };
  publisher = {
    publishQuote: vi.fn(async (quote: { quoteId: string }) => `0xentity-${quote.quoteId}`),
    updateQuote: vi.fn(async () => {}),
    quotesByPayer: vi.fn(async () => []),
    recentQuotes: vi.fn(async () => []),
  };
  venue = {
    name: "uniswap",
    quote: vi.fn(async () => [route()]),
    prepare: vi.fn(async () => ({ transactions: [{ kind: "swap", chainId: 8453, to: "0xrouter", data: "0x", value: "0x0" }] })),
  } as never;
});

function app(overrides: Partial<AppDeps> = {}) {
  let counter = 0;
  return createApp({
    venues: [venue],
    store,
    gateway: gateway as unknown as PaymentGateway,
    audit: { log: async () => {} } as AuditLog,
    publisher: publisher as unknown as QuotePublisher,
    payTo: "0.0.999",
    now: () => NOW,
    newId: (prefix) => `${prefix}_${++counter}`,
    publishTimeoutMs: 50,
    onError: () => {},
    ...overrides,
  });
}

function issueKey(scopes: VipScope[] = ["quote", "swap"], ratePerMinute: number | null = null, feeBps: number | null = null) {
  const key = generateVipKey();
  store.saveVipKey({ id: `vk_${scopes.join("_")}`, label: "partner", keyHash: hashVipKey(key), scopes, ratePerMinute, monthlyQuota: null, feeBps, createdAt: NOW.toISOString() });
  return key;
}

function vipHeaders(key: string, path: string, body: string) {
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  return {
    authorization: `Bearer ${key}`,
    "x-crossfare-timestamp": timestamp,
    "x-crossfare-sign": signVipRequest(key, { timestamp, method: "POST", path, body }),
  };
}

function post(target: ReturnType<typeof app>, path: string, payload: unknown, headers: (body: string) => Record<string, string>) {
  const body = JSON.stringify(payload);
  return target.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers(body) }, body });
}

describe("VIP quotes", () => {
  it("skip x402: no 402, no verify, no settle, no payment in the answer", async () => {
    const key = issueKey();
    const response = await post(app(), "/v1/quote", quoteBody, (body) => vipHeaders(key, "/v1/quote", body));
    expect(response.status).toBe(200);
    const answer = (await response.json()) as any;
    expect(answer.routes).toHaveLength(1);
    expect(answer.payment).toBeUndefined();
    expect(gateway.verify).not.toHaveBeenCalled();
    expect(gateway.settle).not.toHaveBeenCalled();
  });

  it("publish the key's label as the payer on Arkiv, never the key", async () => {
    const key = issueKey();
    await post(app(), "/v1/quote", quoteBody, (body) => vipHeaders(key, "/v1/quote", body));
    expect(publisher.publishQuote.mock.calls[0]![0]).toMatchObject({ payer: "vip:partner" });
    expect(JSON.stringify(publisher.publishQuote.mock.calls)).not.toContain(key);
    expect(JSON.stringify(publisher.publishQuote.mock.calls)).not.toContain(hashVipKey(key));
  });

  it("are metered when they succeed", async () => {
    const key = issueKey();
    await post(app(), "/v1/quote", quoteBody, (body) => vipHeaders(key, "/v1/quote", body));
    expect(store.vipUsageSummary("2026-11-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z")).toEqual([
      { keyId: "vk_quote_swap", label: "partner", endpoint: "POST /v1/quote", calls: 1 },
    ]);
  });

  it("are not metered when no route exists", async () => {
    const key = issueKey();
    venue.quote.mockResolvedValue([]);
    const response = await post(app(), "/v1/quote", quoteBody, (body) => vipHeaders(key, "/v1/quote", body));
    expect(response.status).toBe(422);
    expect(store.countVipUsage("vk_quote_swap", "2026-11-01T00:00:00.000Z")).toBe(0);
  });

  it("answer 402 with the reason for a bad key, before asking any venue", async () => {
    issueKey();
    const response = await post(app(), "/v1/quote", quoteBody, (body) => vipHeaders(generateVipKey(), "/v1/quote", body));
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ x402Version: 2, error: "invalid_vip_key" });
    expect(venue.quote).not.toHaveBeenCalled();
  });

  it("answer 429 past the key's rate limit, before asking any venue", async () => {
    const key = issueKey(["quote"], 1);
    const target = app();
    await post(target, "/v1/quote", quoteBody, (body) => vipHeaders(key, "/v1/quote", body));
    venue.quote.mockClear();
    const response = await post(target, "/v1/quote", quoteBody, (body) => vipHeaders(key, "/v1/quote", body));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "vip_rate_limited" });
    expect(venue.quote).not.toHaveBeenCalled();
  });

  it("leave x402 callers exactly as they were", async () => {
    const response = await post(app(), "/v1/quote", quoteBody, () => ({ "payment-signature": "signed-payment" }));
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).payment).toBeDefined();
    expect(gateway.settle).toHaveBeenCalledTimes(1);
  });
});

describe("the fee on a caller's swaps", () => {
  const askedFee = () => (venue.quote.mock.calls[0]![0] as { feeBps?: number }).feeBps;

  it("is the key's own fee for a VIP caller", async () => {
    const key = issueKey(["quote"], null, 100);
    await post(app({ defaultFeeBps: 25 }), "/v1/quote", quoteBody, (body) => vipHeaders(key, "/v1/quote", body));
    expect(askedFee()).toBe(100);
  });

  it("can be zero for a VIP caller, whatever the default", async () => {
    const key = issueKey(["quote"], null, 0);
    await post(app({ defaultFeeBps: 25 }), "/v1/quote", quoteBody, (body) => vipHeaders(key, "/v1/quote", body));
    expect(askedFee() ?? 0).toBe(0);
  });

  it("is the default for a VIP key without its own", async () => {
    const key = issueKey(["quote"]);
    await post(app({ defaultFeeBps: 25 }), "/v1/quote", quoteBody, (body) => vipHeaders(key, "/v1/quote", body));
    expect(askedFee()).toBe(25);
  });

  it("is the default for an x402 caller, and none without one", async () => {
    await post(app({ defaultFeeBps: 25 }), "/v1/quote", quoteBody, () => ({ "payment-signature": "signed-payment" }));
    expect(askedFee()).toBe(25);
    venue.quote.mockClear();
    // Each payment pays once, so the second call needs its own.
    await post(app(), "/v1/quote", quoteBody, () => ({ "payment-signature": "another-payment" }));
    expect(askedFee() ?? 0).toBe(0);
  });

  it("can't be set by the caller", async () => {
    await post(app({ defaultFeeBps: 25 }), "/v1/quote", { ...quoteBody, feeBps: 0 }, () => ({ "payment-signature": "signed-payment" }));
    expect(askedFee()).toBe(25);
  });
});

describe("VIP swaps when a price is set", () => {
  async function quoted(key: string) {
    const target = app({ swapPriceUsd: "0.05" });
    const answer = (await (await post(target, "/v1/quote", quoteBody, (body) => vipHeaders(key, "/v1/quote", body))).json()) as any;
    return { target, payload: { quoteId: answer.routes[0].quoteId, swapToken: answer.swapToken } };
  }

  it("skip the swap payment with the swap scope, and are metered", async () => {
    const key = issueKey(["quote", "swap"]);
    const { target, payload } = await quoted(key);
    const response = await post(target, "/v1/swap", payload, (body) => vipHeaders(key, "/v1/swap", body));
    expect(response.status).toBe(200);
    expect(gateway.settle).not.toHaveBeenCalled();
    expect(store.vipUsageSummary("2026-11-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z")).toContainEqual(
      expect.objectContaining({ endpoint: "POST /v1/swap", calls: 1 }),
    );
  });

  it("answer 403 without the swap scope", async () => {
    const key = issueKey(["quote"]);
    const { target, payload } = await quoted(key);
    const response = await post(target, "/v1/swap", payload, (body) => vipHeaders(key, "/v1/swap", body));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "vip_scope_missing" });
    expect(venue.prepare).not.toHaveBeenCalled();
  });
});
