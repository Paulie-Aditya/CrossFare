import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getAsset, registerAssets, type Asset } from "../assets.ts";
import { JUPITER_PRICE_TAKER, WSOL_MINT, createJupiterVenue, type SolanaReader } from "./jupiter.ts";
import type { FetchLike, QuoteRequest } from "./types.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/jupiter/${name}.json`, import.meta.url), "utf8"));
// 0.01 SOL to USDC through Raydium, recorded 11 November, without and with a 50 bps fee.
const build = fixture("build-sol-usdc");
const buildWithFee = fixture("build-sol-usdc-fee");

const WALLET = "GZRiD2TR1oiSXXFDsGhLR5fZWbfHqY9KyfHkiChUuVBR";
const FEE_WALLET = "FeeWa11et1111111111111111111111111111111111";
const FEE_ACCOUNT = "CeZCzj2zHBt9X2BCuywcXjp9WwWm1YJosicMmYuwwLnM";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const NOW = new Date("2026-11-11T10:00:00.000Z");

const SOL: Asset = { id: "sol:sol", chain: "sol", symbol: "SOL", decimals: 9, swapkit: "SOL.SOL", swapkitChain: "solana" };
const USDC: Asset = { id: `sol:usdc-${USDC_MINT.toLowerCase()}`, chain: "sol", symbol: "USDC", decimals: 6, swapkit: `SOL.USDC-${USDC_MINT}`, swapkitChain: "solana" };

beforeAll(() => registerAssets([SOL, USDC]));

const request = (extra: Partial<QuoteRequest> = {}): QuoteRequest => ({
  from: { asset: "sol:sol", amount: "0.01", address: WALLET },
  to: { asset: USDC.id, address: WALLET },
  mode: "exact_in",
  slippageBps: 100,
  ...extra,
});

function fakeFetch(body: unknown = build, status = 200) {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
}

const builtUrl = (fetch: ReturnType<typeof fakeFetch>) => new URL(fetch.mock.calls[0]![0]);

function reader(overrides: Partial<SolanaReader> = {}): SolanaReader {
  return {
    feeTokenAccount: vi.fn(async (_owner: string, mint: string) => (mint === USDC_MINT ? FEE_ACCOUNT : null)),
    getTransaction: vi.fn(async () => null),
    ...overrides,
  };
}

const assemble = vi.fn(async () => ({ transaction: "AQAB-unsigned", lastValidBlockHeight: 445860101 }));

const venue = (fetch = fakeFetch(), extra: Partial<Parameters<typeof createJupiterVenue>[0]> = {}) =>
  createJupiterVenue({ fetch: fetch as unknown as FetchLike, now: () => NOW, solana: reader(), assemble, ...extra });

describe("Jupiter venue", () => {
  it("serves two tokens on Solana only", () => {
    const jupiter = venue();
    expect(jupiter.serves?.(getAsset("sol:sol"), getAsset(USDC.id))).toBe(true);
    expect(jupiter.serves?.(getAsset("sol:sol"), getAsset("eth:eth"))).toBe(false);
  });

  it("builds the swap for the wallet, naming SOL by its wrapped mint", async () => {
    const fetch = fakeFetch();
    await venue(fetch).quote(request());
    const url = builtUrl(fetch);
    expect(`${url.origin}${url.pathname}`).toBe("https://api.jup.ag/swap/v2/build");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      inputMint: WSOL_MINT,
      outputMint: USDC_MINT,
      amount: "10000000",
      taker: WALLET,
      slippageBps: "100",
    });
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("x-api-key")).toBeNull();
  });

  it("sends the API key when there is one", async () => {
    const fetch = fakeFetch();
    await venue(fetch, { apiKey: "k" }).quote(request());
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("x-api-key")).toBe("k");
  });

  it("returns the route's expected and guaranteed amounts", async () => {
    const [route, ...rest] = await venue().quote(request());
    expect(rest).toEqual([]);
    expect(route).toMatchObject({
      venue: "jupiter",
      from: "sol:sol",
      to: USDC.id,
      amountIn: "10000000",
      amountOut: build.outAmount,
      minAmountOut: build.otherAmountThreshold,
      validUntil: "2026-11-11T10:01:00.000Z",
    });
  });

  it("pays the caller's fee into their token account for the output, and quotes what's left", async () => {
    const fetch = fakeFetch(buildWithFee);
    const solana = reader();
    const [route] = await venue(fetch, { solana }).quote(request({ fee: { bps: 50, recipients: { solana: FEE_WALLET } } }));
    expect(solana.feeTokenAccount).toHaveBeenCalledWith(FEE_WALLET, USDC_MINT);
    expect(builtUrl(fetch).searchParams.get("platformFeeBps")).toBe("50");
    expect(builtUrl(fetch).searchParams.get("feeAccount")).toBe(FEE_ACCOUNT);
    expect(route).toMatchObject({ amountOut: buildWithFee.outAmount, minAmountOut: buildWithFee.otherAmountThreshold, fees: { integrator: "0.004116 USDC" } });
  });

  it("takes the fee in the input token when the caller only holds an account for that", async () => {
    const fetch = fakeFetch(buildWithFee);
    const solana = reader({ feeTokenAccount: vi.fn(async (_owner: string, mint: string) => (mint === WSOL_MINT ? "WsolFeeAccount" : null)) });
    await venue(fetch, { solana }).quote(request({ fee: { bps: 50, recipients: { solana: FEE_WALLET } } }));
    expect(builtUrl(fetch).searchParams.get("feeAccount")).toBe("WsolFeeAccount");
  });

  it("charges no fee when the caller has no account to receive it, since the swap would fail", async () => {
    const fetch = fakeFetch();
    const solana = reader({ feeTokenAccount: vi.fn(async () => null) });
    await venue(fetch, { solana }).quote(request({ fee: { bps: 50, recipients: { solana: FEE_WALLET } } }));
    expect(builtUrl(fetch).searchParams.has("platformFeeBps")).toBe(false);
  });

  it("can't deliver to another wallet, so it doesn't quote one", async () => {
    const fetch = fakeFetch();
    const routes = await venue(fetch).quote(request({ to: { asset: USDC.id, address: FEE_WALLET } }));
    expect(routes).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("prices for a stand-in wallet, and such a route can't be executed", async () => {
    const fetch = fakeFetch();
    const jupiter = venue(fetch);
    const price = request({ indicative: true, from: { asset: "sol:sol", amount: "0.01", address: "" }, to: { asset: USDC.id, address: "" } });
    const [route] = await jupiter.quote(price);
    expect(builtUrl(fetch).searchParams.get("taker")).toBe(JUPITER_PRICE_TAKER);
    await expect(jupiter.prepare(route!, price)).rejects.toMatchObject({ venue: "jupiter", status: 422 });
  });

  it("finds nothing for an exact output or an unroutable pair", async () => {
    expect(await venue().quote(request({ mode: "exact_out" }))).toEqual([]);
    expect(await venue(fakeFetch({ error: "No routes found" }, 400)).quote(request())).toEqual([]);
  });

  it("reports rate limiting as a venue error", async () => {
    await expect(venue(fakeFetch({ message: "Too many requests" }, 429)).quote(request())).rejects.toMatchObject({ venue: "jupiter", status: 429 });
  });

  it("prepares an unsigned Solana transaction for the wallet to sign and send", async () => {
    const jupiter = venue();
    const req = request();
    const [route] = await jupiter.quote(req);
    expect(await jupiter.prepare(route!, req)).toEqual({ transactions: [], solana: { transaction: "AQAB-unsigned", lastValidBlockHeight: 445860101 } });
    expect(assemble).toHaveBeenCalledWith(build, WALLET);
  });

  describe("tracking", () => {
    async function tracked(outcome: Awaited<ReturnType<SolanaReader["getTransaction"]>>, txHashes = ["5sig"], asset = USDC.id) {
      const solana = reader({ getTransaction: vi.fn(async () => outcome) });
      const jupiter = venue(fakeFetch(), { solana });
      const req = request({ to: { asset, address: WALLET } });
      const [route] = await jupiter.quote(req);
      return jupiter.track({ route: route!, request: req, prepared: { transactions: [] }, txHashes, venueSwapId: null });
    }
    const landed = { failed: false, feePayer: WALLET, tokenChanges: [{ owner: WALLET, mint: USDC_MINT, change: "823368" }] };

    it("waits for the signature", async () => {
      expect(await tracked(landed, [])).toEqual({ status: "awaiting_deposit" });
    });

    it("waits for the transaction to land", async () => {
      expect(await tracked(null)).toEqual({ status: "confirming" });
    });

    it("reads what the wallet received", async () => {
      expect(await tracked(landed)).toEqual({ status: "completed", amountReceived: "0.823368", txHashes: ["5sig"] });
    });

    it("fails a transaction that errored", async () => {
      expect(await tracked({ ...landed, failed: true })).toEqual({ status: "failed" });
    });

    it("ignores a signature that isn't this wallet's", async () => {
      expect(await tracked({ ...landed, feePayer: FEE_WALLET })).toEqual({ status: "confirming" });
    });
  });
});
