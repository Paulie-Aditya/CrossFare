import { describe, expect, it } from "vitest";
import { UNISWAP_CHAINS, evmChainByCode, evmChainById } from "./evm-chains.ts";

describe("Uniswap chains", () => {
  it("covers every mainnet the Uniswap Trading API lists", () => {
    expect(UNISWAP_CHAINS.map((chain) => chain.chainId).sort((a, b) => a - b)).toEqual([
      1, 10, 56, 130, 137, 143, 196, 324, 480, 1868, 4217, 4326, 4663, 5042, 8453, 42161, 42220, 43114, 57073, 59144, 7777777,
    ]);
  });

  it("keeps SwapKit's chain codes where SwapKit has the chain, so asset IDs don't change", () => {
    expect(evmChainById(42161)?.code).toBe("arb");
    expect(evmChainById(4663)?.code).toBe("hood");
    expect(evmChainByCode("bsc")?.chainId).toBe(56);
  });

  it("gives each chain a unique code", () => {
    expect(new Set(UNISWAP_CHAINS.map((chain) => chain.code)).size).toBe(UNISWAP_CHAINS.length);
  });

  it("knows the wrapped native coin where one was checked on chain", () => {
    expect(evmChainById(1)?.wrappedNative).toBe("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
    expect(evmChainById(8453)?.wrappedNative).toBe("0x4200000000000000000000000000000000000006");
    expect(evmChainById(4663)?.wrappedNative).toBeUndefined();
  });

  it("has no native coin on chains whose gas is a stablecoin token", () => {
    expect(evmChainByCode("tempo")?.native).toBeUndefined();
    expect(evmChainByCode("arc")?.native).toBeUndefined();
    expect(evmChainByCode("pol")?.native).toEqual({ symbol: "pol", name: "Polygon", decimals: 18 });
  });

  it("links each chain to its explorer", () => {
    expect(evmChainByCode("unichain")?.explorer).toBe("https://uniscan.xyz");
  });

  it("answers undefined for a chain Uniswap doesn't trade on", () => {
    expect(evmChainById(100)).toBeUndefined();
    expect(evmChainByCode("gno")).toBeUndefined();
  });
});
