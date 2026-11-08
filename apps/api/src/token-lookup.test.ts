import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetUnlistedAssets, getAsset, listAssets, resolveAssetId } from "@crossfare/core";
import { createStore } from "./store.ts";
import { createTokenLookup, type ReadToken } from "./token-lookup.ts";

const PASTED = "0x9999999999999999999999999999999999999999";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NOW = new Date("2026-11-09T10:00:00.000Z");

function setup(readToken: ReadToken) {
  const store = createStore(":memory:");
  let now = NOW;
  const lookup = createTokenLookup({ readToken, store, now: () => now });
  return { store, lookup, later: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

afterEach(() => forgetUnlistedAssets());

describe("token lookup", () => {
  it("answers a listed token from the catalog without touching the chain", async () => {
    const readToken = vi.fn<ReadToken>();
    const { lookup } = setup(readToken);
    expect((await lookup.find(8453, BASE_USDC.toLowerCase()))?.id).toBe("base:usdc");
    expect(readToken).not.toHaveBeenCalled();
  });

  it("reads an unlisted token from the chain, then resolves, stores and flags it", async () => {
    const { lookup, store } = setup(async () => ({ symbol: "PEPE", name: "Pepe", decimals: 18 }));
    const asset = await lookup.find(8453, PASTED);
    expect(asset).toMatchObject({
      id: `base:pepe-${PASTED}`,
      symbol: "PEPE",
      name: "Pepe",
      decimals: 18,
      unlisted: true,
      uniswap: { chainId: 8453, address: PASTED },
    });
    expect(asset).not.toHaveProperty("swapkit");
    expect(getAsset(asset!.id).unlisted).toBe(true);
    expect(resolveAssetId(`base:${PASTED}`)).toBe(asset!.id);
    expect(store.listUnlistedAssets().map((saved) => saved.id)).toEqual([asset!.id]);
    expect(listAssets().some((listed) => listed.id === asset!.id)).toBe(false);
  });

  it("tidies whatever a contract says its symbol and name are", async () => {
    const { lookup } = setup(async () => ({ symbol: "  FREE\u0000 CLAIM\n", name: "x".repeat(200), decimals: 6 }));
    const asset = await lookup.find(8453, PASTED);
    expect(asset?.symbol).toBe("FREE CLAIM");
    expect(asset?.name).toHaveLength(64);
  });

  it("names a token with no symbol by its contract's start", async () => {
    const { lookup } = setup(async () => ({ symbol: "", name: "", decimals: 18 }));
    expect((await lookup.find(8453, PASTED))?.symbol).toBe("0x9999…");
  });

  it("finds nothing on a chain Uniswap doesn't trade on, or at a malformed address", async () => {
    const readToken = vi.fn<ReadToken>();
    const { lookup } = setup(readToken);
    expect(await lookup.find(100, PASTED)).toBeNull();
    expect(await lookup.find(8453, "0x123")).toBeNull();
    expect(readToken).not.toHaveBeenCalled();
  });

  it("remembers a contract that isn't a token for a while, so repeat lookups don't hit the RPC", async () => {
    const readToken = vi.fn<ReadToken>(async () => null);
    const { lookup, later } = setup(readToken);
    expect(await lookup.find(8453, PASTED)).toBeNull();
    expect(await lookup.find(8453, PASTED)).toBeNull();
    expect(readToken).toHaveBeenCalledTimes(1);
    later(11 * 60_000);
    await lookup.find(8453, PASTED);
    expect(readToken).toHaveBeenCalledTimes(2);
  });

  it("doesn't remember an RPC failure, which says nothing about the token", async () => {
    const readToken = vi.fn<ReadToken>(async () => {
      throw new Error("rpc down");
    });
    const { lookup } = setup(readToken);
    expect(await lookup.find(8453, PASTED)).toBeNull();
    expect(await lookup.find(8453, PASTED)).toBeNull();
    expect(readToken).toHaveBeenCalledTimes(2);
  });

  it("rejects decimals no ERC-20 uses", async () => {
    const { lookup } = setup(async () => ({ symbol: "ODD", name: "Odd", decimals: 255 }));
    expect(await lookup.find(8453, PASTED)).toBeNull();
  });
});
