import { describe, expect, it, vi } from "vitest";
import { createDepositWatcher } from "./deposit-watcher.ts";

const usdc = { asset: "eth:usdc", address: "0xdeposit", amount: "5" };
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

function reader(balance: bigint) {
  return { tokenBalance: vi.fn(async () => balance), nativeBalance: vi.fn(async () => balance) };
}

describe("deposit watcher", () => {
  it("sees a token deposit in the deposit address", async () => {
    const eth = reader(5_000_000n);
    expect(await createDepositWatcher({ 1: eth })(usdc)).toBe(true);
    expect(eth.tokenBalance).toHaveBeenCalledWith(USDC, "0xdeposit");
  });

  it("sees a native deposit", async () => {
    const eth = reader(1_000_000_000_000_000_000n);
    expect(await createDepositWatcher({ 1: eth })({ asset: "eth:eth", address: "0xdeposit", amount: "1" })).toBe(true);
    expect(eth.nativeBalance).toHaveBeenCalledWith("0xdeposit");
  });

  it("counts a deposit reduced by an exchange's withdrawal fee", async () => {
    expect(await createDepositWatcher({ 1: reader(4_900_000n) })(usdc)).toBe(true);
  });

  it("ignores an empty address and leftover dust", async () => {
    expect(await createDepositWatcher({ 1: reader(0n) })(usdc)).toBe(false);
    expect(await createDepositWatcher({ 1: reader(1_000n) })(usdc)).toBe(false);
  });

  it("answers false for a chain it can't read", async () => {
    expect(await createDepositWatcher({})(usdc)).toBe(false);
    expect(await createDepositWatcher({ 1: reader(5n) })({ asset: "btc:btc", address: "bc1q", amount: "1" })).toBe(false);
  });
});
