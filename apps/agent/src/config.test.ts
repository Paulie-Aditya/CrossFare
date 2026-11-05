import { describe, expect, it } from "vitest";
import { loadAgentConfig, parseGoalArgs } from "./config.ts";

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

describe("parseGoalArgs", () => {
  it("defaults the recipient and refund address to the sender", () => {
    expect(parseGoalArgs(["--from", "base:usdc", "--to", "base:eth", "--amount", "1"], "0xme")).toEqual({
      from: { asset: "base:usdc", amount: "1", address: "0xme" },
      to: { asset: "base:eth", address: "0xme" },
      slippageBps: 50,
      refundAddress: "0xme",
    });
  });

  it("takes a recipient and slippage", () => {
    const goal = parseGoalArgs(
      ["--from", "base:eth", "--to", "btc:btc", "--amount", "0.01", "--recipient", "bc1q", "--slippage-bps", "300"],
      "0xme",
    );
    expect(goal.to.address).toBe("bc1q");
    expect(goal.slippageBps).toBe(300);
  });

  it("requires a pair and amount", () => {
    expect(() => parseGoalArgs(["--from", "base:eth"], "0xme")).toThrow(/--to/);
  });
});
