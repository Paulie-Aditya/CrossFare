import { describe, expect, it } from "vitest";
import { nativeHub, spendableAfterGas } from "./gas.ts";

describe("nativeHub", () => {
  it("knows a chain's gas coin by its asset ID", () => {
    expect(nativeHub("eth:eth")).toEqual({ chainId: 1, decimals: 18 });
    expect(nativeHub("bsc:bnb")).toEqual({ chainId: 56, decimals: 18 });
  });

  it("treats a token, or a chain the agent can't sign on, as no gas coin", () => {
    expect(nativeHub("eth:usdc")).toBeNull();
    expect(nativeHub("btc:btc")).toBeNull();
  });
});

describe("spendableAfterGas", () => {
  it("spends all that arrived when the wallet already had gas", () => {
    expect(spendableAfterGas(100n, 150n, 30n)).toBe(100n);
  });

  it("keeps back what the gas needs beyond what the wallet already had", () => {
    expect(spendableAfterGas(100n, 110n, 30n)).toBe(80n);
  });

  it("gives up when gas would take everything that arrived", () => {
    expect(spendableAfterGas(100n, 100n, 100n)).toBeNull();
  });
});
