import { describe, expect, it } from "vitest";
import { chainFor } from "./chains.ts";

describe("chainFor", () => {
  const rpcUrls = { 1: "https://eth.example", 8453: "https://base.example" };

  it("signs on Ethereum and Base, each through its own RPC", () => {
    expect(chainFor(1, rpcUrls)).toMatchObject({ chain: { id: 1 }, rpcUrl: "https://eth.example" });
    expect(chainFor(8453, rpcUrls)).toMatchObject({ chain: { id: 8453 }, rpcUrl: "https://base.example" });
  });

  it("signs on any other chain Uniswap trades on, through its public RPC unless one is set", () => {
    expect(chainFor(42161, rpcUrls)).toMatchObject({ chain: { id: 42161 }, rpcUrl: "https://arb1.arbitrum.io/rpc" });
    expect(chainFor(130, { ...rpcUrls, 130: "https://unichain.example" }).rpcUrl).toBe("https://unichain.example");
  });

  it("refuses any other chain rather than signing blind", () => {
    expect(() => chainFor(100, rpcUrls)).toThrow(/100/);
  });
});
