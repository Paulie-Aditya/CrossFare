import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { catalogAsset, registerAssets } from "../assets.ts";
import { createUniswapVenue } from "./uniswap.ts";
import { VenueError, type FetchLike, type QuoteRequest } from "./types.ts";

const AGENT = "0xC9bebBA9f481b12cE6f3EA54c4B182c9636ec421";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NOW = new Date("2026-11-06T10:00:00.000Z");

const request: QuoteRequest = {
  from: { asset: "base:usdc", amount: "2", address: AGENT },
  to: { asset: "base:eth", address: AGENT },
  mode: "exact_in",
  slippageBps: 50,
};

// Shape follows the examples in the Uniswap API spec (ClassicQuote).
const quoteResponse = {
  requestId: "req-1",
  routing: "CLASSIC",
  permitData: null,
  quote: {
    chainId: 8453,
    input: { amount: "2000000", token: USDC },
    output: { amount: "996320746321162", token: "0x0", recipient: AGENT },
    aggregatedOutputs: [
      { amount: "996320746321162", token: "0x0", recipient: AGENT, bps: 10000, minAmount: "991339142589556" },
    ],
    gasFeeUSD: "0.01",
    quoteId: "quote-1",
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function fakeFetch(handlers: Record<string, () => Response>) {
  return vi.fn<FetchLike>(async (url) => {
    const path = new URL(url).pathname.replace("/v1", "");
    const handler = handlers[path];
    if (!handler) throw new Error(`Unexpected call to ${path}`);
    return handler();
  });
}

function venue(fetch: FetchLike) {
  return createUniswapVenue({ apiKey: "test-key", fetch, now: () => NOW });
}

describe("uniswap quote", () => {
  it("sends a classic-only quote in base units with the API key", async () => {
    const fetch = fakeFetch({ "/quote": () => json(quoteResponse) });
    await venue(fetch).quote(request);

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://trade-api.gateway.uniswap.org/v1/quote");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-api-key")).toBe("test-key");
    expect(headers.get("x-permit2-disabled")).toBe("true");
    expect(JSON.parse(init?.body as string)).toEqual({
      type: "EXACT_INPUT",
      amount: "2000000",
      tokenInChainId: 8453,
      tokenOutChainId: 8453,
      tokenIn: USDC,
      tokenOut: "0x0000000000000000000000000000000000000000",
      swapper: AGENT,
      recipient: AGENT,
      slippageTolerance: 0.5,
      protocols: ["V2", "V3", "V4"],
    });
  });

  it("normalizes the classic quote into a route", async () => {
    const [route] = await venue(fakeFetch({ "/quote": () => json(quoteResponse) })).quote(request);
    expect(route).toMatchObject({
      venue: "uniswap",
      from: "base:usdc",
      to: "base:eth",
      amountIn: "2000000",
      amountOut: "996320746321162",
      minAmountOut: "991339142589556",
      fees: { networkUsd: "0.01" },
      validUntil: "2026-11-06T10:01:00.000Z",
    });
  });

  it("expresses exact_out amounts in the output asset", async () => {
    const fetch = fakeFetch({ "/quote": () => json(quoteResponse) });
    await venue(fetch).quote({
      ...request,
      from: { ...request.from, amount: "0.001" },
      mode: "exact_out",
    });
    const body = JSON.parse(fetch.mock.calls[0]![1]?.body as string);
    expect(body).toMatchObject({ type: "EXACT_OUTPUT", amount: "1000000000000000" });
  });

  it("derives the minimum from slippage when aggregated outputs are missing", async () => {
    const { aggregatedOutputs: _omitted, ...quote } = quoteResponse.quote;
    const fetch = fakeFetch({ "/quote": () => json({ ...quoteResponse, quote }) });
    const [route] = await venue(fetch).quote(request);
    expect(route?.minAmountOut).toBe("991339142589556");
  });

  it("skips cross-chain pairs without calling the API", async () => {
    const fetch = fakeFetch({});
    const routes = await venue(fetch).quote({
      ...request,
      to: { asset: "eth:eth", address: AGENT },
    });
    expect(routes).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("skips non-EVM pairs without calling the API", async () => {
    const fetch = fakeFetch({});
    expect(
      await venue(fetch).quote({ ...request, to: { asset: "btc:btc", address: "bc1q" } }),
    ).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns no routes when Uniswap reports none", async () => {
    const fetch = fakeFetch({ "/quote": () => json({ errorCode: "NoRouteFoundError" }, 404) });
    expect(await venue(fetch).quote(request)).toEqual([]);
  });

  it("returns no routes for a routing type /swap can't execute", async () => {
    const fetch = fakeFetch({ "/quote": () => json({ ...quoteResponse, routing: "DUTCH_V2" }) });
    expect(await venue(fetch).quote(request)).toEqual([]);
  });

  it("raises VenueError on a server failure", async () => {
    const fetch = fakeFetch({ "/quote": () => json({ detail: "boom" }, 500) });
    await expect(venue(fetch).quote(request)).rejects.toBeInstanceOf(VenueError);
  });

  it("does not leak the API key in errors", async () => {
    const fetch = fakeFetch({ "/quote": () => json({ detail: "boom" }, 500) });
    await expect(venue(fetch).quote(request)).rejects.not.toThrow(/test-key/);
  });
});

describe("an integrator fee", () => {
  const FEE_WALLET = "0xebdfd05075d84435de2d9a05336e7b2814e10cb5";
  // Recorded from the live API: 2 USDC to ETH on Base with 100 bips to FEE_WALLET.
  const feeQuote = JSON.parse(readFileSync(new URL("./fixtures/uniswap/quote-integrator-fee.json", import.meta.url), "utf8"));
  const withFee = (fetch: FetchLike) => createUniswapVenue({ apiKey: "test-key", fetch, now: () => NOW, feeRecipient: FEE_WALLET });
  const sentBody = (fetch: ReturnType<typeof fakeFetch>) => JSON.parse(fetch.mock.calls[0]![1]?.body as string);

  it("asks Uniswap for the caller's fee, paid to the fee wallet", async () => {
    const fetch = fakeFetch({ "/quote": () => json(feeQuote) });
    await withFee(fetch).quote({ ...request, feeBps: 100 });
    expect(sentBody(fetch).integratorFees).toEqual([{ bips: 100, recipient: FEE_WALLET }]);
  });

  it("charges nothing when the caller's fee is zero or unset", async () => {
    for (const feeBps of [undefined, 0]) {
      const fetch = fakeFetch({ "/quote": () => json(quoteResponse) });
      await withFee(fetch).quote({ ...request, ...(feeBps === undefined ? {} : { feeBps }) });
      expect(sentBody(fetch)).not.toHaveProperty("integratorFees");
    }
  });

  it("charges nothing without a fee wallet", async () => {
    const fetch = fakeFetch({ "/quote": () => json(quoteResponse) });
    await venue(fetch).quote({ ...request, feeBps: 100 });
    expect(sentBody(fetch)).not.toHaveProperty("integratorFees");
  });

  it("quotes what reaches the caller, and shows the fee", async () => {
    const [route] = await withFee(fakeFetch({ "/quote": () => json(feeQuote) })).quote({ ...request, feeBps: 100 });
    expect(route).toMatchObject({
      amountOut: "930760823212813",
      minAmountOut: "926107019096748",
      fees: { networkUsd: feeQuote.quote.gasFeeUSD, integrator: "0.000009401624476897 ETH" },
    });
  });

  it("takes the fee's share out of native output when tracking", async () => {
    const getReceipt = vi.fn(async () => ({
      status: "success",
      from: AGENT,
      to: "0xrouter",
      // The router unwraps the whole output, then pays the fee wallet its share.
      logs: [
        {
          address: "0x4200000000000000000000000000000000000006",
          topics: ["0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65", "0x"],
          data: "0x" + BigInt(feeQuote.quote.output.amount).toString(16),
        },
      ],
    }));
    const uniswap = createUniswapVenue({ apiKey: "k", fetch: fakeFetch({}), getReceipt: getReceipt as never, feeRecipient: FEE_WALLET });
    const [route] = await withFee(fakeFetch({ "/quote": () => json(feeQuote) })).quote({ ...request, feeBps: 100 });
    const result = await uniswap.track!({
      route: route!,
      request,
      prepared: { transactions: [{ kind: "swap", chainId: 8453, to: "0xRouter", data: "0xswap", value: "0x0" }] },
      txHashes: ["0xhash"],
      venueSwapId: null,
    });
    expect(result).toEqual({ status: "completed", amountReceived: "0.000930760823212813" });
  });
});

describe("uniswap prepare", () => {
  const swapTx = { to: "0xrouter", data: "0xswap", value: "0x00", chainId: 8453 };
  const approvalTx = { to: USDC, from: AGENT, data: "0xapprove", value: "0x00", chainId: 8453 };

  async function quotedRoute(fetch: FetchLike) {
    const [route] = await venue(fetch).quote(request);
    return route!;
  }

  it("returns the approval then the swap, in order", async () => {
    const fetch = fakeFetch({
      "/quote": () => json(quoteResponse),
      "/check_approval": () => json({ requestId: "a", approval: approvalTx, cancel: null }),
      "/swap": () => json({ requestId: "s", swap: swapTx }),
    });
    const prepared = await venue(fetch).prepare(await quotedRoute(fetch), request);
    expect(prepared.transactions).toEqual([
      { kind: "approval", chainId: 8453, to: USDC, data: "0xapprove", value: "0x0" },
      { kind: "swap", chainId: 8453, to: "0xrouter", data: "0xswap", value: "0x0" },
    ]);
  });

  it("puts a required allowance reset before the approval", async () => {
    const cancel = { ...approvalTx, data: "0xreset" };
    const fetch = fakeFetch({
      "/quote": () => json(quoteResponse),
      "/check_approval": () => json({ requestId: "a", approval: approvalTx, cancel }),
      "/swap": () => json({ requestId: "s", swap: swapTx }),
    });
    const prepared = await venue(fetch).prepare(await quotedRoute(fetch), request);
    expect(prepared.transactions.map((t) => t.data)).toEqual(["0xreset", "0xapprove", "0xswap"]);
  });

  it("omits approval when the allowance is already in place", async () => {
    const fetch = fakeFetch({
      "/quote": () => json(quoteResponse),
      "/check_approval": () => json({ requestId: "a", approval: null, cancel: null }),
      "/swap": () => json({ requestId: "s", swap: swapTx }),
    });
    const prepared = await venue(fetch).prepare(await quotedRoute(fetch), request);
    expect(prepared.transactions.map((t) => t.kind)).toEqual(["swap"]);
  });

  it("does not check approval when selling the native token", async () => {
    const nativeRequest: QuoteRequest = {
      ...request,
      from: { asset: "base:eth", amount: "0.001", address: AGENT },
      to: { asset: "base:usdc", address: AGENT },
    };
    const fetch = fakeFetch({
      "/quote": () => json(quoteResponse),
      "/swap": () => json({ requestId: "s", swap: { ...swapTx, value: "1000" } }),
    });
    const [route] = await venue(fetch).quote(nativeRequest);
    const prepared = await venue(fetch).prepare(route!, nativeRequest);
    expect(prepared.transactions).toEqual([
      { kind: "swap", chainId: 8453, to: "0xrouter", data: "0xswap", value: "0x3e8" },
    ]);
  });

  it("sends the quote from /quote to /swap unchanged", async () => {
    const fetch = fakeFetch({
      "/quote": () => json(quoteResponse),
      "/check_approval": () => json({ requestId: "a", approval: null, cancel: null }),
      "/swap": () => json({ requestId: "s", swap: swapTx }),
    });
    await venue(fetch).prepare(await quotedRoute(fetch), request);
    const swapCall = fetch.mock.calls.find(([url]) => url.endsWith("/swap"))!;
    expect(JSON.parse(swapCall[1]?.body as string)).toEqual({ quote: quoteResponse.quote });
  });

  it("rejects a swap transaction with empty calldata", async () => {
    const fetch = fakeFetch({
      "/quote": () => json(quoteResponse),
      "/check_approval": () => json({ requestId: "a", approval: null, cancel: null }),
      "/swap": () => json({ requestId: "s", swap: { ...swapTx, data: "" } }),
    });
    await expect(venue(fetch).prepare(await quotedRoute(fetch), request)).rejects.toBeInstanceOf(
      VenueError,
    );
  });
});

describe("uniswap track", () => {
  const WETH = "0x4200000000000000000000000000000000000006";
  const pad = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const WITHDRAWAL = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";
  const prepared = {
    transactions: [{ kind: "swap" as const, chainId: 8453, to: "0xRouter", data: "0xswap", value: "0x0" }],
  };
  const route = {
    venue: "uniswap",
    from: "base:usdc",
    to: "base:eth",
    amountIn: "1",
    amountOut: "1",
    minAmountOut: "1",
    fees: {},
    etaSeconds: 1,
    validUntil: "",
    venueData: null,
  };

  function tracked(receipt: unknown) {
    const getReceipt = vi.fn(async () => receipt);
    const uniswap = createUniswapVenue({ apiKey: "k", fetch: fakeFetch({}), getReceipt: getReceipt as never });
    return { uniswap, getReceipt };
  }

  const input = { route, request, prepared, txHashes: ["0xhash"], venueSwapId: null };

  it("waits for a hash before reporting progress", async () => {
    const { uniswap } = tracked(null);
    expect(await uniswap.track!({ ...input, txHashes: [] })).toEqual({ status: "awaiting_deposit" });
  });

  it("stays confirming until a receipt exists", async () => {
    const { uniswap, getReceipt } = tracked(null);
    expect(await uniswap.track!(input)).toEqual({ status: "confirming" });
    expect(getReceipt).toHaveBeenCalledWith(8453, "0xhash");
  });

  it("reports failure on a reverted swap", async () => {
    const { uniswap } = tracked({ status: "reverted", from: AGENT, to: "0xrouter", logs: [] });
    expect((await uniswap.track!(input)).status).toBe("failed");
  });

  it("ignores a transaction from another sender", async () => {
    const { uniswap } = tracked({ status: "success", from: "0xsomeoneelse", to: "0xrouter", logs: [] });
    expect((await uniswap.track!(input)).status).toBe("confirming");
  });

  it("ignores a transaction to another contract", async () => {
    const { uniswap } = tracked({ status: "success", from: AGENT, to: "0xelsewhere", logs: [] });
    expect((await uniswap.track!(input)).status).toBe("confirming");
  });

  it("reads native output from the WETH withdrawal", async () => {
    const { uniswap } = tracked({
      status: "success",
      from: AGENT,
      to: "0xrouter",
      logs: [{ address: WETH, topics: [WITHDRAWAL, pad("0xrouter0000000000000000000000000000000000")], data: "0x03e8" }],
    });
    expect(await uniswap.track!(input)).toEqual({ status: "completed", amountReceived: "0.000000000000001" });
  });

  describe("on a chain other than Base", () => {
    beforeAll(() =>
      registerAssets([
        catalogAsset({ chain: "ARB", chainId: "42161", ticker: "ETH", identifier: "ARB.ETH", decimals: 18 }),
        catalogAsset({ chain: "HOOD", chainId: "4663", ticker: "ETH", identifier: "HOOD.ETH", decimals: 18 }),
      ]),
    );
    afterAll(() => registerAssets([]));

    const onChain = (chainId: number, to: string) => ({
      ...input,
      route: { ...route, from: to, to },
      prepared: { transactions: [{ ...prepared.transactions[0]!, chainId }] },
    });

    it("reads native output from that chain's own wrapped coin", async () => {
      const arbitrumWeth = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
      const { uniswap, getReceipt } = tracked({
        status: "success",
        from: AGENT,
        to: "0xrouter",
        logs: [
          { address: WETH, topics: [WITHDRAWAL, pad("0xrouter0000000000000000000000000000000000")], data: "0x01" },
          { address: arbitrumWeth, topics: [WITHDRAWAL, pad("0xrouter0000000000000000000000000000000000")], data: "0x03e8" },
        ],
      });
      expect(await uniswap.track!(onChain(42161, "arb:eth"))).toEqual({ status: "completed", amountReceived: "0.000000000000001" });
      expect(getReceipt).toHaveBeenCalledWith(42161, "0xhash");
    });

    it("leaves the amount to the quote where no wrapped coin is known", async () => {
      const { uniswap } = tracked({ status: "success", from: AGENT, to: "0xrouter", logs: [] });
      expect(await uniswap.track!(onChain(4663, "hood:eth"))).toEqual({ status: "completed" });
    });
  });

  it("reads token output from transfers to the recipient only", async () => {
    const tokenRequest: QuoteRequest = { ...request, to: { asset: "base:usdc", address: AGENT } };
    const { uniswap } = tracked({
      status: "success",
      from: AGENT,
      to: "0xrouter",
      logs: [
        { address: USDC, topics: [TRANSFER, pad(AGENT), pad("0x0000000000000000000000000000000000000abc")], data: "0x01" },
        { address: USDC, topics: [TRANSFER, pad("0x0000000000000000000000000000000000000abc"), pad(AGENT)], data: "0x1e8480" },
      ],
    });
    expect(
      await uniswap.track!({ ...input, request: tokenRequest, route: { ...route, to: "base:usdc" } }),
    ).toEqual({ status: "completed", amountReceived: "2" });
  });
});

describe("a price check", () => {
  it("uses a placeholder Uniswap can route for, because reserved addresses like 0x01 get no route", async () => {
    const fetch = fakeFetch({ "/quote": () => json(quoteResponse) });
    await venue(fetch).quote({ ...request, indicative: true });
    const body = JSON.parse(fetch.mock.calls[0]![1]?.body as string);
    // The EVM reserves the lowest addresses for precompiles.
    expect(BigInt(body.swapper)).toBeGreaterThan(0x1000n);
    expect(body.swapper).not.toBe(AGENT);
    expect(body).not.toHaveProperty("recipient");
  });
});
