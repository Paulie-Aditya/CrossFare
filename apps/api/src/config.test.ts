import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

const env = {
  UNISWAP_API_KEY: "u",
  SWAPKIT_API_KEY: "s",
  ARKIV_PRIVATE_KEY: "0xabc",
  ARKIV_ACCESS_KEY: "a",
  HEDERA_OPERATOR_ID: "0.0.1",
  HEDERA_OPERATOR_KEY: "k",
  HEDERA_PAY_TO_ACCOUNT: "0.0.2",
  HEDERA_HCS_TOPIC_ID: "0.0.3",
};

describe("loadConfig", () => {
  it("applies defaults for the public values", () => {
    expect(loadConfig(env)).toMatchObject({
      usdcTokenId: "0.0.429274",
      facilitatorUrl: "https://x402.org/facilitator",
      rpcUrls: {},
      port: 8787,
      databasePath: "crossfare.db",
    });
  });

  it("takes an RPC for any chain by its ID, keeping the older Base and Ethereum names", () => {
    const config = loadConfig({
      ...env,
      BASE_RPC_URL: "https://base.example",
      ETHEREUM_RPC_URL: "https://eth.example",
      RPC_URL_42161: "https://arb.example",
      RPC_URL_8453: "https://base-override.example",
      RPC_URL_x: "https://ignored.example",
      RPC_URL_10: "",
    });
    expect(config.rpcUrls).toEqual({ 1: "https://eth.example", 8453: "https://base-override.example", 42161: "https://arb.example" });
  });

  it("pays for the demo from the agent's account unless told otherwise", () => {
    const config = loadConfig({ ...env, AGENT_HEDERA_ACCOUNT: "0.0.7", AGENT_HEDERA_KEY: "agentkey" });
    expect(config.demo).toEqual({
      accountId: "0.0.7",
      privateKey: "agentkey",
      limits: { perIpPerHour: 20, perDay: 200 },
    });
    const own = loadConfig({
      ...env,
      AGENT_HEDERA_ACCOUNT: "0.0.7",
      AGENT_HEDERA_KEY: "agentkey",
      DEMO_HEDERA_ACCOUNT: "0.0.8",
      DEMO_HEDERA_KEY: "demokey",
      DEMO_LIMIT_PER_IP_HOUR: "5",
      DEMO_LIMIT_PER_DAY: "50",
    });
    expect(own.demo).toEqual({ accountId: "0.0.8", privateKey: "demokey", limits: { perIpPerHour: 5, perDay: 50 } });
  });

  it("leaves the demo off with no account to pay from", () => {
    expect(loadConfig(env).demo).toBeNull();
  });

  it("finds the built UI", () => {
    expect(loadConfig(env).webRoot).toBe("../web/dist");
  });

  it("names every missing secret, and never prints a value", () => {
    const { UNISWAP_API_KEY: _u, HEDERA_OPERATOR_KEY: _k, ...partial } = env;
    expect(() => loadConfig(partial)).toThrow(/UNISWAP_API_KEY.*HEDERA_OPERATOR_KEY/);
    expect(() => loadConfig(partial)).not.toThrow(/0xabc/);
  });

  it("rejects an Arkiv key that isn't hex", () => {
    expect(() => loadConfig({ ...env, ARKIV_PRIVATE_KEY: "nope" })).toThrow(/ARKIV_PRIVATE_KEY/);
  });
});

describe("direct venues", () => {
  it("stay off until a fee recipient is set, so SwapKit keeps every provider", () => {
    expect(loadConfig(env)).toMatchObject({ nearIntents: null, thorchain: null });
  });

  it("turn on NEAR Intents with its fee, and a partner key when there is one", () => {
    expect(loadConfig({ ...env, NEAR_INTENTS_FEE_RECIPIENT: "crossfare.near", NEAR_INTENTS_FEE_BPS: "50" }).nearIntents).toEqual({
      feeRecipient: "crossfare.near",
      feeBps: 50,
    });
    expect(
      loadConfig({ ...env, NEAR_INTENTS_FEE_RECIPIENT: "crossfare.near", NEAR_INTENTS_FEE_BPS: "50", NEAR_INTENTS_API_KEY: "k" }).nearIntents,
    ).toMatchObject({ apiKey: "k" });
  });

  it("turn on THORChain with its affiliate name and fee, on a chosen node", () => {
    expect(
      loadConfig({ ...env, THORCHAIN_AFFILIATE: "cf", THORCHAIN_AFFILIATE_BPS: "50", THORNODE_URL: "https://node.example" }).thorchain,
    ).toEqual({ affiliate: "cf", affiliateBps: 50, thornodeUrl: "https://node.example" });
  });

  it("refuse a fee that isn't whole basis points in each venue's range", () => {
    expect(() => loadConfig({ ...env, NEAR_INTENTS_FEE_RECIPIENT: "x.near" })).toThrow(/NEAR_INTENTS_FEE_BPS/);
    expect(() => loadConfig({ ...env, NEAR_INTENTS_FEE_RECIPIENT: "x.near", NEAR_INTENTS_FEE_BPS: "501" })).toThrow(/NEAR_INTENTS_FEE_BPS/);
    expect(() => loadConfig({ ...env, THORCHAIN_AFFILIATE: "cf", THORCHAIN_AFFILIATE_BPS: "0.5" })).toThrow(/THORCHAIN_AFFILIATE_BPS/);
    expect(() => loadConfig({ ...env, THORCHAIN_AFFILIATE: "cf", THORCHAIN_AFFILIATE_BPS: "1001" })).toThrow(/THORCHAIN_AFFILIATE_BPS/);
  });
});
