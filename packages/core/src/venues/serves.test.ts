import { beforeAll, describe, expect, it, vi } from "vitest";
import { getAsset, registerAssets, type Asset } from "../assets.ts";
import { createNearIntentsVenue } from "./near-intents.ts";
import { createSwapKitVenue } from "./swapkit.ts";
import { createThorchainVenue } from "./thorchain.ts";
import { createUniswapVenue } from "./uniswap.ts";
import type { FetchLike } from "./types.ts";

// A token only Uniswap lists, the kind a two-leg route exists for.
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

const pair = (from: string, to: string) => [getAsset(from), getAsset(to)] as const;
const noNetwork = vi.fn(async () => {
  throw new Error("serves must not touch the network");
}) as unknown as FetchLike;

describe("Venue.serves", () => {
  it("Uniswap serves two of its tokens on the same chain only", () => {
    const venue = createUniswapVenue({ apiKey: "k", fetch: noNetwork });
    expect(venue.serves?.(...pair("eth:eth", "eth:pepe"))).toBe(true);
    expect(venue.serves?.(...pair("base:eth", "eth:pepe"))).toBe(false);
    expect(venue.serves?.(...pair("bsc:bnb", "eth:eth"))).toBe(false);
  });

  it("SwapKit serves any two tokens on its lists", () => {
    const venue = createSwapKitVenue({ apiKey: "k", fetch: noNetwork });
    expect(venue.serves?.(...pair("bsc:bnb", "eth:eth"))).toBe(true);
    expect(venue.serves?.(...pair("bsc:bnb", "eth:pepe"))).toBe(false);
  });

  it("NEAR Intents serves tokens on chains 1Click reaches", () => {
    const venue = createNearIntentsVenue({ fetch: noNetwork });
    expect(venue.serves?.(...pair("btc:btc", "eth:eth"))).toBe(true);
    expect(venue.serves?.(...pair("btc:btc", "eth:pepe"))).toBe(true);
  });

  it("THORChain serves tokens with a pool name, before it has read the pools", () => {
    const venue = createThorchainVenue({ fetch: noNetwork });
    expect(venue.serves?.(...pair("btc:btc", "eth:eth"))).toBe(true);
    expect(venue.serves?.(...pair("btc:btc", "eth:pepe"))).toBe(false);
  });

  it("THORChain checks the pools once it has read them", async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify([
        { asset: "BTC.BTC", status: "Available" },
        { asset: "ETH.ETH", status: "Available" },
      ])),
    ) as unknown as FetchLike;
    const venue = createThorchainVenue({ fetch });
    // A quote for an unpooled pair reads the pools and stops there.
    await venue.quote({
      from: { asset: "bsc:bnb", amount: "1", address: "" },
      to: { asset: "eth:eth", address: "" },
      mode: "exact_in",
      slippageBps: 100,
      indicative: true,
    });
    expect(venue.serves?.(...pair("btc:btc", "eth:eth"))).toBe(true);
    expect(venue.serves?.(...pair("bsc:bnb", "eth:eth"))).toBe(false);
  });
});
