import { describe, expect, it, vi } from "vitest";
import { createDepositWatcher } from "./deposit-watcher.ts";

const usdc = { asset: "eth:usdc", address: "0xdeposit" };
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

function reader(balance: bigint) {
  return { tokenBalance: vi.fn(async () => balance), nativeBalance: vi.fn(async () => balance) };
}

describe("deposit watcher", () => {
  it("reads a token balance as a decimal amount", async () => {
    const eth = reader(4_900_000n);
    expect(await createDepositWatcher({ 1: eth })(usdc)).toBe("4.9");
    expect(eth.tokenBalance).toHaveBeenCalledWith(USDC, "0xdeposit");
  });

  it("reads a native balance", async () => {
    const eth = reader(1_500_000_000_000_000_000n);
    expect(await createDepositWatcher({ 1: eth })({ asset: "eth:eth", address: "0xdeposit" })).toBe("1.5");
    expect(eth.nativeBalance).toHaveBeenCalledWith("0xdeposit");
  });

  it("answers null for an empty address", async () => {
    expect(await createDepositWatcher({ 1: reader(0n) })(usdc)).toBeNull();
  });

  it("answers null for a chain it can't read", async () => {
    expect(await createDepositWatcher({})(usdc)).toBeNull();
    expect(await createDepositWatcher({ 1: reader(5n) })({ asset: "btc:btc", address: "bc1q" })).toBeNull();
  });
});
