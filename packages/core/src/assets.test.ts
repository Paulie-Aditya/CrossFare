import { describe, expect, it } from "vitest";
import { displaySymbol, getAsset, isValidAddress, listAssets, parseAssetId, toBaseUnits } from "./assets.ts";

describe("parseAssetId", () => {
  it("splits a chain:symbol id", () => {
    expect(parseAssetId("base:usdc")).toEqual({ chain: "base", symbol: "usdc" });
  });

  it.each(["usdc", "base:", ":usdc", "base:usdc:x", "BASE:USDC", "base:us dc"])("rejects %s", (id) => {
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

  it.each([
    ["base:eth", "8453"],
    ["eth:usdc", "1"],
    ["btc:btc", "bitcoin"],
    ["sol:sol", "solana"],
    ["xrp:xrp", "ripple"],
  ])("gives %s the SwapKit chain %s", (id, chain) => {
    expect(getAsset(id).swapkitChain).toBe(chain);
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

describe("isValidAddress", () => {
  it.each([
    ["base:eth", "0x6dF69A2C97F8cFcBe5a04891ae0122942b8C24D1"],
    ["eth:usdc", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"],
    ["btc:btc", "357a3So9CbsNfBBgFYACGvxxS6tMaDoa1P"],
    ["btc:btc", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"],
    ["sol:sol", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
    ["xrp:xrp", "rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh"],
  ])("accepts a %s address", (asset, address) => {
    expect(isValidAddress(asset, address)).toBe(true);
  });

  it.each([
    ["base:eth", "357a3So9CbsNfBBgFYACGvxxS6tMaDoa1P"],
    ["base:eth", "0x123"],
    ["btc:btc", "0x6dF69A2C97F8cFcBe5a04891ae0122942b8C24D1"],
    ["sol:sol", "0x6dF69A2C97F8cFcBe5a04891ae0122942b8C24D1"],
    ["xrp:xrp", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
    ["base:eth", ""],
  ])("rejects %s address %s", (asset, address) => {
    expect(isValidAddress(asset, address)).toBe(false);
  });
});

describe("display details", () => {
  it("gives built-in assets a logo", () => {
    expect(getAsset("eth:usdc").logo).toBe("https://tokens.swapkit.dev/images/eth.usdc-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.png");
  });

  it("accepts an id that holds a contract", () => {
    expect(parseAssetId("arb:1inch-0xabc")).toEqual({ chain: "arb", symbol: "1inch-0xabc" });
  });

  it("writes a symbol in capitals unless the ticker has its own casing", () => {
    expect(displaySymbol("usdc")).toBe("USDC");
    expect(displaySymbol("cbBTC")).toBe("cbBTC");
  });
});

