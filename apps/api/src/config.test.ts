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
      baseRpcUrl: "https://mainnet.base.org",
      port: 8787,
      databasePath: "crossfare.db",
    });
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
