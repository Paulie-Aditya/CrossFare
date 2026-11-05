import { beforeEach, describe, expect, it, vi } from "vitest";
import { VenueError, type Route, type Venue } from "@crossfare/core";
import { createApp, type AppDeps } from "./app.ts";
import type { AuditLog, PaymentGateway } from "./payment.ts";
import type { QuotePublisher } from "./publisher.ts";
import { createStore, type Store } from "./store.ts";

const AGENT = "0xC9bebBA9f481b12cE6f3EA54c4B182c9636ec421";
const NOW = new Date("2026-11-06T10:00:00.000Z");
const PAID = { "payment-signature": "signed-payment" };

function route(venue: string, minAmountOut: string, overrides: Partial<Route> = {}): Route {
  return {
    venue,
    from: "base:usdc",
    to: "base:eth",
    amountIn: "2000000",
    amountOut: minAmountOut,
    minAmountOut,
    fees: { networkUsd: "0.01" },
    etaSeconds: 30,
    validUntil: "2026-11-06T10:01:00.000Z",
    venueData: { secret: "venue-state" },
    ...overrides,
  };
}

function fakeVenue(name: string, routes: Route[] = []): Venue & { quote: ReturnType<typeof vi.fn>; prepare: ReturnType<typeof vi.fn> } {
  return {
    name,
    quote: vi.fn(async () => routes),
    prepare: vi.fn(async () => ({
      transactions: [{ kind: "swap", chainId: 8453, to: "0xrouter", data: "0xswap", value: "0x0" }],
    })),
  } as never;
}

const gateway: PaymentGateway = {
  paymentRequired: async () => ({ body: { x402Version: 2 }, headers: {} }),
  verify: async () => ({ valid: true, payer: "0.0.51234" }),
  settle: async () => ({ success: true, transactionId: "0.0.1@1.1", payer: "0.0.51234" }),
};

let store: Store;
let publisher: { [K in keyof QuotePublisher]: ReturnType<typeof vi.fn> };
let settle: ReturnType<typeof vi.fn>;
let currentTime: Date;

beforeEach(() => {
  store = createStore(":memory:");
  currentTime = NOW;
  publisher = {
    publishQuote: vi.fn(async (quote: { quoteId: string }) => `0xentity-${quote.quoteId}`),
    updateQuote: vi.fn(async () => {}),
    quotesByPayer: vi.fn(async () => [{ quoteId: "q_x" }]),
    recentQuotes: vi.fn(async () => []),
  };
  let settled = 0;
  settle = vi.fn(async () => ({
    success: true,
    transactionId: settled++ === 0 ? "0.0.1@1.1" : `0.0.1@1.${settled}`,
    payer: "0.0.51234",
  }));
});

function app(venues: Venue[], overrides: Partial<AppDeps> = {}) {
  let counter = 0;
  return createApp({
    venues,
    store,
    gateway: { ...gateway, settle } as PaymentGateway,
    audit: { log: async () => {} } as AuditLog,
    publisher: publisher as unknown as QuotePublisher,
    payTo: "0.0.999",
    now: () => currentTime,
    newId: (prefix) => `${prefix}_${++counter}`,
    publishTimeoutMs: 50,
    onError: () => {},
    ...overrides,
  });
}

function postQuote(target: ReturnType<typeof app>, body: unknown = quoteBody, headers: Record<string, string> = PAID) {
  return target.request("/v1/quote", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const quoteBody = {
  from: { asset: "base:usdc", amount: "2", address: AGENT },
  to: { asset: "base:eth", address: AGENT },
  mode: "exact_in",
  slippageBps: 50,
  refundAddress: AGENT,
};

describe("GET /.well-known/x402", () => {
  it("lists paid endpoints, prices, network, asset and chains for free", async () => {
    const response = await app([]).request("/.well-known/x402");
    expect(response.status).toBe(200);
    const body = await (response.json() as Promise<any>);
    expect(body).toMatchObject({
      network: "hedera:testnet",
      asset: "USDC",
      payTo: "0.0.999",
      endpoints: expect.arrayContaining([
        expect.objectContaining({ method: "POST", path: "/v1/quote", price: "0.01" }),
        expect.objectContaining({ method: "POST", path: "/v1/swap", price: "0" }),
      ]),
    });
    expect(body.chains).toEqual(expect.arrayContaining(["base", "btc"]));
  });
});

describe("GET /.well-known/x402 authorship", () => {
  it("names the wallet that writes Arkiv records", async () => {
    const response = await app([], { arkivWriter: "0xwriter" }).request("/.well-known/x402");
    expect(await (response.json() as Promise<any>)).toMatchObject({ arkiv: { writer: "0xwriter" } });
  });
});

describe("GET /healthz", () => {
  it("answers for the hosting platform's health check", async () => {
    const response = await app([]).request("/healthz");
    expect(response.status).toBe(200);
    expect(await (response.json() as Promise<any>)).toEqual({ ok: true });
  });
});

describe("GET /v1/assets", () => {
  it("lists assets and the venues that support each", async () => {
    const response = await app([]).request("/v1/assets");
    const { assets } = await (response.json() as Promise<any>);
    expect(assets).toEqual(
      expect.arrayContaining([
        { id: "base:usdc", chain: "base", symbol: "usdc", decimals: 6, venues: ["uniswap", "swapkit"] },
        { id: "btc:btc", chain: "btc", symbol: "btc", decimals: 8, venues: ["swapkit"] },
      ]),
    );
  });
});

describe("POST /v1/quote", () => {
  it("answers 402 without payment and asks no venue", async () => {
    const venue = fakeVenue("uniswap", [route("uniswap", "100")]);
    const response = await postQuote(app([venue]), quoteBody, {});
    expect(response.status).toBe(402);
    expect(venue.quote).not.toHaveBeenCalled();
  });

  it("rejects a malformed request before asking for payment", async () => {
    const response = await postQuote(app([]), { from: { asset: "base:usdc" } }, {});
    expect(response.status).toBe(400);
  });

  it.each([
    ["an unknown asset", { to: { asset: "base:doge", address: AGENT } }],
    ["a non-positive amount", { from: { ...quoteBody.from, amount: "0" } }],
    ["slippage over 100%", { slippageBps: 10_001 }],
  ])("rejects %s", async (_label, change) => {
    const response = await postQuote(app([]), { ...quoteBody, ...change }, {});
    expect([400, 422]).toContain(response.status);
  });

  it("returns routes from all venues, best minimum first, in human units", async () => {
    const venues = [
      fakeVenue("swapkit", [route("swapkit", "1000000000000000", { provider: "chainflip" })]),
      fakeVenue("uniswap", [route("uniswap", "2000000000000000")]),
    ];
    const response = await postQuote(app(venues));
    expect(response.status).toBe(200);
    const body = await (response.json() as Promise<any>);
    expect(body.routes.map((r: Route) => r.venue)).toEqual(["uniswap", "swapkit"]);
    expect(body.routes[0]).toMatchObject({
      venue: "uniswap",
      amountOut: "0.002",
      minAmountOut: "0.002",
      etaSeconds: 30,
    });
    expect(body.routes[1].provider).toBe("chainflip");
    expect(body.requestId).toBeTruthy();
    expect(body.payment.transactionId).toBe("0.0.1@1.1");
  });

  it("never exposes venue state to the caller", async () => {
    const response = await postQuote(app([fakeVenue("uniswap", [route("uniswap", "100")])]));
    expect(await response.text()).not.toContain("venue-state");
  });

  it("publishes each route to Arkiv and returns its entity key", async () => {
    const response = await postQuote(app([fakeVenue("uniswap", [route("uniswap", "100")])]));
    const { routes } = await (response.json() as Promise<any>);
    expect(routes[0].arkiv).toEqual({ entityKey: `0xentity-${routes[0].quoteId}`, pending: false });
    expect(publisher.publishQuote).toHaveBeenCalledTimes(1);
  });

  it("publishes no refund address, sender address or venue state", async () => {
    await postQuote(app([fakeVenue("uniswap", [route("uniswap", "100")])]));
    const published = JSON.stringify(publisher.publishQuote.mock.calls[0]![0]);
    expect(published).not.toContain(AGENT);
    expect(published).not.toContain("venue-state");
  });

  it("publishes the PRD's attributes", async () => {
    await postQuote(app([fakeVenue("uniswap", [route("uniswap", "100")])]));
    expect(publisher.publishQuote.mock.calls[0]![0]).toMatchObject({
      venue: "uniswap",
      fromAsset: "base:usdc",
      toAsset: "base:eth",
      payer: "0.0.51234",
      status: "quoted",
      createdAt: Math.floor(NOW.getTime() / 1000),
      validUntil: Math.floor(new Date("2026-11-06T10:01:00.000Z").getTime() / 1000),
    });
  });

  it("flags a slow Arkiv write as pending instead of blocking, then records the key", async () => {
    let finish!: (key: string) => void;
    publisher.publishQuote!.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const response = await postQuote(app([fakeVenue("uniswap", [route("uniswap", "100")])]));
    const { routes } = await (response.json() as Promise<any>);
    expect(routes[0].arkiv).toEqual({ entityKey: null, pending: true });
    finish("0xlate");
    await vi.waitFor(() => expect(store.getQuote(routes[0].quoteId)?.entityKey).toBe("0xlate"));
  });

  it("still answers when an Arkiv write fails", async () => {
    publisher.publishQuote!.mockRejectedValue(new Error("arkiv down"));
    const response = await postQuote(app([fakeVenue("uniswap", [route("uniswap", "100")])]));
    expect(response.status).toBe(200);
    expect((await (response.json() as Promise<any>)).routes[0].arkiv).toEqual({ entityKey: null, pending: true });
  });

  it("answers 422 and does not charge when no venue supports the pair", async () => {
    const response = await postQuote(app([fakeVenue("uniswap", [])]));
    expect(response.status).toBe(422);
    expect(settle).not.toHaveBeenCalled();
  });

  it("answers 502 and does not charge when every venue fails", async () => {
    const venue = fakeVenue("uniswap");
    venue.quote.mockRejectedValue(new VenueError("uniswap", 500, "boom"));
    const response = await postQuote(app([venue]));
    expect(response.status).toBe(502);
    expect(settle).not.toHaveBeenCalled();
  });

  it("returns the routes that exist when one venue fails", async () => {
    const broken = fakeVenue("swapkit");
    broken.quote.mockRejectedValue(new VenueError("swapkit", 500, "boom"));
    const response = await postQuote(app([broken, fakeVenue("uniswap", [route("uniswap", "100")])]));
    expect(response.status).toBe(200);
    expect((await (response.json() as Promise<any>)).routes).toHaveLength(1);
  });
});

describe("GET /v1/quotes", () => {
  it("reads a payer's quotes from Arkiv", async () => {
    const response = await app([]).request("/v1/quotes?payer=0.0.51234");
    expect(response.status).toBe(200);
    expect(await (response.json() as Promise<any>)).toEqual({ quotes: [{ quoteId: "q_x" }] });
    expect(publisher.quotesByPayer).toHaveBeenCalledWith("0.0.51234");
  });

  it("lists recent quotes when no payer is given", async () => {
    publisher.recentQuotes!.mockResolvedValue([{ quoteId: "q_recent" }]);
    const response = await app([]).request("/v1/quotes");
    expect(await (response.json() as Promise<any>)).toEqual({ quotes: [{ quoteId: "q_recent" }] });
  });

  it("answers 502 when Arkiv can't be read", async () => {
    publisher.recentQuotes!.mockRejectedValue(new Error("arkiv down"));
    expect((await app([]).request("/v1/quotes")).status).toBe(502);
  });
});

describe("address checks on POST /v1/quote", () => {
  it.each([
    ["receiving", { ...quoteBody, to: { asset: "btc:btc", address: AGENT } }],
    ["sending", { ...quoteBody, from: { ...quoteBody.from, address: "not-an-address" } }],
    ["refund", { ...quoteBody, refundAddress: "not-an-address" }],
  ])("refuses a %s address that doesn't fit its chain, before any upstream call", async (_name, body) => {
    const venue = fakeVenue("uniswap", [route("uniswap", "100")]);
    const response = await postQuote(app([venue]), body, {});
    expect(response.status).toBe(400);
    expect(await (response.json() as Promise<any>)).toMatchObject({ error: expect.stringContaining("address") });
    expect(venue.quote).not.toHaveBeenCalled();
  });

  it("accepts a receiving address different from the sender", async () => {
    const venue = fakeVenue("uniswap", [route("uniswap", "100")]);
    const other = "0x6dF69A2C97F8cFcBe5a04891ae0122942b8C24D1";
    const response = await postQuote(app([venue]), { ...quoteBody, to: { asset: "base:eth", address: other } });
    expect(response.status).toBe(200);
    expect(venue.quote.mock.calls[0]![0].to.address).toBe(other);
  });
});

describe("POST /v1/swap when a price is set", () => {
  const validRoute = (min = "1000000") => route("uniswap", min, { venueData: { quote: "original" } });

  async function setup(venue = fakeVenue("uniswap", [validRoute()])) {
    const target = app([venue], { swapPriceUsd: "0.05" });
    const quoted = await (await postQuote(target, quoteBody, { "payment-signature": "quote-payment" })).json() as any;
    return { target, venue, quoteId: quoted.routes[0].quoteId as string };
  }

  const postSwap = (target: ReturnType<typeof app>, quoteId: string, headers: Record<string, string> = { "payment-signature": "swap-payment" }) =>
    target.request("/v1/swap", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ quoteId, swapToken: store.getQuote(quoteId)?.swapToken }),
    });

  it("shows the price in discovery", async () => {
    const { target } = await setup();
    const body = await (await target.request("/.well-known/x402")).json() as any;
    expect(body.endpoints).toContainEqual(expect.objectContaining({ path: "/v1/swap", price: "0.05" }));
  });

  it("answers 402 without payment", async () => {
    const { target, quoteId, venue } = await setup();
    const response = await postSwap(target, quoteId, {});
    expect(response.status).toBe(402);
    expect(venue.prepare).not.toHaveBeenCalled();
  });

  it("requires a quote ID", async () => {
    const response = await app([]).request("/v1/swap", { method: "POST", body: "{}" });
    expect(response.status).toBe(400);
  });

  it("answers 404 for an unknown quote before asking for payment", async () => {
    const response = await postSwap(app([]), "q_missing", {});
    expect(response.status).toBe(404);
  });

  it("returns unsigned transactions and settles the payment", async () => {
    const { target, quoteId } = await setup();
    settle.mockClear();
    const response = await postSwap(target, quoteId);
    expect(response.status).toBe(200);
    const body = await (response.json() as Promise<any>);
    expect(body).toMatchObject({
      swapId: expect.any(String),
      venue: "uniswap",
      transactions: [{ kind: "swap", to: "0xrouter" }],
      payment: { transactionId: expect.any(String) },
    });
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("executes with the fresh quote, not the stored one", async () => {
    const venue = fakeVenue("uniswap", [validRoute()]);
    const { target, quoteId } = await setup(venue);
    venue.quote.mockResolvedValue([route("uniswap", "1000000", { venueData: { quote: "fresh" } })]);
    await postSwap(target, quoteId);
    expect(venue.prepare.mock.calls[0]![0].venueData).toEqual({ quote: "fresh" });
    expect(venue.prepare.mock.calls[0]![1]).toMatchObject({ from: { address: AGENT } });
  });

  it("screens the sender and recipient before preparing the swap", async () => {
    const screen = vi.fn(async () => false);
    const venue = fakeVenue("uniswap", [validRoute()]);
    const target = app([venue], { screen });
    const quoted = await (await postQuote(target, quoteBody, { "payment-signature": "q" })).json() as any;
    await postSwap(target, quoted.routes[0].quoteId);
    expect(screen).toHaveBeenCalledWith([
      { address: AGENT, asset: "base:usdc" },
      { address: AGENT, asset: "base:eth" },
    ]);
  });

  it("refuses a flagged address without settling", async () => {
    const venue = fakeVenue("uniswap", [validRoute()]);
    const target = app([venue], { screen: async () => true });
    const quoted = await (await postQuote(target, quoteBody, { "payment-signature": "q" })).json() as any;
    settle.mockClear();
    const response = await postSwap(target, quoted.routes[0].quoteId);
    expect(response.status).toBe(403);
    expect(await (response.json() as Promise<any>)).toEqual({ error: "address_flagged" });
    expect(venue.prepare).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it("refuses the swap without settling when screening is unavailable", async () => {
    const venue = fakeVenue("uniswap", [validRoute()]);
    const target = app([venue], {
      screen: async () => {
        throw new Error("screen down");
      },
    });
    const quoted = await (await postQuote(target, quoteBody, { "payment-signature": "q" })).json() as any;
    settle.mockClear();
    const response = await postSwap(target, quoted.routes[0].quoteId);
    expect(response.status).toBe(502);
    expect(venue.prepare).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it("marks the Arkiv record as executing", async () => {
    const { target, quoteId } = await setup();
    await postSwap(target, quoteId);
    expect(publisher.updateQuote).toHaveBeenCalledWith(`0xentity-${quoteId}`, { status: "executing" });
  });

  it("answers 409 with a fresh quote when expired, without settling", async () => {
    const { target, quoteId, venue } = await setup();
    settle.mockClear();
    currentTime = new Date("2026-11-06T10:02:00.000Z");
    venue.quote.mockResolvedValue([route("uniswap", "900000", { validUntil: "2026-11-06T10:03:00.000Z" })]);

    const response = await postSwap(target, quoteId);
    expect(response.status).toBe(409);
    const body = await (response.json() as Promise<any>);
    expect(body.error).toBe("quote_expired");
    expect(body.freshQuote).toMatchObject({ venue: "uniswap", arkiv: { pending: false } });
    expect(body.freshQuote.quoteId).not.toBe(quoteId);
    expect(store.getQuote(body.freshQuote.quoteId)?.requestId).toBe(store.getQuote(quoteId)?.requestId);
    expect(settle).not.toHaveBeenCalled();
    expect(venue.prepare).not.toHaveBeenCalled();
  });

  it("answers 409 with a fresh quote when price moved past slippage", async () => {
    const { target, quoteId, venue } = await setup();
    settle.mockClear();
    venue.quote.mockResolvedValue([route("uniswap", "999999")]);
    const response = await postSwap(target, quoteId);
    expect(response.status).toBe(409);
    expect(await (response.json() as Promise<any>)).toMatchObject({ error: "price_moved" });
    expect(settle).not.toHaveBeenCalled();
  });

  it("matches the fresh route by provider", async () => {
    const venue = fakeVenue("swapkit", [
      route("swapkit", "1000", { provider: "chainflip", venueData: { routeId: "cf" } }),
      route("swapkit", "2000", { provider: "thorchain", venueData: { routeId: "thor" } }),
    ]);
    const target = app([venue], { swapPriceUsd: "0.05" });
    const quoted = await (await postQuote(target, quoteBody, { "payment-signature": "q" })).json() as any;
    const chainflip = quoted.routes.find((r: { provider: string }) => r.provider === "chainflip");
    await postSwap(target, chainflip.quoteId);
    expect(venue.prepare.mock.calls[0]![0].venueData).toEqual({ routeId: "cf" });
  });

  it("offers the best current route when the original provider has gone", async () => {
    const venue = fakeVenue("swapkit", [route("swapkit", "1000", { provider: "flashnet", venueData: { routeId: "f" } })]);
    const target = app([venue], { swapPriceUsd: "0.05" });
    const quoted = await (await postQuote(target, quoteBody, { "payment-signature": "q" })).json() as any;
    settle.mockClear();
    venue.quote.mockResolvedValue([
      route("swapkit", "900", { provider: "near", venueData: { routeId: "n1" } }),
      route("swapkit", "950", { provider: "chainflip", venueData: { routeId: "c1" } }),
    ]);
    const response = await postSwap(target, quoted.routes[0].quoteId);
    expect(response.status).toBe(409);
    expect(await (response.json() as Promise<any>)).toMatchObject({ error: "route_changed", freshQuote: { provider: "chainflip" } });
    expect(settle).not.toHaveBeenCalled();
  });

  it("answers 502 without settling when no fresh route exists", async () => {
    const { target, quoteId, venue } = await setup();
    settle.mockClear();
    venue.quote.mockResolvedValue([]);
    const response = await postSwap(target, quoteId);
    expect(response.status).toBe(502);
    expect(settle).not.toHaveBeenCalled();
  });

  it("answers 502 without settling when preparation fails", async () => {
    const { target, quoteId, venue } = await setup();
    settle.mockClear();
    venue.prepare.mockRejectedValue(new VenueError("uniswap", 500, "boom"));
    const response = await postSwap(target, quoteId);
    expect(response.status).toBe(502);
    expect(settle).not.toHaveBeenCalled();
  });
});

describe("POST /v1/swap when free", () => {
  const swapRoute = () => route("uniswap", "1000000");

  async function quote(venue = fakeVenue("uniswap", [swapRoute()])) {
    const target = app([venue]);
    const body = await (await postQuote(target)).json() as any;
    settle.mockClear();
    return { target, venue, body, quoteId: body.routes[0].quoteId as string, swapToken: body.swapToken as string };
  }

  const postSwap = (target: ReturnType<typeof app>, payload: unknown) =>
    target.request("/v1/swap", { method: "POST", body: JSON.stringify(payload) });

  it("returns a private token with the quote and keeps it off Arkiv", async () => {
    const { body, swapToken } = await quote();
    expect(swapToken.length).toBeGreaterThanOrEqual(32);
    expect(JSON.stringify(body.routes)).not.toContain(swapToken);
    expect(JSON.stringify(publisher.publishQuote!.mock.calls)).not.toContain(swapToken);
  });

  it("prepares the swap with no payment", async () => {
    const { target, quoteId, swapToken, venue } = await quote();
    const response = await postSwap(target, { quoteId, swapToken });
    expect(response.status).toBe(200);
    const body = await (response.json() as Promise<any>);
    expect(body).toMatchObject({ swapId: expect.any(String), transactions: [{ kind: "swap" }] });
    expect(body.payment).toBeUndefined();
    expect(settle).not.toHaveBeenCalled();
    expect(venue.prepare).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing", undefined],
    ["wrong", "not-the-token"],
  ])("refuses a %s token, since quote IDs are public on Arkiv", async (_name, swapToken) => {
    const { target, quoteId, venue } = await quote();
    venue.quote.mockClear();
    const response = await postSwap(target, { quoteId, swapToken });
    expect(response.status).toBe(403);
    expect(await (response.json() as Promise<any>)).toEqual({ error: "invalid_swap_token" });
    expect(venue.quote).not.toHaveBeenCalled();
    expect(venue.prepare).not.toHaveBeenCalled();
  });

  it("returns the same swap when asked twice", async () => {
    const { target, quoteId, swapToken, venue } = await quote();
    const first = await (await postSwap(target, { quoteId, swapToken })).json() as any;
    const second = await (await postSwap(target, { quoteId, swapToken })).json() as any;
    expect(second).toEqual(first);
    expect(venue.prepare).toHaveBeenCalledTimes(1);
  });

  it("gives fresh quotes the same token, so the caller can use them", async () => {
    const { target, quoteId, swapToken, venue } = await quote();
    venue.quote.mockResolvedValue([route("uniswap", "999999")]);
    const moved = await (await postSwap(target, { quoteId, swapToken })).json() as any;
    expect(moved.error).toBe("price_moved");
    expect(store.getQuote(moved.freshQuote.quoteId)?.swapToken).toBe(swapToken);
    venue.quote.mockResolvedValue([route("uniswap", "999999")]);
    const response = await postSwap(target, { quoteId: moved.freshQuote.quoteId, swapToken });
    expect(response.status).toBe(200);
  });

  it("publishes a fresh quote under the original payer", async () => {
    const { target, quoteId, swapToken, venue } = await quote();
    venue.quote.mockResolvedValue([route("uniswap", "999999")]);
    await postSwap(target, { quoteId, swapToken });
    expect(publisher.publishQuote!.mock.calls.at(-1)![0].payer).toBe("0.0.51234");
  });

  it("caps fresh quotes per request, so one payment can't spam Arkiv", async () => {
    const { target, quoteId, swapToken, venue } = await quote();
    venue.quote.mockResolvedValue([route("uniswap", "999999")]);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 25; attempt++) {
      statuses.push((await postSwap(target, { quoteId, swapToken })).status);
    }
    expect(statuses.at(0)).toBe(409);
    expect(statuses.at(-1)).toBe(429);
    expect(publisher.publishQuote!.mock.calls.length).toBeLessThanOrEqual(20);
  });

  it("answers 502 when a venue throws", async () => {
    const { target, quoteId, swapToken, venue } = await quote();
    venue.quote.mockRejectedValue(new VenueError("uniswap", 500, "boom"));
    expect((await postSwap(target, { quoteId, swapToken })).status).toBe(502);
  });
});

describe("swap status", () => {
  async function swapped(track = vi.fn(async () => ({ status: "confirming" }))) {
    const venue = fakeVenue("uniswap", [route("uniswap", "100")]);
    (venue as unknown as { track: unknown }).track = track;
    const target = app([venue]);
    const quoted = await (await postQuote(target, quoteBody, { "payment-signature": "q" })).json() as any;
    const quoteId = quoted.routes[0].quoteId as string;
    const swap = await (
      await target.request("/v1/swap", {
        method: "POST",
        body: JSON.stringify({ quoteId, swapToken: quoted.swapToken }),
      })
    ).json() as any;
    publisher.updateQuote!.mockClear();
    return { target, swapId: swap.swapId as string, quoteId, track };
  }

  const submit = (target: ReturnType<typeof app>, swapId: string, hash: unknown) =>
    target.request(`/v1/swaps/${swapId}/tx`, { method: "POST", body: JSON.stringify({ hash }) });

  it("answers 404 for an unknown swap", async () => {
    expect((await app([]).request("/v1/swaps/nope")).status).toBe(404);
  });

  it("reports status, hashes and the Arkiv key without payment", async () => {
    const { target, swapId, quoteId } = await swapped();
    const response = await target.request(`/v1/swaps/${swapId}`);
    expect(response.status).toBe(200);
    expect(await (response.json() as Promise<any>)).toEqual({
      swapId,
      quoteId,
      status: "confirming",
      txHashes: [],
      amountReceived: null,
      arkiv: { entityKey: `0xentity-${quoteId}` },
    });
  });

  it("accepts a transaction hash and passes it to tracking", async () => {
    const { target, swapId, track } = await swapped();
    expect((await submit(target, swapId, "0xabc")).status).toBe(200);
    await target.request(`/v1/swaps/${swapId}`);
    expect(track.mock.lastCall![0 as never]).toMatchObject({ txHashes: ["0xabc"] });
  });

  it("does not record the same hash twice", async () => {
    const { target, swapId } = await swapped();
    await submit(target, swapId, "0xabc");
    await submit(target, swapId, "0xabc");
    expect(store.getSwap(swapId)?.txHashes).toEqual(["0xabc"]);
  });

  it("rejects a malformed hash", async () => {
    const { target, swapId } = await swapped();
    expect((await submit(target, swapId, 42)).status).toBe(400);
  });

  it("records the outcome on Arkiv when the swap finishes", async () => {
    const track = vi.fn(async () => ({ status: "completed", amountReceived: "0.5", txHashes: ["0x1", "0x2"] }));
    const { target, swapId, quoteId } = await swapped(track);
    const response = await target.request(`/v1/swaps/${swapId}`);
    expect(await (response.json() as Promise<any>)).toMatchObject({
      status: "completed",
      amountReceived: "0.5",
      txHashes: ["0x1", "0x2"],
    });
    expect(publisher.updateQuote).toHaveBeenCalledWith(`0xentity-${quoteId}`, {
      status: "completed",
      amountReceived: "0.5",
      txHashes: ["0x1", "0x2"],
    });
  });

  it("asks the venue at most once per interval, to respect its rate limit", async () => {
    const { target, swapId, track } = await swapped();
    await target.request(`/v1/swaps/${swapId}`);
    await target.request(`/v1/swaps/${swapId}`);
    expect(track).toHaveBeenCalledTimes(1);
    currentTime = new Date(NOW.getTime() + 15_000);
    await target.request(`/v1/swaps/${swapId}`);
    expect(track).toHaveBeenCalledTimes(2);
  });

  it("asks the venue straight away after a new transaction hash", async () => {
    const { target, swapId, track } = await swapped();
    await target.request(`/v1/swaps/${swapId}`);
    await submit(target, swapId, "0xabc");
    await target.request(`/v1/swaps/${swapId}`);
    expect(track).toHaveBeenCalledTimes(2);
  });

  it("stops polling the venue and rewriting Arkiv once finished", async () => {
    const track = vi.fn(async () => ({ status: "failed" }));
    const { target, swapId } = await swapped(track);
    await target.request(`/v1/swaps/${swapId}`);
    await target.request(`/v1/swaps/${swapId}`);
    expect(track).toHaveBeenCalledTimes(1);
    expect(publisher.updateQuote).toHaveBeenCalledTimes(1);
  });

  it("keeps the last status when tracking fails", async () => {
    const track = vi.fn(async () => {
      throw new Error("venue down");
    });
    const { target, swapId } = await swapped(track as never);
    const response = await target.request(`/v1/swaps/${swapId}`);
    expect(response.status).toBe(200);
    expect((await (response.json() as Promise<any>)).status).toBe("awaiting_deposit");
  });

  it("expires a deposit whose deadline passed with nothing sent", async () => {
    const track = vi.fn(async () => ({ status: "awaiting_deposit" }));
    const venue = fakeVenue("swapkit", [route("swapkit", "100")]);
    venue.prepare.mockResolvedValue({
      transactions: [],
      deposit: { asset: "btc:btc", address: "bc1q", amount: "1", expiresAt: "2026-11-06T10:10:00.000Z" },
    });
    (venue as unknown as { track: unknown }).track = track;
    const target = app([venue]);
    const quoted = await (await postQuote(target, quoteBody, { "payment-signature": "q" })).json() as any;
    const swap = await (
      await target.request("/v1/swap", {
        method: "POST",
        body: JSON.stringify({ quoteId: quoted.routes[0].quoteId, swapToken: quoted.swapToken }),
      })
    ).json() as any;
    expect(swap.deposit.address).toBe("bc1q");
    currentTime = new Date("2026-11-06T10:11:00.000Z");
    const status = await (await target.request(`/v1/swaps/${swap.swapId}`)).json() as any;
    expect(status.status).toBe("expired");
  });
});
