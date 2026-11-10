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
  it("stay off unless turned on, so SwapKit keeps every provider", () => {
    expect(loadConfig(env)).toMatchObject({ nearIntents: null, thorchain: null, pancakeswap: false });
  });

  it("turn on PancakeSwap, which needs no key", () => {
    expect(loadConfig({ ...env, PANCAKESWAP_DIRECT: "true" }).pancakeswap).toBe(true);
  });

  it("turn on NEAR Intents, with a partner key when there is one", () => {
    expect(loadConfig({ ...env, NEAR_INTENTS_DIRECT: "true" }).nearIntents).toEqual({});
    expect(loadConfig({ ...env, NEAR_INTENTS_DIRECT: "true", NEAR_INTENTS_API_KEY: "k" }).nearIntents).toEqual({ apiKey: "k" });
  });

  it("turn on THORChain, on a chosen node", () => {
    expect(loadConfig({ ...env, THORCHAIN_DIRECT: "true", THORNODE_URL: "https://node.example" }).thorchain).toEqual({
      thornodeUrl: "https://node.example",
    });
  });

  it("refuse the old fee settings, because callers now set their own fee", () => {
    for (const name of ["NEAR_INTENTS_FEE_RECIPIENT", "THORCHAIN_AFFILIATE", "UNISWAP_FEE_RECIPIENT"]) {
      expect(() => loadConfig({ ...env, [name]: "x" })).toThrow(new RegExp(name));
    }
  });
});
