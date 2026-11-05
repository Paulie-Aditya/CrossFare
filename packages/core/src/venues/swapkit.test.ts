import { describe, expect, it, vi } from "vitest";
import { createSwapKitVenue, mapTrackStatus } from "./swapkit.ts";
import { VenueError, type FetchLike, type QuoteRequest } from "./types.ts";

const AGENT = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const BTC_ADDRESS = "357a3So9CbsNfBBgFYACGvxxS6tMaDoa1P";
const NOW = new Date("2026-11-06T10:00:00.000Z");

const request: QuoteRequest = {
  from: { asset: "base:eth", amount: "0.01", address: AGENT },
  to: { asset: "btc:btc", address: BTC_ADDRESS },
  mode: "exact_in",
  slippageBps: 300,
  refundAddress: AGENT,
};

// Field names follow the SwapKit v3 reference, which publishes no full example.
const apiRoute = {
  routeId: "85bb4fa2-3a65-4d22-b20b-e43d028d83e6",
  providers: ["THORCHAIN_STREAMING"],
  sellAsset: "BASE.ETH",
  buyAsset: "BTC.BTC",
  sellAmount: "0.01",
  expectedBuyAmount: "0.00031",
  expectedBuyAmountMaxSlippage: "0.0003",
  fees: [{ type: "network", amount: "0.00001", asset: "BTC.BTC" }],
  estimatedTime: { inbound: 30, swap: 6, outbound: 624, total: 660 },
};

const quoteResponse = { quoteId: "q", routes: [apiRoute] };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function fakeFetch(handlers: Record<string, () => Response>) {
  return vi.fn<FetchLike>(async (url) => {
    const path = new URL(url).pathname;
    const handler = handlers[path];
    if (!handler) throw new Error(`Unexpected call to ${path}`);
    return handler();
  });
}

function venue(fetch: FetchLike) {
  return createSwapKitVenue({ apiKey: "test-key", fetch, now: () => NOW });
}

describe("swapkit quote", () => {
  it("sends whole-unit amounts, percent slippage and the API key", async () => {
    const fetch = fakeFetch({ "/v3/quote": () => json(quoteResponse) });
    await venue(fetch).quote(request);

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.swapkit.dev/v3/quote");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("test-key");
    expect(JSON.parse(init?.body as string)).toEqual({
      sellAsset: "BASE.ETH",
      buyAsset: "BTC.BTC",
      sellAmount: "0.01",
      sourceAddress: AGENT,
      destinationAddress: BTC_ADDRESS,
      refundAddress: AGENT,
      slippage: 3,
      quoteType: "EXACT_INPUT",
    });
  });

  it("asks for buyAmount on exact_out", async () => {
    const fetch = fakeFetch({ "/v3/quote": () => json(quoteResponse) });
    await venue(fetch).quote({ ...request, mode: "exact_out" });
    const body = JSON.parse(fetch.mock.calls[0]![1]?.body as string);
    expect(body).toMatchObject({ quoteType: "EXACT_OUTPUT", buyAmount: "0.01" });
    expect(body.sellAmount).toBeUndefined();
  });

  it("normalizes each route into base units", async () => {
    const [route] = await venue(fakeFetch({ "/v3/quote": () => json(quoteResponse) })).quote(request);
    expect(route).toMatchObject({
      venue: "swapkit",
      provider: "thorchain_streaming",
      from: "base:eth",
      to: "btc:btc",
      amountIn: "10000000000000000",
      amountOut: "31000",
      minAmountOut: "30000",
      fees: { network: "0.00001 BTC.BTC" },
      etaSeconds: 660,
      validUntil: "2026-11-06T10:05:00.000Z",
      venueData: { routeId: apiRoute.routeId },
    });
  });

  it("returns every route", async () => {
    const fetch = fakeFetch({
      "/v3/quote": () => json({ routes: [apiRoute, { ...apiRoute, providers: ["CHAINFLIP"] }] }),
    });
    expect((await venue(fetch).quote(request)).map((r) => r.provider)).toEqual([
      "thorchain_streaming",
      "chainflip",
    ]);
  });

  it("returns no routes on noRoutesFound", async () => {
    const fetch = fakeFetch({ "/v3/quote": () => json({ error: "noRoutesFound" }, 404) });
    expect(await venue(fetch).quote(request)).toEqual([]);
  });

  it("returns no routes when providers decline on a 200", async () => {
    const fetch = fakeFetch({
      "/v3/quote": () =>
        json({ routes: [], providerErrors: [{ provider: "X", errorCode: "sellAssetAmountTooSmall" }] }),
    });
    expect(await venue(fetch).quote(request)).toEqual([]);
  });

  it("raises VenueError on auth failure", async () => {
    const fetch = fakeFetch({ "/v3/quote": () => json({ error: "unauthorized" }, 401) });
    await expect(venue(fetch).quote(request)).rejects.toBeInstanceOf(VenueError);
  });
});

describe("swapkit prepare", () => {
  async function quoted(fetch: FetchLike) {
    const [route] = await venue(fetch).quote(request);
    return route!;
  }

  it("returns approval then swap for an EVM source", async () => {
    const fetch = fakeFetch({
      "/v3/quote": () => json(quoteResponse),
      "/v3/swap": () =>
        json({
          swapId: "swap-1",
          approvalTx: { to: "0xtoken", from: AGENT, value: "0", data: "0xapprove" },
          tx: { to: "0xrouter", from: AGENT, gas: "0x5208", value: "3000000000000000000", data: "0xdeposit" },
        }),
    });
    const prepared = await venue(fetch).prepare(await quoted(fetch), request);
    expect(prepared.venueSwapId).toBe("swap-1");
    expect(prepared.transactions).toEqual([
      { kind: "approval", chainId: 8453, to: "0xtoken", data: "0xapprove", value: "0x0" },
      { kind: "swap", chainId: 8453, to: "0xrouter", data: "0xdeposit", value: "0x29a2241af62c0000" },
    ]);
    const body = JSON.parse(fetch.mock.calls[1]![1]?.body as string);
    expect(body).toEqual({
      routeId: apiRoute.routeId,
      sourceAddress: AGENT,
      destinationAddress: BTC_ADDRESS,
      refundAddress: AGENT,
    });
  });

  it("allows an empty-data native transfer, since deposits can carry no calldata", async () => {
    const fetch = fakeFetch({
      "/v3/quote": () => json(quoteResponse),
      "/v3/swap": () =>
        json({ swapId: "swap-1", tx: { to: "0xvault", value: "1000", data: "0x" } }),
    });
    const prepared = await venue(fetch).prepare(await quoted(fetch), request);
    expect(prepared.transactions[0]).toMatchObject({ data: "0x", value: "0x3e8" });
  });

  it("returns a deposit for a non-EVM source", async () => {
    const btcRequest: QuoteRequest = {
      ...request,
      from: { asset: "btc:btc", amount: "0.001", address: BTC_ADDRESS },
      to: { asset: "base:eth", address: AGENT },
    };
    const fetch = fakeFetch({
      "/v3/quote": () => json(quoteResponse),
      "/v3/swap": () =>
        json({
          swapId: "swap-2",
          tx: "cHNidP8=",
          sellAmount: "0.001",
          targetAddress: "bc1qvault",
          memo: "=:BASE.ETH:0xagent",
          expiration: "1793980000",
        }),
    });
    const [route] = await venue(fetch).quote(btcRequest);
    const prepared = await venue(fetch).prepare(route!, btcRequest);
    expect(prepared.transactions).toEqual([]);
    expect(prepared.deposit).toEqual({
      asset: "btc:btc",
      address: "bc1qvault",
      memo: "=:BASE.ETH:0xagent",
      amount: "0.001",
      expiresAt: new Date(1793980000 * 1000).toISOString(),
    });
  });

  it("prefers the real deposit-channel deadline when present", async () => {
    const btcRequest: QuoteRequest = {
      ...request,
      from: { asset: "btc:btc", amount: "0.001", address: BTC_ADDRESS },
      to: { asset: "base:eth", address: AGENT },
    };
    const fetch = fakeFetch({
      "/v3/quote": () => json(quoteResponse),
      "/v3/swap": () =>
        json({
          swapId: "swap-2",
          sellAmount: "0.001",
          inboundAddress: "bc1qchannel",
          expiration: "1793980000",
          meta: { depositChannelExpiration: 1793970000 },
        }),
    });
    const [route] = await venue(fetch).quote(btcRequest);
    const prepared = await venue(fetch).prepare(route!, btcRequest);
    expect(prepared.deposit).toMatchObject({
      address: "bc1qchannel",
      expiresAt: new Date(1793970000 * 1000).toISOString(),
    });
  });

  it("raises VenueError when a non-EVM source has no deposit address", async () => {
    const btcRequest: QuoteRequest = {
      ...request,
      from: { asset: "btc:btc", amount: "0.001", address: BTC_ADDRESS },
      to: { asset: "base:eth", address: AGENT },
    };
    const fetch = fakeFetch({
      "/v3/quote": () => json(quoteResponse),
      "/v3/swap": () => json({ swapId: "swap-2", sellAmount: "0.001" }),
    });
    const [route] = await venue(fetch).quote(btcRequest);
    await expect(venue(fetch).prepare(route!, btcRequest)).rejects.toBeInstanceOf(VenueError);
  });

  it("raises VenueError when /v3/swap fails", async () => {
    const fetch = fakeFetch({
      "/v3/quote": () => json(quoteResponse),
      "/v3/swap": () => json({ error: "swapRouteNotFound" }, 404),
    });
    await expect(venue(fetch).prepare(await quoted(fetch), request)).rejects.toBeInstanceOf(
      VenueError,
    );
  });
});

describe("mapTrackStatus", () => {
  it.each([
    ["not_started", "awaiting_deposit"],
    ["pending", "confirming"],
    ["swapping", "exchanging"],
    ["completed", "completed"],
    ["refunded", "refunded"],
    ["failed", "failed"],
    ["unknown", "confirming"],
  ])("maps %s to %s", (input, expected) => {
    expect(mapTrackStatus(input)).toBe(expected);
  });
});
