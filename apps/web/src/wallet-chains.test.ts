import { describe, expect, it } from "vitest";
// The web build stands alone, so it keeps its own list. This catches the two drifting apart.
import { UNISWAP_CHAINS } from "../../../packages/core/src/evm-chains.ts";
import { WALLET_CHAINS, walletChain } from "./wallet-chains.ts";

describe("wallet chains", () => {
  it("match the chains the API quotes Uniswap on, code for code", () => {
    const pairs = (list: readonly { code: string; chainId: number }[]) => list.map((entry) => `${entry.code}:${entry.chainId}`).sort();
    expect(pairs(WALLET_CHAINS.map((entry) => ({ code: entry.code, chainId: entry.chain.id })))).toEqual(pairs(UNISWAP_CHAINS));
  });

  it("finds a chain by its Crossfare code", () => {
    expect(walletChain("arb")?.id).toBe(42161);
    expect(walletChain("btc")).toBeUndefined();
  });
});
