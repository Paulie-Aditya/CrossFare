import { readFileSync } from "node:fs";
import { decodeFunctionData, erc20Abi } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAssets, type Asset } from "../assets.ts";
import { THORCHAIN_ROUTER_ABI, createThorchainVenue } from "./thorchain.ts";
import { VenueError, type FetchLike, type QuoteRequest, type TrackInput } from "./types.ts";

/** Responses recorded from a public THORNode on 9 November 2026. */
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/thorchain/${name}.json`, import.meta.url), "utf8"));
const pools = fixture("pools");
const ltcToBtcQuote = fixture("ltc-btc");
const indicativeQuote = fixture("ltc-btc-indicative");
const usdcToLtcQuote = fixture("ethusdc-ltc");
const ethToLtcQuote = fixture("eth-ltc");

const NODE = "https://thornode.example";
const NOW = new Date("2026-11-08T23:50:00.000Z");
const LTC_ADDRESS = "ltc1qzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3nmndwj";
const BTC_ADDRESS = "bc1qyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zc6v074";
const AGENT = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const ROUTER = "0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146";

const LTC: Asset = { id: "ltc:ltc", chain: "ltc", symbol: "LTC", decimals: 8, swapkit: "LTC.LTC", swapkitChain: "litecoin" };
/** Listed by SwapKit, but THORChain has no pool for it. */
const SOL_USDC: Asset = {
  id: "sol:usdc-epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v",
  chain: "sol",
  symbol: "USDC",
  decimals: 6,
  swapkit: "SOL.USDC-EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  swapkitChain: "solana",
};

const ltcToBtc: QuoteRequest = {
  from: { asset: "ltc:ltc", amount: "1", address: LTC_ADDRESS },
  to: { asset: "btc:btc", address: BTC_ADDRESS },
  mode: "exact_in",
  slippageBps: 300,
};
const usdcToLtc: QuoteRequest = {
  from: { asset: "eth:usdc", amount: "20", address: AGENT },
  to: { asset: "ltc:ltc", address: LTC_ADDRESS },
  mode: "exact_in",
  slippageBps: 300,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function fakeFetch(quote: unknown, extra: Record<string, () => Response> = {}) {
  return vi.fn<FetchLike>(async (input) => {
    const { pathname } = new URL(input);
    if (pathname === "/thorchain/pools") return json(pools);
    if (pathname === "/thorchain/quote/swap") return quote instanceof Response ? quote : json(quote);
    const handler = Object.entries(extra).find(([prefix]) => pathname.startsWith(prefix))?.[1];
    if (!handler) throw new Error(`Unexpected call to ${pathname}`);
    return handler();
  });
}

const quoteParams = (fetch: ReturnType<typeof fakeFetch>) => {
  const call = fetch.mock.calls.find(([url]) => url.includes("/quote/swap"));
  return Object.fromEntries(new URL(call![0]).searchParams);
};

function venue(fetch: FetchLike) {
  return createThorchainVenue({ affiliate: "t", affiliateBps: 50, thornodeUrl: NODE, fetch, now: () => NOW });
}

beforeEach(() => registerAssets([LTC, SOL_USDC]));
afterEach(() => registerAssets([]));

describe("thorchain quote", () => {
  it("asks with THORChain's 8-decimal amount, the affiliate, streaming and the slippage limit", async () => {
    const fetch = fakeFetch(ltcToBtcQuote);
    await venue(fetch).quote(ltcToBtc);
    expect(quoteParams(fetch)).toEqual({
      from_asset: "LTC.LTC",
      to_asset: "BTC.BTC",
      amount: "100000000",
      destination: BTC_ADDRESS,
      streaming_interval: "1",
      streaming_quantity: "0",
      liquidity_tolerance_bps: "300",
      affiliate: "t",
      affiliate_bps: "50",
    });
  });

  it("normalizes the answer, guaranteeing the limit written into the memo", async () => {
    const [route] = await venue(fakeFetch(ltcToBtcQuote)).quote(ltcToBtc);
    expect(route).toEqual({
      venue: "thorchain",
      from: "ltc:ltc",
      to: "btc:btc",
      amountIn: "100000000",
      amountOut: "65863",
      minAmountOut: "65203",
      fees: { affiliate: "0.00000335 BTC", outbound: "0.0000088 BTC", liquidity: "0.00000134 BTC" },
      etaSeconds: 156,
      validUntil: "2026-11-08T23:55:00.000Z",
      depositable: false,
      venueData: {
        inbound: "ltc1qghejl6tasu04dxg5v9zz44gx4fuy3l7jg3mlmu",
        memo: ltcToBtcQuote.memo,
        expiry: 1794182711,
      },
    });
  });

  it("converts amounts for assets with more than 8 decimals", async () => {
    const fetch = fakeFetch(ethToLtcQuote);
    const [route] = await venue(fetch).quote({ ...usdcToLtc, from: { asset: "eth:eth", amount: "0.1", address: AGENT } });
    expect(quoteParams(fetch).amount).toBe("10000000");
    expect(route?.amountIn).toBe("100000000000000000");
    expect(route?.amountOut).toBe("420871777");
  });

  it("works out the minimum from the slippage when the memo sets no limit", async () => {
    const [route] = await venue(fakeFetch(ethToLtcQuote)).quote({ ...usdcToLtc, from: { asset: "eth:eth", amount: "0.1", address: AGENT } });
    expect(route?.minAmountOut).toBe("408245623");
  });

  it("gives a price check with no addresses, which can't be executed", async () => {
    const fetch = fakeFetch(indicativeQuote);
    const [route] = await venue(fetch).quote({ ...ltcToBtc, from: { ...ltcToBtc.from, address: "" }, to: { ...ltcToBtc.to, address: "" }, indicative: true });
    expect(quoteParams(fetch)).not.toHaveProperty("destination");
    expect(route?.amountOut).toBe(indicativeQuote.expected_amount_out);
    expect(route?.venueData).not.toHaveProperty("memo");
  });

  it("has no route for an asset without a pool, without asking for a quote", async () => {
    const fetch = fakeFetch(ltcToBtcQuote);
    expect(await venue(fetch).quote({ ...ltcToBtc, to: { asset: SOL_USDC.id, address: "x" } })).toEqual([]);
    expect(fetch.mock.calls.some(([url]) => url.includes("/quote/swap"))).toBe(false);
  });

  it("reads the pool list once, not on every quote", async () => {
    const fetch = fakeFetch(ltcToBtcQuote);
    const target = venue(fetch);
    await target.quote(ltcToBtc);
    await target.quote(ltcToBtc);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/thorchain/pools"))).toHaveLength(1);
  });

  it("can't fill an exact output, or a deposit from an exchange, whose refund would go back to the exchange", async () => {
    const fetch = fakeFetch(ltcToBtcQuote);
    expect(await venue(fetch).quote({ ...ltcToBtc, mode: "exact_out" })).toEqual([]);
    expect(await venue(fetch).quote({ ...ltcToBtc, flexibleDeposit: true })).toEqual([]);
  });

  it("has no route below the amount THORChain recommends, where fees would eat the swap", async () => {
    const fetch = fakeFetch(ltcToBtcQuote);
    expect(await venue(fetch).quote({ ...ltcToBtc, from: { ...ltcToBtc.from, amount: "0.08" } })).toEqual([]);
  });

  it("treats a halted chain, dust or a memo too long as no route", async () => {
    const halted = json({ code: 3, message: "trading is halted, can't process swap: invalid request" }, 400);
    expect(await venue(fakeFetch(halted)).quote(ltcToBtc)).toEqual([]);
  });

  it("fails loudly when the node itself fails", async () => {
    await expect(venue(fakeFetch(json({}, 503))).quote(ltcToBtc)).rejects.toThrow(VenueError);
  });
});

describe("thorchain prepare", () => {
  it("returns the vault and memo for a deposit from a chain without contracts", async () => {
    const target = venue(fakeFetch(ltcToBtcQuote));
    const [route] = await target.quote(ltcToBtc);
    expect(await target.prepare(route!, ltcToBtc)).toEqual({
      transactions: [],
      deposit: {
        asset: "ltc:ltc",
        address: "ltc1qghejl6tasu04dxg5v9zz44gx4fuy3l7jg3mlmu",
        memo: ltcToBtcQuote.memo,
        amount: "1",
        expiresAt: "2026-11-09T00:05:11.000Z",
      },
    });
  });

  it("approves the router, then deposits through it with an expiry, for an ERC-20", async () => {
    const target = venue(fakeFetch(usdcToLtcQuote));
    const [route] = await target.quote(usdcToLtc);
    const { transactions, deposit } = await target.prepare(route!, usdcToLtc);
    expect(deposit).toBeUndefined();
    expect(transactions.map(({ kind, chainId, to, value }) => ({ kind, chainId, to, value }))).toEqual([
      { kind: "approval", chainId: 1, to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", value: "0x0" },
      { kind: "swap", chainId: 1, to: ROUTER, value: "0x0" },
    ]);
    expect(decodeFunctionData({ abi: erc20Abi, data: transactions[0]!.data as `0x${string}` }).args).toEqual([ROUTER, 20_000_000n]);
    expect(decodeFunctionData({ abi: THORCHAIN_ROUTER_ABI, data: transactions[1]!.data as `0x${string}` })).toEqual({
      functionName: "depositWithExpiry",
      args: [
        "0x4D39d5c55cfeb48f44D680FcaC20493635DafdEe",
        "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        20_000_000n,
        usdcToLtcQuote.memo,
        1794182717n,
      ],
    });
  });

  it("sends the coin with the router call for a native EVM asset", async () => {
    const request = { ...usdcToLtc, from: { asset: "eth:eth", amount: "0.1", address: AGENT } };
    const target = venue(fakeFetch(ethToLtcQuote));
    const [route] = await target.quote(request);
    const { transactions } = await target.prepare(route!, request);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({ kind: "swap", to: ROUTER, value: "0x16345785d8a0000" });
    expect(decodeFunctionData({ abi: THORCHAIN_ROUTER_ABI, data: transactions[0]!.data as `0x${string}` }).args[1]).toBe(
      "0x0000000000000000000000000000000000000000",
    );
  });

  it("refuses a route quoted without addresses, which has no memo", async () => {
    const target = venue(fakeFetch(indicativeQuote));
    const [route] = await target.quote({ ...ltcToBtc, indicative: true });
    await expect(target.prepare(route!, ltcToBtc)).rejects.toThrow(VenueError);
  });
});

describe("thorchain track", () => {
  const MEMO_DONE = "=:ETH.USDT:0x91Bff85e6EE31290b57EC9d03Bb12D7B6F2B8d92:1054078300/0/0:-_/t1:0/80";
  const HASH = "1C19B8D56FD539AA925956B2185D760ED96D090B628A1537C220E15F1D766DE9";

  function track(status: unknown, overrides: Partial<TrackInput> = {}, memo = MEMO_DONE) {
    const fetch = fakeFetch(null, { "/thorchain/tx/status/": () => json(status) });
    const result = venue(fetch).track({
      route: { venueData: { inbound: "x", memo, expiry: 0 } } as never,
      request: { ...ltcToBtc, to: { asset: "eth:usdt", address: "0x91Bff85e6EE31290b57EC9d03Bb12D7B6F2B8d92" } },
      prepared: { transactions: [] },
      txHashes: [HASH.toLowerCase()],
      venueSwapId: null,
      ...overrides,
    });
    return { fetch, result };
  }

  it("waits for the caller's deposit hash", async () => {
    expect(await track({}, { txHashes: [] }).result).toEqual({ status: "awaiting_deposit" });
  });

  it("reports a finished swap, its delivery and the hashes, skipping THORChain's internal ones", async () => {
    const { fetch, result } = track(fixture("status-done"));
    expect(await result).toEqual({
      status: "completed",
      amountSent: "0.2208",
      amountReceived: "10.752787",
      txHashes: [HASH.toLowerCase(), "0x965b041b3cd0cdae0957f05bc5efb8e8850f0ffc96a43e16fa1de452579dfd1d"],
    });
    expect(fetch.mock.calls[0]![0]).toBe(`${NODE}/thorchain/tx/status/${HASH}`);
  });

  it("strips 0x from an EVM deposit hash, as THORChain writes hashes without it", async () => {
    const { fetch, result } = track(fixture("status-done"), { txHashes: [`0x${HASH.toLowerCase()}`] });
    await result;
    expect(fetch.mock.calls[0]![0]).toBe(`${NODE}/thorchain/tx/status/${HASH}`);
  });

  it("is still swapping until the outbound is signed", async () => {
    const pending = fixture("status-pending");
    expect((await track(pending, {}, pending.tx.memo).result).status).toBe("exchanging");
  });

  it("reports a refund once it is sent", async () => {
    const refund = fixture("status-refund");
    expect(await track(refund, {}, refund.tx.memo).result).toMatchObject({ status: "refunded", amountSent: "0.07410345" });
  });

  it("keeps confirming while THORChain hasn't seen the deposit", async () => {
    const unseen = { stages: { inbound_observed: { started: false, final_count: 0, completed: false } } };
    expect((await track(unseen).result).status).toBe("confirming");
  });

  it("ignores a hash whose memo isn't this swap's, since anyone can submit one", async () => {
    expect((await track(fixture("status-done"), {}, "=:b:someone-else:1/1/0").result).status).toBe("confirming");
  });
});
