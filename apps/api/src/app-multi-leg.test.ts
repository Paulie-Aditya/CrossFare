import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getAsset, registerAssets, toBaseUnits, type Asset, type QuoteRequest, type Route, type Venue } from "@crossfare/core";
import { createApp, type AppDeps } from "./app.ts";
import type { AuditLog, PaymentGateway } from "./payment.ts";
import type { QuotePublisher } from "./publisher.ts";
import { createStore, type Store } from "./store.ts";

const AGENT = "0xC9bebBA9f481b12cE6f3EA54c4B182c9636ec421";
const NOW = new Date("2026-11-11T10:00:00.000Z");
const PAID = { "payment-signature": "signed-payment" };

const PEPE: Asset = {
  id: "eth:pepe",
  chain: "eth",
  symbol: "PEPE",
  decimals: 18,
  uniswap: { chainId: 1, address: "0x6982508145454Ce325dDbE47a25d4ec3d2311933" },
  swapkitChain: "1",
};
const BNB: Asset = { id: "bsc:bnb", chain: "bsc", symbol: "BNB", decimals: 18, swapkit: "BSC.BNB", swapkitChain: "56" };

beforeAll(() => registerAssets([PEPE, BNB]));

type FakeVenue = Venue & {
  quote: ReturnType<typeof vi.fn>;
  prepare: ReturnType<typeof vi.fn>;
  track: ReturnType<typeof vi.fn>;
  rates: Record<string, number>;
};

/** Serves the pairs it has a rate for, keeping 1% back for slippage. Rates can change between calls. */
function fakeVenue(name: string, rates: Record<string, number>, extra: Partial<Route> = {}): FakeVenue {
  const venue = {
    name,
    rates,
    serves: (from: Asset, to: Asset) => Object.keys(venue.rates).some((pair) => pair.startsWith(`${from.id}>`)) && Object.keys(venue.rates).some((pair) => pair.endsWith(`>${to.id}`)),
    quote: vi.fn(async (req: QuoteRequest): Promise<Route[]> => {
      const rate = venue.rates[`${req.from.asset}>${req.to.asset}`];
      if (rate === undefined) return [];
      const from = getAsset(req.from.asset);
      const to = getAsset(req.to.asset);
      const amountIn = toBaseUnits(req.from.amount, from.decimals);
      const amountOut = (amountIn * BigInt(Math.round(rate * 1e6)) * 10n ** BigInt(to.decimals)) / (10n ** 6n * 10n ** BigInt(from.decimals));
      return [{
        venue: name,
        from: from.id,
        to: to.id,
        amountIn: amountIn.toString(),
        amountOut: amountOut.toString(),
        minAmountOut: ((amountOut * 99n) / 100n).toString(),
        fees: { networkUsd: "0.5" },
        etaSeconds: 60,
        validUntil: "2026-11-11T10:01:00.000Z",
        venueData: { secret: `${name}-state` },
        ...extra,
      }];
    }),
    prepare: vi.fn(async (route: Route) => ({
      transactions: [{ kind: "swap", chainId: route.from.startsWith("bsc") ? 56 : 1, to: `0x${name}`, data: "0xswap", value: "0x0" }],
    })),
    track: vi.fn(async () => ({ status: "confirming" })),
  };
  return venue as unknown as FakeVenue;
}

const gateway: PaymentGateway = {
  paymentRequired: async () => ({ body: { x402Version: 2 }, headers: {} }),
  verify: async () => ({ valid: true, payer: "0.0.51234" }),
  settle: async () => ({ success: true, transactionId: "0.0.1@1.1", payer: "0.0.51234" }),
};

let store: Store;
let publisher: { [K in keyof QuotePublisher]: ReturnType<typeof vi.fn> };
let currentTime: Date;

beforeEach(() => {
  store = createStore(":memory:");
  currentTime = NOW;
  publisher = {
    publishQuote: vi.fn(async (quote: { quoteId: string }) => `0xentity-${quote.quoteId}`),
    updateQuote: vi.fn(async () => {}),
    quotesByPayer: vi.fn(async () => []),
    recentQuotes: vi.fn(async () => []),
  };
});

function app(venues: Venue[], overrides: Partial<AppDeps> = {}) {
  let counter = 0;
  return createApp({
    venues,
    store,
    gateway,
    audit: { log: async () => {} } as AuditLog,
    publisher: publisher as unknown as QuotePublisher,
    payTo: "0.0.999",
    now: () => currentTime,
    newId: (prefix) => `${prefix}_${++counter}`,
    publishTimeoutMs: 50,
    trackIntervalMs: 0,
    onError: () => {},
    ...overrides,
  });
}

const quoteBody = (extra: Record<string, unknown> = { multiLeg: true }) => ({
  from: { asset: "bsc:bnb", amount: "1", address: AGENT },
  to: { asset: "eth:pepe", address: AGENT },
  slippageBps: 100,
  refundAddress: AGENT,
  ...extra,
});

const postQuote = (target: ReturnType<typeof app>, body: unknown = quoteBody()) =>
  target.request("/v1/quote", { method: "POST", headers: { "content-type": "application/json", ...PAID }, body: JSON.stringify(body) });

// 1 BNB buys 0.2 ETH through SwapKit; 1 ETH buys 1,000,000 PEPE on Uniswap.
const venues = () => ({
  swapkit: fakeVenue("swapkit", { "bsc:bnb>eth:eth": 0.2 }, { provider: "chainflip" }),
  uniswap: fakeVenue("uniswap", { "eth:eth>eth:pepe": 1_000_000 }),
});

describe("POST /v1/quote with multiLeg", () => {
  it("offers a two-leg route when no venue serves the pair", async () => {
    const { swapkit, uniswap } = venues();
    const response = await postQuote(app([swapkit, uniswap]));
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.routes).toHaveLength(1);
    expect(body.routes[0]).toMatchObject({
      venue: "swapkit+uniswap",
      amountOut: "200000",
      minAmountOut: "196020",
      etaSeconds: 120,
      depositable: false,
      legs: [
        { venue: "swapkit", provider: "chainflip", from: "bsc:bnb", to: "eth:eth", amountIn: "1", amountOut: "0.2", minAmountOut: "0.198" },
        { venue: "uniswap", from: "eth:eth", to: "eth:pepe", amountIn: "0.2", amountOut: "200000", minAmountOut: "198000" },
      ],
    });
  });

  it("never returns or publishes any leg's venue state", async () => {
    const { swapkit, uniswap } = venues();
    const body = await (await postQuote(app([swapkit, uniswap]))).text();
    expect(body).not.toContain("-state");
    expect(JSON.stringify(publisher.publishQuote.mock.calls)).not.toContain("-state");
  });

  it("publishes the route with its legs under the combined venue", async () => {
    const { swapkit, uniswap } = venues();
    await postQuote(app([swapkit, uniswap]));
    expect(publisher.publishQuote.mock.calls[0]![0]).toMatchObject({
      venue: "swapkit+uniswap",
      fromAsset: "bsc:bnb",
      toAsset: "eth:pepe",
      payload: { legs: [{ venue: "swapkit" }, { venue: "uniswap" }] },
    });
  });

  it("doesn't look for two legs when a direct route exists", async () => {
    const { swapkit, uniswap } = venues();
    swapkit.rates["bsc:bnb>eth:pepe"] = 190_000;
    const body = (await (await postQuote(app([swapkit, uniswap]))).json()) as any;
    expect(body.routes.map((route: { venue: string }) => route.venue)).toEqual(["swapkit"]);
    // Asked once, for the direct pair; never for a leg.
    expect(uniswap.quote).toHaveBeenCalledTimes(1);
  });

  it("answers no_route without it, so a caller never gets a route that needs a second signature unasked", async () => {
    const { swapkit, uniswap } = venues();
    const response = await postQuote(app([swapkit, uniswap]), quoteBody({}));
    expect(response.status).toBe(422);
    expect(uniswap.quote).toHaveBeenCalledTimes(1);
  });

  it("answers no_route when no hub connects the pair either", async () => {
    const response = await postQuote(app([fakeVenue("uniswap", { "eth:eth>eth:pepe": 1 })]));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "no_route" });
  });
});

describe("executing a two-leg route", () => {
  async function quoted(overrides: Partial<AppDeps> = {}) {
    const { swapkit, uniswap } = venues();
    const target = app([swapkit, uniswap], overrides);
    const body = (await (await postQuote(target)).json()) as any;
    swapkit.quote.mockClear();
    uniswap.quote.mockClear();
    publisher.updateQuote.mockClear();
    return { target, swapkit, uniswap, quoteId: body.routes[0].quoteId as string, swapToken: body.swapToken as string };
  }

  const post = (target: ReturnType<typeof app>, path: string, payload: unknown) =>
    target.request(path, { method: "POST", body: JSON.stringify(payload) });

  async function started(overrides: Partial<AppDeps> = {}) {
    const setup = await quoted(overrides);
    const swap = (await (await post(setup.target, "/v1/swap", { quoteId: setup.quoteId, swapToken: setup.swapToken })).json()) as any;
    return { ...setup, swapId: swap.swapId as string, swap };
  }

  /** Leg 1 lands: 0.199 ETH reaches the caller. */
  async function firstLegDone(overrides: Partial<AppDeps> = {}) {
    const setup = await started(overrides);
    setup.swapkit.track.mockResolvedValue({ status: "completed", amountReceived: "0.199", txHashes: ["0xleg1"] });
    const status = (await (await setup.target.request(`/v1/swaps/${setup.swapId}`)).json()) as any;
    return { ...setup, status };
  }

  const next = (target: ReturnType<typeof app>, swapId: string, payload: Record<string, unknown>) => post(target, `/v1/swaps/${swapId}/next`, payload);

  it("prepares only the first leg, re-quoted on its own venue", async () => {
    const { swap, swapkit, uniswap } = await started();
    expect(swap).toMatchObject({ venue: "swapkit", provider: "chainflip", leg: 1, legCount: 2, transactions: [{ to: "0xswapkit" }] });
    expect(swapkit.quote.mock.calls[0]![0]).toMatchObject({ from: { asset: "bsc:bnb", amount: "1" }, to: { asset: "eth:eth", address: AGENT } });
    expect(uniswap.quote).not.toHaveBeenCalled();
    expect(uniswap.prepare).not.toHaveBeenCalled();
  });

  it("answers 409 with a fresh two-leg route when the first leg's price moved", async () => {
    const { target, swapkit, quoteId, swapToken } = await quoted();
    swapkit.rates["bsc:bnb>eth:eth"] = 0.19;
    const response = await post(target, "/v1/swap", { quoteId, swapToken });
    expect(response.status).toBe(409);
    const body = (await response.json()) as any;
    expect(body.error).toBe("price_moved");
    expect(body.freshQuote).toMatchObject({ venue: "swapkit+uniswap", amountOut: "190000", legs: [{ amountOut: "0.19" }, { amountIn: "0.19" }] });
    expect(swapkit.prepare).not.toHaveBeenCalled();
  });

  it("tracks the first leg, then waits for the caller with what it delivered", async () => {
    const { status, swapkit } = await firstLegDone();
    expect(swapkit.track.mock.calls[0]![0].request).toMatchObject({ to: { asset: "eth:eth", address: AGENT } });
    expect(status).toMatchObject({
      status: "awaiting_next_leg",
      leg: 1,
      legCount: 2,
      amountReceived: null,
      legs: [{ venue: "swapkit", provider: "chainflip", status: "completed", amountReceived: "0.199", txHashes: ["0xleg1"] }],
    });
    expect(publisher.updateQuote).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: "completed" }));
  });

  it("ends the swap when the first leg is refunded", async () => {
    const { target, swapId, swapToken, swapkit } = await started();
    swapkit.track.mockResolvedValue({ status: "refunded" });
    const status = (await (await target.request(`/v1/swaps/${swapId}`)).json()) as any;
    expect(status.status).toBe("refunded");
    const response = await next(target, swapId, { swapToken });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "leg_not_ready", status: "refunded" });
  });

  it("refuses the next leg before the first has delivered", async () => {
    const { target, swapId, swapToken } = await started();
    const response = await next(target, swapId, { swapToken });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "leg_not_ready", status: "awaiting_deposit" });
  });

  it("refuses the next leg without the quote's swap token", async () => {
    const { target, swapId } = await firstLegDone();
    expect((await next(target, swapId, { swapToken: "wrong" })).status).toBe(403);
  });

  it("prepares the second leg at what the first delivered", async () => {
    const { target, swapId, swapToken, uniswap } = await firstLegDone();
    const response = await next(target, swapId, { swapToken });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ swapId, venue: "uniswap", leg: 2, legCount: 2, transactions: [{ to: "0xuniswap" }] });
    expect(uniswap.quote.mock.calls[0]![0]).toMatchObject({ from: { asset: "eth:eth", amount: "0.199", address: AGENT }, to: { asset: "eth:pepe" } });
    const status = (await (await target.request(`/v1/swaps/${swapId}`)).json()) as any;
    // Tracking has moved to the second leg's venue.
    expect(status).toMatchObject({ status: "confirming", leg: 2, txHashes: [] });
  });

  it("returns the same second leg when asked twice", async () => {
    const { target, swapId, swapToken, uniswap } = await firstLegDone();
    const first = await (await next(target, swapId, { swapToken })).json();
    const second = await (await next(target, swapId, { swapToken })).json();
    expect(second).toEqual(first);
    expect(uniswap.prepare).toHaveBeenCalledTimes(1);
  });

  it("lets the caller keep some of the hub back, for gas, but not spend more than arrived", async () => {
    const { target, swapId, swapToken, uniswap } = await firstLegDone();
    expect((await next(target, swapId, { swapToken, amount: "0.2" })).status).toBe(400);
    expect((await next(target, swapId, { swapToken, amount: "0.19" })).status).toBe(200);
    expect(uniswap.quote.mock.calls[0]![0].from.amount).toBe("0.19");
  });

  it("refuses a second leg whose minimum falls below the route's guarantee, unless the caller lowers it", async () => {
    const { target, swapId, swapToken, uniswap } = await firstLegDone();
    uniswap.rates["eth:eth>eth:pepe"] = 900_000;
    const refused = await next(target, swapId, { swapToken });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "price_moved", leg: { amountOut: "179100", minAmountOut: "177309" } });
    expect(uniswap.prepare).not.toHaveBeenCalled();
    expect((await next(target, swapId, { swapToken, minAmountOut: "177309" })).status).toBe(200);
  });

  it("finishes when the second leg delivers, and records the outcome once on Arkiv", async () => {
    const { target, swapId, swapToken, uniswap, quoteId } = await firstLegDone();
    await next(target, swapId, { swapToken });
    uniswap.track.mockResolvedValue({ status: "completed", amountReceived: "198000", txHashes: ["0xleg2"] });
    const status = (await (await target.request(`/v1/swaps/${swapId}`)).json()) as any;
    expect(uniswap.track.mock.calls[0]![0].request).toMatchObject({ from: { asset: "eth:eth", amount: "0.199" } });
    expect(status).toMatchObject({ status: "completed", leg: 2, amountReceived: "198000", legs: [{ venue: "swapkit" }, { venue: "uniswap", status: "completed" }] });
    expect(publisher.updateQuote).toHaveBeenCalledWith(`0xentity-${quoteId}`, expect.objectContaining({ status: "completed", amountReceived: "198000" }));
  });
});
