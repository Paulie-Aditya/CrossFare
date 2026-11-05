import { describe, expect, it } from "vitest";
import { getAsset, listAssets, parseAssetId, toBaseUnits } from "./assets.ts";

describe("parseAssetId", () => {
  it("splits a chain:symbol id", () => {
    expect(parseAssetId("base:usdc")).toEqual({ chain: "base", symbol: "usdc" });
  });

  it.each(["usdc", "base:", ":usdc", "base:usdc:x", "BASE:USDC"])("rejects %s", (id) => {
    expect(() => parseAssetId(id)).toThrow(/invalid asset id/i);
  });
});

describe("getAsset", () => {
  it("maps base:usdc to both venues", () => {
    expect(getAsset("base:usdc")).toMatchObject({
      id: "base:usdc",
      decimals: 6,
      uniswap: { chainId: 8453, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
      swapkit: "BASE.USDC-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    });
  });

  it("maps native ETH on Base to the zero address for Uniswap", () => {
    expect(getAsset("base:eth").uniswap?.address).toBe(
      "0x0000000000000000000000000000000000000000",
    );
  });

  it("has no Uniswap mapping for non-EVM assets", () => {
    expect(getAsset("btc:btc")).toMatchObject({ swapkit: "BTC.BTC", decimals: 8 });
    expect(getAsset("btc:btc").uniswap).toBeUndefined();
  });

  it("throws on an unknown asset", () => {
    expect(() => getAsset("base:doge")).toThrow(/unsupported asset/i);
  });
});

describe("listAssets", () => {
  it("includes every PRD example id", () => {
    const ids = listAssets().map((a) => a.id);
    expect(ids).toEqual(
      expect.arrayContaining(["eth:usdc", "base:eth", "base:usdc", "sol:sol", "xrp:xrp", "btc:btc"]),
    );
  });
});

describe("toBaseUnits", () => {
  it("converts a decimal string using the asset's decimals", () => {
    expect(toBaseUnits("1.5", 6)).toBe(1_500_000n);
    expect(toBaseUnits("0.00000001", 8)).toBe(1n);
    expect(toBaseUnits("25", 6)).toBe(25_000_000n);
  });

  it("truncates extra precision rather than rounding up", () => {
    expect(toBaseUnits("1.1234567", 6)).toBe(1_123_456n);
  });

  it.each(["", "abc", "-1", "1.2.3"])("rejects %j", (value) => {
    expect(() => toBaseUnits(value, 6)).toThrow(/invalid amount/i);
  });
});
