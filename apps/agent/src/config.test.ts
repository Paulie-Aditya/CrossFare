import { describe, expect, it, vi } from "vitest";
import { loadAgentConfig, resolveGoal } from "./config.ts";

const env = {
  AGENT_HEDERA_ACCOUNT: "0.0.5",
  AGENT_HEDERA_KEY: "key",
  AGENT_EVM_PRIVATE_KEY: "0xabc",
  ARKIV_ACCESS_KEY: "a",
  AGENT_ALLOWED_PAY_TO: "0.0.999, 0.0.1000",
};

describe("loadAgentConfig", () => {
  it("defaults to safe limits with live swaps off", () => {
    expect(loadAgentConfig(env)).toMatchObject({
      apiUrl: "http://localhost:8787",
      allowLiveSwaps: false,
      perCallCap: 100_000n,
      totalBudget: 200_000n,
      allowedPayTo: ["0.0.999", "0.0.1000"],
      usdcTokenId: "0.0.429274",
    });
  });

  it("enables live swaps only on the exact value", () => {
    expect(loadAgentConfig({ ...env, AGENT_ALLOW_LIVE_SWAPS: "1" }).allowLiveSwaps).toBe(false);
    expect(loadAgentConfig({ ...env, AGENT_ALLOW_LIVE_SWAPS: "true" }).allowLiveSwaps).toBe(true);
  });

  it("requires an explicit payment allowlist", () => {
    const { AGENT_ALLOWED_PAY_TO: _omitted, ...partial } = env;
    expect(() => loadAgentConfig(partial)).toThrow(/AGENT_ALLOWED_PAY_TO/);
  });
});

describe("resolveGoal", () => {
  const SENDER = "0xC9bebBA9f481b12cE6f3EA54c4B182c9636ec421";
  const RECEIVER = "0x6dF69A2C97F8cFcBe5a04891ae0122942b8C24D1";
  const swap = ["--from", "eth:usdc", "--to", "base:eth", "--amount", "20"];
  const never = () => Promise.reject(new Error("should not ask"));

  it("asks for the receiving address and never assumes its own", async () => {
    const ask = vi.fn(async () => RECEIVER);
    const goal = await resolveGoal(swap, SENDER, ask);
    expect(ask).toHaveBeenCalledWith(expect.stringMatching(/receiving address on base/i));
    expect(goal).toEqual({
      from: { asset: "eth:usdc", amount: "20", address: SENDER },
      to: { asset: "base:eth", address: RECEIVER },
      slippageBps: 300,
      refundAddress: SENDER,
    });
  });

  it("asks again after an address that doesn't fit the chain", async () => {
    const ask = vi.fn<() => Promise<string>>().mockResolvedValueOnce("bc1qwrongchain").mockResolvedValueOnce(RECEIVER);
    const goal = await resolveGoal(swap, SENDER, ask);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(goal.to.address).toBe(RECEIVER);
  });

  it("gives up after three bad answers, without guessing", async () => {
    const ask = vi.fn(async () => "nope");
    await expect(resolveGoal(swap, SENDER, ask)).rejects.toThrow(/receiving address/);
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("takes a receiving address from the command line without asking", async () => {
    const goal = await resolveGoal([...swap, "--recipient", RECEIVER], SENDER, never);
    expect(goal.to.address).toBe(RECEIVER);
  });

  it("refuses a command-line address that doesn't fit the chain", async () => {
    await expect(resolveGoal([...swap, "--recipient", "bc1qwrongchain"], SENDER, never)).rejects.toThrow(/receiving address/);
  });

  it("uses tighter default slippage on the same chain, and honours an explicit value", async () => {
    const same = ["--from", "base:usdc", "--to", "base:eth", "--amount", "1", "--recipient", RECEIVER];
    expect((await resolveGoal(same, SENDER, never)).slippageBps).toBe(50);
    expect((await resolveGoal([...same, "--slippage-bps", "100"], SENDER, never)).slippageBps).toBe(100);
  });

  it("requires a pair and amount", async () => {
    await expect(resolveGoal(["--from", "base:eth"], SENDER, never)).rejects.toThrow(/--to/);
  });
});
