import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAssets, type Asset } from "../assets.ts";
import { createNearIntentsVenue, findNearToken, type NearToken } from "./near-intents.ts";
import { VenueError, type FetchLike, type QuoteRequest } from "./types.ts";

/** Responses recorded from the live 1Click API on 9 November 2026. */
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/near-intents/${name}.json`, import.meta.url), "utf8"));
const tokens = fixture("tokens");
const quoteLtcSol = fixture("quote-ltc-sol");
const statusPending = fixture("status-pending");

const NOW = new Date("2026-11-08T23:48:33.000Z");
const LTC_ADDRESS = "ltc1qzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3nmndwj";
const SOL_ADDRESS = "GZRiD2TR1oiSXXFDsGhLR5fZWbfHqY9KyfHkiChUuVBR";
const AGENT = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const DEPOSIT = "LcTpEbpNTaCpuu6nqdbGoSfTDTfYQVmv8A";

const LTC: Asset = { id: "ltc:ltc", chain: "ltc", symbol: "LTC", decimals: 8, swapkit: "LTC.LTC", swapkitChain: "litecoin" };
const SOL_USDC: Asset = {
  id: "sol:usdc-epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v",
  chain: "sol",
  symbol: "USDC",
  decimals: 6,
  swapkit: "SOL.USDC-EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  swapkitChain: "solana",
};
const DOGE: Asset = { id: "doge:doge", chain: "doge", symbol: "DOGE", decimals: 8, swapkit: "DOGE.DOGE", swapkitChain: "dogecoin" };

const ltcToSol: QuoteRequest = {
  from: { asset: "ltc:ltc", amount: "1", address: LTC_ADDRESS },
  to: { asset: "sol:sol", address: SOL_ADDRESS },
  mode: "exact_in",
  slippageBps: 100,
  refundAddress: LTC_ADDRESS,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** The dry quote is the live one without its deposit address and deadlines, as the API documents. */
const { depositAddress: _address, deadline: _deadline, timeWhenInactive: _inactive, ...dryQuote } = quoteLtcSol.quote;
const dryResponse = { ...quoteLtcSol, quote: dryQuote, quoteRequest: { ...quoteLtcSol.quoteRequest, dry: true } };

function fakeFetch(handlers: Record<string, (init?: RequestInit, url?: URL) => Response>) {
  return vi.fn<FetchLike>(async (input, init) => {
    const url = new URL(input);
    const handler = handlers[`${init?.method ?? "GET"} ${url.pathname}`];
    if (!handler) throw new Error(`Unexpected call to ${init?.method ?? "GET"} ${url.pathname}`);
    return handler(init, url);
  });
}

const bodyOf = (fetch: ReturnType<typeof fakeFetch>, call: number) => JSON.parse(fetch.mock.calls[call]![1]?.body as string);

function venue(fetch: FetchLike, options: { apiKey?: string } = {}) {
  return createNearIntentsVenue({ feeRecipient: "crossfare.near", feeBps: 50, fetch, now: () => NOW, ...options });
}

beforeEach(() => registerAssets([LTC, SOL_USDC, DOGE]));
afterEach(() => registerAssets([]));

describe("findNearToken", () => {
  const list = tokens as NearToken[];

  it("matches a native coin by chain and symbol", () => {
    expect(findNearToken(LTC, list)?.assetId).toBe("nep141:ltc.omft.near");
  });

  it("matches a token by contract, keeping case on chains where it matters", () => {
    expect(findNearToken(SOL_USDC, list)?.assetId).toBe("nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near");
    const lowered = { ...SOL_USDC, swapkit: SOL_USDC.swapkit!.toLowerCase().replace("sol.", "SOL.") };
    expect(findNearToken(lowered, list)).toBeUndefined();
  });

  it("ignores case for an EVM contract", () => {
    const usdc: Asset = {
      id: "eth:usdc",
      chain: "eth",
      symbol: "usdc",
      decimals: 6,
      swapkit: "ETH.USDC-0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      swapkitChain: "1",
    };
    expect(findNearToken(usdc, list)?.assetId).toBe("nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near");
  });

  it("finds a token only Uniswap lists, by chain ID and contract", () => {
    const usdc: Asset = {
      id: "base:usdc-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      chain: "base",
      symbol: "USDC",
      decimals: 6,
      uniswap: { chainId: 8453, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
      swapkitChain: "8453",
    };
    expect(findNearToken(usdc, list)?.blockchain).toBe("base");
  });

  it("refuses a token whose decimals differ, since amounts would be wrong", () => {
    expect(findNearToken({ ...LTC, decimals: 18 }, list)).toBeUndefined();
  });

  it("finds nothing for a chain NEAR Intents doesn't serve", () => {
    expect(findNearToken(DOGE, list)).toBeUndefined();
  });
});

describe("near intents quote", () => {
  it("asks for a dry quote with the app fee, the addresses and slippage in bps", async () => {
    const fetch = fakeFetch({ "GET /v0/tokens": () => json(tokens), "POST /v0/quote": () => json(dryResponse) });
    await venue(fetch).quote(ltcToSol);

    expect(fetch.mock.calls[1]![0]).toBe("https://1click.chaindefuser.com/v0/quote");
    expect(bodyOf(fetch, 1)).toEqual({
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: "nep141:ltc.omft.near",
      depositType: "ORIGIN_CHAIN",
      destinationAsset: "nep141:sol.omft.near",
      amount: "100000000",
      refundTo: LTC_ADDRESS,
      refundType: "ORIGIN_CHAIN",
      recipient: SOL_ADDRESS,
      recipientType: "DESTINATION_CHAIN",
      deadline: "2026-11-09T00:48:33.000Z",
      appFees: [{ recipient: "crossfare.near", fee: 50 }],
      referral: "crossfare",
    });
  });

  it("normalizes the answer into a route anyone can pay with a plain transfer", async () => {
    const fetch = fakeFetch({ "GET /v0/tokens": () => json(tokens), "POST /v0/quote": () => json(dryResponse) });
    const [route] = await venue(fetch).quote(ltcToSol);
    expect(route).toEqual({
      venue: "near-intents",
      from: "ltc:ltc",
      to: "sol:sol",
      amountIn: "100000000",
      amountOut: "575094870",
      minAmountOut: "569343921",
      fees: { app: "50 bps", withdraw: "0.000115662 SOL" },
      etaSeconds: 124,
      validUntil: "2026-11-08T23:53:33.000Z",
      depositable: true,
      usd: { in: 50.22, out: 49.860725229 },
      venueData: { originAsset: "nep141:ltc.omft.near", destinationAsset: "nep141:sol.omft.near" },
    });
  });

  it("sends the partner key when there is one", async () => {
    const fetch = fakeFetch({ "GET /v0/tokens": () => json(tokens), "POST /v0/quote": () => json(dryResponse) });
    await venue(fetch, { apiKey: "partner-key" }).quote(ltcToSol);
    expect(new Headers(fetch.mock.calls[1]![1]?.headers).get("x-api-key")).toBe("partner-key");
  });

  it("asks for an exact output, or a flexible input for a deposit from an exchange", async () => {
    const fetch = fakeFetch({ "GET /v0/tokens": () => json(tokens), "POST /v0/quote": () => json(dryResponse) });
    const target = venue(fetch);
    await target.quote({ ...ltcToSol, mode: "exact_out", from: { ...ltcToSol.from, amount: "0.5" } });
    await target.quote({ ...ltcToSol, flexibleDeposit: true });
    expect(bodyOf(fetch, 1)).toMatchObject({ swapType: "EXACT_OUTPUT", amount: "500000000" });
    expect(bodyOf(fetch, 2)).toMatchObject({ swapType: "FLEX_INPUT", amount: "100000000" });
  });

  it("reads the token list once, not on every quote", async () => {
    const fetch = fakeFetch({ "GET /v0/tokens": () => json(tokens), "POST /v0/quote": () => json(dryResponse) });
    const target = venue(fetch);
    await target.quote(ltcToSol);
    await target.quote(ltcToSol);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/v0/tokens"))).toHaveLength(1);
  });

  it("has no route for a pair it doesn't list, without asking for a quote", async () => {
    const fetch = fakeFetch({ "GET /v0/tokens": () => json(tokens) });
    expect(await venue(fetch).quote({ ...ltcToSol, to: { asset: "doge:doge", address: "D8vFz4p1L37jdg47HXKtSHA5uYLYxbGgPD" } })).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("skips a price check with no addresses, which 1Click can't quote", async () => {
    const fetch = fakeFetch({ "GET /v0/tokens": () => json(tokens) });
    expect(await venue(fetch).quote({ ...ltcToSol, indicative: true })).toEqual([]);
  });

  it("treats 'no liquidity' and other refusals of the request as no route", async () => {
    const fetch = fakeFetch({
      "GET /v0/tokens": () => json(tokens),
      "POST /v0/quote": () => json({ message: "No liquidity available" }, 400),
    });
    expect(await venue(fetch).quote(ltcToSol)).toEqual([]);
  });

  it("fails loudly when 1Click itself fails", async () => {
    const fetch = fakeFetch({ "GET /v0/tokens": () => json(tokens), "POST /v0/quote": () => json({}, 503) });
    await expect(venue(fetch).quote(ltcToSol)).rejects.toThrow(VenueError);
  });
});

describe("near intents prepare", () => {
  async function prepared(request = ltcToSol) {
    const fetch = fakeFetch({
      "GET /v0/tokens": () => json(tokens),
      "POST /v0/quote": (init) => json(JSON.parse(init?.body as string).dry ? dryResponse : quoteLtcSol),
    });
    const target = venue(fetch);
    const [route] = await target.quote(request);
    return { fetch, swap: await target.prepare(route!, request) };
  }

  it("asks for a live quote and returns its deposit address, with the least it swaps", async () => {
    const { fetch, swap } = await prepared();
    expect(bodyOf(fetch, 2)).toMatchObject({ dry: false, appFees: [{ recipient: "crossfare.near", fee: 50 }] });
    expect(swap).toEqual({
      venueSwapId: DEPOSIT,
      transactions: [],
      deposit: {
        asset: "ltc:ltc",
        address: DEPOSIT,
        amount: "1",
        minAmount: "1",
        expiresAt: "2026-11-09T00:48:33.000Z",
      },
    });
  });

  it("builds a plain transfer for an EVM source, so a wallet can sign it", async () => {
    const usdcRoute = {
      ...quoteLtcSol,
      quote: { ...quoteLtcSol.quote, amountIn: "20000000", minAmountIn: "20000000", depositAddress: "0x76b4c56085ED136a8744D52bE956396624a730E8" },
    };
    const fetch = fakeFetch({
      "GET /v0/tokens": () => json(tokens),
      "POST /v0/quote": (init) => json(JSON.parse(init?.body as string).dry ? dryResponse : usdcRoute),
    });
    const target = venue(fetch);
    const request: QuoteRequest = { ...ltcToSol, from: { asset: "eth:usdc", amount: "20", address: AGENT }, refundAddress: AGENT };
    const [route] = await target.quote(request);
    const swap = await target.prepare(route!, request);
    expect(swap.transactions).toEqual([
      {
        kind: "swap",
        chainId: 1,
        to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        // transfer(0x76b4…30E8, 20000000)
        data: "0xa9059cbb00000000000000000000000076b4c56085ed136a8744d52be956396624a730e80000000000000000000000000000000000000000000000000000000001312d00",
        value: "0x0",
      },
    ]);
    expect(swap.deposit?.address).toBe("0x76b4c56085ED136a8744D52bE956396624a730E8");
  });

  it("refuses to prepare a price check", async () => {
    const fetch = fakeFetch({ "GET /v0/tokens": () => json(tokens), "POST /v0/quote": () => json(dryResponse) });
    const target = venue(fetch);
    const [route] = await target.quote(ltcToSol);
    await expect(target.prepare(route!, { ...ltcToSol, indicative: true })).rejects.toThrow(VenueError);
  });
});

describe("near intents track", () => {
  const swapInput = (status: unknown) => {
    const fetch = fakeFetch({ "GET /v0/status": () => json(status) });
    const track = venue(fetch).track({
      route: {} as never,
      request: ltcToSol,
      prepared: { venueSwapId: DEPOSIT, transactions: [], deposit: { asset: "ltc:ltc", address: DEPOSIT, amount: "1" } },
      txHashes: [],
      venueSwapId: DEPOSIT,
    });
    return { fetch, track };
  };

  it("asks by deposit address and maps a waiting deposit", async () => {
    const { fetch, track } = swapInput(statusPending);
    expect(await track).toEqual({ status: "awaiting_deposit" });
    expect(new URL(fetch.mock.calls[0]![0]).searchParams.get("depositAddress")).toBe(DEPOSIT);
  });

  // Field names follow the 1Click OpenAPI schema; no finished swap of ours exists to record.
  const finished = (status: string, details: object) => ({
    ...statusPending,
    status,
    swapDetails: { ...statusPending.swapDetails, depositedAmountFormatted: "1.0", ...details },
  });

  it("reports what was delivered, with the hashes on both chains", async () => {
    const { track } = swapInput(
      finished("SUCCESS", {
        amountOutFormatted: "0.57509487",
        originChainTxHashes: [{ hash: "ltc-hash", explorerUrl: "" }],
        destinationChainTxHashes: [{ hash: "sol-hash", explorerUrl: "" }],
      }),
    );
    expect(await track).toEqual({ status: "completed", amountReceived: "0.57509487", amountSent: "1.0", txHashes: ["ltc-hash", "sol-hash"] });
  });

  it("reports a refund and its reason", async () => {
    const { track } = swapInput(finished("REFUNDED", { refundReason: "PARTIAL_DEPOSIT", refundedAmount: "100000000" }));
    expect(await track).toEqual({ status: "refunded", amountSent: "1.0", refundReason: "PARTIAL_DEPOSIT" });
  });

  it("flags a swap that returned part of the deposit", async () => {
    const { track } = swapInput(finished("SUCCESS", { amountOutFormatted: "0.5", refundedAmount: "1000" }));
    expect(await track).toMatchObject({ status: "completed", partialRefund: true });
  });

  it("maps every 1Click status", async () => {
    const expected: Record<string, string> = {
      KNOWN_DEPOSIT_TX: "confirming",
      INCOMPLETE_DEPOSIT: "awaiting_deposit",
      PROCESSING: "exchanging",
      FAILED: "failed",
    };
    for (const [status, mapped] of Object.entries(expected)) {
      expect((await swapInput(finished(status, {})).track).status).toBe(mapped);
    }
  });

  it("keeps waiting while 1Click hasn't seen the deposit address yet", async () => {
    const fetch = fakeFetch({ "GET /v0/status": () => json({ message: "not found" }, 404) });
    const result = await venue(fetch).track({
      route: {} as never,
      request: ltcToSol,
      prepared: { transactions: [], deposit: { asset: "ltc:ltc", address: DEPOSIT, amount: "1" } },
      txHashes: [],
      venueSwapId: null,
    });
    expect(result).toEqual({ status: "awaiting_deposit" });
  });
});
