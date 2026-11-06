import { describe, expect, it, vi } from "vitest";
import { createSwapKitScreen, createSwapKitVenue, mapTrackStatus } from "./swapkit.ts";
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
    const prepared = await venue(fetch).prepare({ ...route!, depositable: true }, btcRequest);
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
    const prepared = await venue(fetch).prepare({ ...route!, depositable: true }, btcRequest);
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
    await expect(venue(fetch).prepare({ ...route!, depositable: true }, btcRequest)).rejects.toBeInstanceOf(VenueError);
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

describe("swapkit deposit routes from an EVM wallet", () => {
  const evmRequest: QuoteRequest = {
    from: { asset: "eth:usdc", amount: "20", address: AGENT },
    to: { asset: "base:eth", address: "0x6dF69A2C97F8cFcBe5a04891ae0122942b8C24D1" },
    mode: "exact_in",
    slippageBps: 300,
    refundAddress: AGENT,
  };
  // Trimmed from a live /v3/swap response for USDC on Ethereum to ETH on Base.
  const simpleTransfer = {
    swapId: "swap-1",
    txHint: "simpleTransfer",
    txType: "EVM",
    sellAmount: "20",
    tx: {
      to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      from: AGENT,
      value: "0x0",
      data: "0xa9059cbb0000000000000000000000002e1ee6c27e66243a6301878e5036e327d48b64b3",
    },
    targetAddress: "0x2e1ee6c27e66243A6301878E5036e327D48b64B3",
    inboundAddress: "0x2e1ee6c27e66243A6301878E5036e327D48b64B3",
    expiration: "1793912046",
    meta: { depositChannelExpiration: 1793998327, providerDepositChannelId: "q_channel" },
  };
  const evmRoute = {
    venue: "swapkit",
    from: "eth:usdc",
    to: "base:eth",
    amountIn: "20000000",
    amountOut: "1",
    minAmountOut: "1",
    fees: {},
    etaSeconds: 45,
    validUntil: NOW.toISOString(),
    venueData: { routeId: "r" },
  };

  it("works out dollar values from SwapKit's asset prices, whatever their case", async () => {
    const priced = {
      ...apiRoute,
      expectedBuyAmount: "0.001",
      expectedBuyAmountMaxSlippage: "0.0009",
      meta: {
        assets: [
          { asset: "ETH.USDC-0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", price: 0.999465 },
          { asset: "BASE.ETH", price: 2232.29 },
        ],
      },
    };
    const fetch = fakeFetch({ "/v3/quote": () => json({ routes: [priced] }) });
    const [route] = await venue(fetch).quote(evmRequest);
    expect(route!.usd!.in).toBeCloseTo(19.9893, 3);
    expect(route!.usd!.out).toBeCloseTo(2.23229, 4);
  });

  it("leaves dollar values out when SwapKit gives no prices", async () => {
    const fetch = fakeFetch({ "/v3/quote": () => json(quoteResponse) });
    const [route] = await venue(fetch).quote(evmRequest);
    expect(route!.usd).toBeUndefined();
  });

  it("asks for a flexible quote when the deposit may come from anywhere", async () => {
    const fetch = fakeFetch({ "/v3/quote": () => json(quoteResponse) });
    await venue(fetch).quote({ ...evmRequest, flexibleDeposit: true });
    expect(JSON.parse(fetch.mock.calls[0]![1]?.body as string).quoteType).toBe("FLEX_INPUT");
  });

  it("keeps an exact quote otherwise", async () => {
    const fetch = fakeFetch({ "/v3/quote": () => json(quoteResponse) });
    await venue(fetch).quote(evmRequest);
    expect(JSON.parse(fetch.mock.calls[0]![1]?.body as string).quoteType).toBe("EXACT_INPUT");
  });

  it("skips the balance check only when the deposit may come from anywhere", async () => {
    const fetch = fakeFetch({ "/v3/swap": () => json(simpleTransfer) });
    await venue(fetch).prepare(evmRoute, { ...evmRequest, flexibleDeposit: true });
    await venue(fetch).prepare(evmRoute, evmRequest);
    const bodies = fetch.mock.calls.map((call) => JSON.parse(call[1]?.body as string));
    expect(bodies[0].disableBalanceCheck).toBe(true);
    expect(bodies[1].disableBalanceCheck).toBeUndefined();
  });

  it("marks a simple-transfer route as payable from any wallet software", async () => {
    const fetch = fakeFetch({
      "/v3/quote": () =>
        json({ routes: [{ ...apiRoute, txHint: "simpleTransfer" }, { ...apiRoute, routeId: "x", txHint: "contractCall" }] }),
    });
    const routes = await venue(fetch).quote(evmRequest);
    expect(routes.map((route) => route.depositable)).toEqual([true, false]);
  });

  it("returns both the transaction and the deposit details", async () => {
    const fetch = fakeFetch({ "/v3/swap": () => json(simpleTransfer) });
    const prepared = await venue(fetch).prepare(evmRoute, evmRequest);
    expect(prepared.transactions).toMatchObject([{ kind: "swap", chainId: 1, to: simpleTransfer.tx.to }]);
    expect(prepared.deposit).toEqual({
      asset: "eth:usdc",
      address: "0x2e1ee6c27e66243A6301878E5036e327D48b64B3",
      amount: "20",
      expiresAt: new Date(1793998327 * 1000).toISOString(),
      channelId: "q_channel",
    });
  });

  it("gives no deposit details for a contract-call route", async () => {
    const fetch = fakeFetch({
      "/v3/swap": () => json({ ...simpleTransfer, txHint: "contractCall", meta: {} }),
    });
    const prepared = await venue(fetch).prepare(evmRoute, evmRequest);
    expect(prepared.deposit).toBeUndefined();
    expect(prepared.transactions).toHaveLength(1);
  });

  it.each([
    [{ error: "insufficientBalance", message: "Cannot build transaction." }, "insufficient_balance"],
    [{ error: "quoteError", data: { code: "invalid_recipient_address" } }, "invalid_recipient"],
  ])("names the caller's mistake when SwapKit refuses the swap", async (answer, code) => {
    const fetch = fakeFetch({ "/v3/swap": () => json(answer, 400) });
    await expect(venue(fetch).prepare(evmRoute, evmRequest)).rejects.toMatchObject({ name: "VenueError", code });
  });

  it("tracks by deposit channel when there is one, even with a hash", async () => {
    const fetch = fakeFetch({ "/track": () => json({ status: "pending" }) });
    const prepared = {
      transactions: [{ kind: "swap" as const, chainId: 1, to: "0x", data: "0x", value: "0x0" }],
      deposit: { asset: "eth:usdc", address: "0xvault", amount: "20", channelId: "q_channel" },
    };
    await venue(fetch).track({ route: evmRoute, request: evmRequest, prepared, txHashes: ["0xhash"], venueSwapId: null });
    expect(JSON.parse(fetch.mock.calls[0]![1]?.body as string)).toEqual({ depositChannelId: "q_channel" });
  });

  it("stays awaiting the deposit when SwapKit knows nothing yet and nothing was sent", async () => {
    const fetch = fakeFetch({ "/track": () => json({}, 404) });
    const prepared = {
      transactions: [],
      deposit: { asset: "eth:usdc", address: "0xvault", amount: "20", channelId: "q_channel" },
    };
    const tracked = await venue(fetch).track({ route: evmRoute, request: evmRequest, prepared, txHashes: [], venueSwapId: null });
    expect(tracked.status).toBe("awaiting_deposit");
  });

  it("reports confirming, not awaiting the deposit, once a transaction was sent", async () => {
    const fetch = fakeFetch({ "/track": () => json({ status: "not_started" }) });
    const prepared = { transactions: [], deposit: { asset: "eth:usdc", address: "0xvault", amount: "20", channelId: "c" } };
    const tracked = await venue(fetch).track({ route: evmRoute, request: evmRequest, prepared, txHashes: ["0xhash"], venueSwapId: null });
    expect(tracked.status).toBe("confirming");
  });

  it("doesn't store SwapKit's all-zero placeholder hashes as transactions", async () => {
    const zero = `0x${"0".repeat(64)}`;
    const fetch = fakeFetch({ "/track": () => json({ status: "not_started", legs: [{ hash: "0x" }, { hash: zero }, { hash: zero }] }) });
    const prepared = { transactions: [], deposit: { asset: "eth:usdc", address: "0xvault", amount: "2", channelId: "c" } };
    const tracked = await venue(fetch).track({ route: evmRoute, request: evmRequest, prepared, txHashes: [], venueSwapId: null });
    expect(tracked).toEqual({ status: "awaiting_deposit" });
  });

  it("keeps awaiting the deposit even if a placeholder hash was already stored", async () => {
    const zero = `0x${"0".repeat(64)}`;
    const fetch = fakeFetch({ "/track": () => json({ status: "not_started" }) });
    const prepared = { transactions: [], deposit: { asset: "eth:usdc", address: "0xvault", amount: "2", channelId: "c" } };
    const tracked = await venue(fetch).track({ route: evmRoute, request: evmRequest, prepared, txHashes: [zero, zero], venueSwapId: null });
    expect(tracked.status).toBe("awaiting_deposit");
  });

  it("ignores the empty hash SwapKit reports before a deposit lands", async () => {
    const fetch = fakeFetch({ "/track": () => json({ status: "not_started", legs: [{ hash: "0x" }] }) });
    const prepared = { transactions: [], deposit: { asset: "eth:usdc", address: "0xvault", amount: "20" } };
    const tracked = await venue(fetch).track({ route: evmRoute, request: evmRequest, prepared, txHashes: [], venueSwapId: null });
    expect(tracked).toEqual({ status: "awaiting_deposit" });
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

describe("swapkit track", () => {
  const route = {
    venue: "swapkit",
    from: "base:eth",
    to: "btc:btc",
    amountIn: "1",
    amountOut: "1",
    minAmountOut: "1",
    fees: {},
    etaSeconds: 1,
    validUntil: "",
    venueData: { routeId: "route-1" },
  };
  const input = {
    route,
    request,
    prepared: { transactions: [{ kind: "swap" as const, chainId: 8453, to: "0xv", data: "0x", value: "0x1" }] },
    txHashes: ["0xhash"],
    venueSwapId: "swap-1",
  };

  it("tracks an EVM source by hash, chain and route", async () => {
    const fetch = fakeFetch({ "/track": () => json({ status: "swapping", fromAddress: AGENT }) });
    expect(await venue(fetch).track!(input)).toEqual({ status: "exchanging" });
    expect(fetch.mock.calls[0]![0]).toBe("https://api.swapkit.dev/track");
    expect(JSON.parse(fetch.mock.calls[0]![1]?.body as string)).toEqual({
      hash: "0xhash",
      chainId: "8453",
      routeId: "route-1",
    });
  });

  it("tracks a deposit by address", async () => {
    const fetch = fakeFetch({ "/track": () => json({ status: "not_started" }) });
    const result = await venue(fetch).track!({
      ...input,
      txHashes: [],
      prepared: { transactions: [], deposit: { asset: "btc:btc", address: "bc1qvault", amount: "0.1" } },
    });
    expect(result.status).toBe("awaiting_deposit");
    expect(JSON.parse(fetch.mock.calls[0]![1]?.body as string)).toEqual({ depositAddress: "bc1qvault" });
  });

  it("waits for a hash on an EVM source without calling SwapKit", async () => {
    const fetch = fakeFetch({});
    expect(await venue(fetch).track!({ ...input, txHashes: [] })).toEqual({ status: "awaiting_deposit" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("treats a 404 right after broadcast as still confirming", async () => {
    const fetch = fakeFetch({ "/track": () => json({ error: "txNotFound" }, 404) });
    expect(await venue(fetch).track!(input)).toEqual({ status: "confirming" });
  });

  it("treats a 202 as still confirming", async () => {
    const fetch = fakeFetch({ "/track": () => json({}, 202) });
    expect(await venue(fetch).track!(input)).toEqual({ status: "confirming" });
  });

  it("reports the amount received and the destination hash when complete", async () => {
    const fetch = fakeFetch({
      "/track": () =>
        json({
          status: "completed",
          fromAddress: AGENT,
          toAmount: "0.00031",
          legs: [{ hash: "0xhash" }, { hash: "btcOutHash" }],
        }),
    });
    expect(await venue(fetch).track!(input)).toEqual({
      status: "completed",
      amountReceived: "0.00031",
      txHashes: ["0xhash", "btcOutHash"],
    });
  });

  it("ignores a hash sent from another address", async () => {
    const fetch = fakeFetch({ "/track": () => json({ status: "completed", fromAddress: "0xother" }) });
    expect(await venue(fetch).track!(input)).toEqual({ status: "confirming" });
  });
});

describe("swapkit screening", () => {
  it("sends each address with its chain and reports the verdict", async () => {
    const fetch = fakeFetch({ "/screen": () => json({ isRisky: true }) });
    const screen = createSwapKitScreen({ apiKey: "test-key", fetch });
    const risky = await screen([
      { address: AGENT, asset: "base:eth" },
      { address: BTC_ADDRESS, asset: "btc:btc" },
    ]);
    expect(risky).toBe(true);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.swapkit.dev/screen");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("test-key");
    expect(JSON.parse(init?.body as string)).toEqual({
      addresses: [AGENT, BTC_ADDRESS],
      chains: ["8453", "bitcoin"],
    });
  });

  it("reports a passing address", async () => {
    const fetch = fakeFetch({ "/screen": () => json({ isRisky: false }) });
    const screen = createSwapKitScreen({ apiKey: "k", fetch });
    expect(await screen([{ address: AGENT, asset: "base:eth" }])).toBe(false);
  });

  it("fails rather than passing when screening errors", async () => {
    const fetch = fakeFetch({ "/screen": () => json({}, 500) });
    const screen = createSwapKitScreen({ apiKey: "k", fetch });
    await expect(screen([{ address: AGENT, asset: "base:eth" }])).rejects.toBeInstanceOf(VenueError);
  });

  it("fails rather than passing on an unexpected answer", async () => {
    const fetch = fakeFetch({ "/screen": () => json({ ok: true }) });
    const screen = createSwapKitScreen({ apiKey: "k", fetch });
    await expect(screen([{ address: AGENT, asset: "base:eth" }])).rejects.toBeInstanceOf(VenueError);
  });
});

describe("track stages", () => {
  const real = `0x${"a".repeat(64)}`;
  const prepared = { transactions: [], deposit: { asset: "eth:usdc", address: "0xdeposit", amount: "5", channelId: "c1" } };
  const request: QuoteRequest = {
    from: { asset: "eth:usdc", amount: "5", address: "0xC9bebBA9f481b12cE6f3EA54c4B182c9636ec421" },
    to: { asset: "base:eth", address: "0xC9bebBA9f481b12cE6f3EA54c4B182c9636ec421" },
    mode: "exact_in",
    slippageBps: 300,
    refundAddress: "0xC9bebBA9f481b12cE6f3EA54c4B182c9636ec421",
  };
  const route = { venue: "swapkit", from: "eth:usdc", to: "base:eth", amountIn: "5000000", amountOut: "1", minAmountOut: "1", fees: {}, etaSeconds: 1, validUntil: "", venueData: { routeId: "r1" } };
  const track = (body: unknown) =>
    venue(fakeFetch({ "/track": () => json(body) })).track({ route, request, prepared, txHashes: [], venueSwapId: null });

  it("stops awaiting once a leg shows a real deposit, even if the swap still reads not_started", async () => {
    const tracked = await track({ status: "not_started", legs: [{ hash: real, status: "pending" }] });
    expect(tracked.status).toBe("confirming");
    expect(tracked.txHashes).toEqual([real]);
  });

  it("reports exchanging once the deposit leg has completed", async () => {
    const tracked = await track({ status: "pending", legs: [{ hash: real, status: "completed" }, { hash: "0x", status: "not_started" }] });
    expect(tracked.status).toBe("exchanging");
  });

  it("keeps awaiting while the legs only hold placeholders", async () => {
    const tracked = await track({ status: "not_started", legs: [{ hash: "0x", status: "not_started" }] });
    expect(tracked.status).toBe("awaiting_deposit");
  });

  it("asks for a price without any addresses when the quote is indicative", async () => {
    const fetch = fakeFetch({ "/v3/quote": () => json({ routes: [] }) });
    await venue(fetch).quote({ ...request, indicative: true });
    const sent = JSON.parse(String(fetch.mock.calls[0]![1]?.body));
    expect(sent).not.toHaveProperty("sourceAddress");
    expect(sent).not.toHaveProperty("destinationAddress");
    expect(sent).not.toHaveProperty("refundAddress");
  });
});


describe("sources Crossfare can't sign on", () => {
  const SOL = "So11111111111111111111111111111111111111112";
  const request: QuoteRequest = {
    from: { asset: "sol:sol", amount: "1", address: SOL },
    to: { asset: "base:eth", address: "0xC9bebBA9f481b12cE6f3EA54c4B182c9636ec421" },
    mode: "exact_in",
    slippageBps: 300,
  };
  const route = (depositable: boolean) => ({ venue: "swapkit", from: "sol:sol", to: "base:eth", amountIn: "1", amountOut: "1", minAmountOut: "1", fees: {}, etaSeconds: 1, validUntil: "", depositable, venueData: { routeId: "r1" } });

  it("offers a plain-transfer route as a deposit", async () => {
    const fetch = fakeFetch({ "/v3/swap": () => json({ swapId: "s", txHint: "simpleTransfer", targetAddress: "deposit-here", sellAmount: "1" }) });
    const prepared = await venue(fetch).prepare(route(true), request);
    expect(prepared.deposit?.address).toBe("deposit-here");
  });

  it("refuses any other route, because its target isn't a deposit address and funds sent there could be lost", async () => {
    const fetch = fakeFetch({ "/v3/swap": () => json({ swapId: "s", txHint: "contractCall", tx: "base64tx", targetAddress: "a-program" }) });
    await expect(venue(fetch).prepare(route(false), request)).rejects.toMatchObject({ name: "VenueError", code: "wallet_required" });
  });
});

describe("addresses SwapKit won't accept", () => {
  it("names a sample address as the caller's to fix, rather than a venue failure", async () => {
    const route = { venue: "swapkit", from: "btc:btc", to: "base:eth", amountIn: "1", amountOut: "1", minAmountOut: "1", fees: {}, etaSeconds: 1, validUntil: "", depositable: true, venueData: { routeId: "r1" } };
    const request: QuoteRequest = { from: { asset: "btc:btc", amount: "1", address: "bc1qsample" }, to: { asset: "base:eth", address: "0xC9bebBA9f481b12cE6f3EA54c4B182c9636ec421" }, mode: "exact_in", slippageBps: 300 };
    const fetch = fakeFetch({ "/v3/swap": () => json({ error: "invalidRoute", message: "they cannot be dummy addresses" }, 400) });
    await expect(venue(fetch).prepare(route, request)).rejects.toMatchObject({ code: "sample_address" });
  });
});

describe("a deposit that differs from the quote", () => {
  const ADDRESS = "0xC9bebBA9f481b12cE6f3EA54c4B182c9636ec421";
  const request = (flexibleDeposit: boolean): QuoteRequest => ({
    from: { asset: "eth:usdc", amount: "5", address: ADDRESS },
    to: { asset: "base:eth", address: ADDRESS },
    mode: "exact_in",
    slippageBps: 300,
    ...(flexibleDeposit ? { flexibleDeposit } : {}),
  });
  const route = (provider: string) => ({ venue: "swapkit", provider, from: "eth:usdc", to: "base:eth", amountIn: "5000000", amountOut: "1", minAmountOut: "1", fees: {}, etaSeconds: 1, validUntil: "", depositable: true, venueData: { routeId: "r1" } });
  const swap = () => fakeFetch({ "/v3/swap": () => json({ swapId: "s", txHint: "simpleTransfer", inboundAddress: "0xdeposit", sellAmount: "5", tx: { to: "0xusdc", data: "0xa9", value: "0" } }) });

  it("gives NEAR's documented band: slippage below the quote on a flexible deposit", async () => {
    const prepared = await venue(swap()).prepare(route("near"), request(true));
    expect(prepared.deposit?.minAmount).toBe("4.85");
  });

  it("needs the full amount on an exact quote", async () => {
    const prepared = await venue(swap()).prepare(route("near"), request(false));
    expect(prepared.deposit?.minAmount).toBe("5");
  });

  it("states no minimum where a provider documents none", async () => {
    const prepared = await venue(swap()).prepare(route("flashnet"), request(true));
    expect(prepared.deposit?.minAmount).toBeUndefined();
  });

  const prepared = { transactions: [], deposit: { asset: "eth:usdc", address: "0xdeposit", amount: "5", channelId: "c1" } };
  const real = `0x${"a".repeat(64)}`;
  const track = (body: unknown) =>
    venue(fakeFetch({ "/track": () => json(body) })).track({ route: route("near"), request: request(true), prepared, txHashes: [], venueSwapId: null });

  it("reads what was actually deposited, once there is a deposit", async () => {
    const tracked = await track({ status: "pending", fromAmount: "4.9", legs: [{ hash: real, status: "pending" }] });
    expect(tracked.amountSent).toBe("4.9");
  });

  it("ignores the amount while nothing has arrived, because it may only echo the quote", async () => {
    const tracked = await track({ status: "not_started", fromAmount: "5", legs: [{ hash: "0x", status: "not_started" }] });
    expect(tracked.amountSent).toBeUndefined();
  });

  it("reports a refund's reason", async () => {
    const tracked = await track({ status: "refunded", fromAmount: "4", meta: { refundReason: "INCOMPLETE_DEPOSIT" }, legs: [{ hash: real, status: "refunded" }] });
    expect(tracked).toMatchObject({ status: "refunded", refundReason: "INCOMPLETE_DEPOSIT" });
  });

  it("reports a partial refund, which only trackingStatus can express", async () => {
    const tracked = await track({ status: "completed", trackingStatus: "partially_refunded", toAmount: "1", legs: [{ hash: real, status: "completed" }] });
    expect(tracked).toMatchObject({ status: "completed", partialRefund: true });
  });
});

