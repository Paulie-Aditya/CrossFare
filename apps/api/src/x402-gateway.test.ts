import { describe, expect, it, vi } from "vitest";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import { createX402Gateway } from "./x402-gateway.ts";

const USDC = "0.0.429274";
const ENDPOINT = { key: "POST /v1/quote", priceUsd: "0.01", description: "quotes" };
const URL_ = "https://crossfare.test/v1/quote";
const NETWORK = "hedera:testnet";

function facilitator(overrides: Partial<FacilitatorClient> = {}): FacilitatorClient {
  return {
    getSupported: async () => ({
      kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK, extra: { feePayer: "0.0.9185802" } }],
      extensions: [],
      signers: {},
    }),
    verify: async () => ({ isValid: true, payer: "0.0.51234" }),
    settle: async () => ({ success: true, transaction: "0.0.9185802@1.2", network: NETWORK, payer: "0.0.51234" }),
    ...overrides,
  };
}

async function gateway(client = facilitator()) {
  return createX402Gateway({ facilitator: client, payTo: "0.0.999", usdcTokenId: USDC });
}

async function paymentHeader() {
  const g = await gateway();
  const { headers } = await g.paymentRequired(ENDPOINT, URL_);
  const required = decodePaymentRequiredHeader(headers["PAYMENT-REQUIRED"]!);
  return encodePaymentSignatureHeader({
    x402Version: 2,
    resource: required.resource,
    accepted: required.accepts[0]!,
    payload: { transaction: "base64-partially-signed" },
  });
}

describe("x402 gateway", () => {
  it("advertises USDC on Hedera testnet with the facilitator fee payer", async () => {
    const { headers } = await (await gateway()).paymentRequired(ENDPOINT, URL_);
    const required = decodePaymentRequiredHeader(headers["PAYMENT-REQUIRED"]!);
    expect(required.accepts[0]).toMatchObject({
      scheme: "exact",
      network: NETWORK,
      asset: USDC,
      amount: "10000",
      payTo: "0.0.999",
      extra: { feePayer: "0.0.9185802" },
    });
    expect(required.resource?.url).toBe(URL_);
  });

  it("returns the requirements in the body too", async () => {
    const { body } = await (await gateway()).paymentRequired(ENDPOINT, URL_, "bad signature");
    expect(body).toMatchObject({ x402Version: 2, error: "bad signature" });
  });

  it("reports a valid payment and its payer", async () => {
    const result = await (await gateway()).verify(await paymentHeader(), ENDPOINT, URL_);
    expect(result).toEqual({ valid: true, payer: "0.0.51234" });
  });

  it("reports the facilitator's reason for an invalid payment", async () => {
    const client = facilitator({ verify: async () => ({ isValid: false, invalidReason: "insufficient_funds" }) });
    const result = await (await gateway(client)).verify(await paymentHeader(), ENDPOINT, URL_);
    expect(result).toEqual({ valid: false, reason: "insufficient_funds" });
  });

  it("rejects a malformed header without calling the facilitator", async () => {
    const verify = vi.fn();
    const result = await (await gateway(facilitator({ verify }))).verify("not-a-payment", ENDPOINT, URL_);
    expect(result).toEqual({ valid: false, reason: "malformed_payment" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("rejects a payment made for a lower price", async () => {
    const verify = vi.fn();
    const cheaper = await paymentHeader();
    const swap = { ...ENDPOINT, key: "POST /v1/swap", priceUsd: "0.05" };
    const result = await (await gateway(facilitator({ verify }))).verify(cheaper, swap, URL_);
    expect(result).toEqual({ valid: false, reason: "requirements_mismatch" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("rejects a payment to another account", async () => {
    const header = await paymentHeader();
    const other = await createX402Gateway({ facilitator: facilitator(), payTo: "0.0.1000", usdcTokenId: USDC });
    expect(await other.verify(header, ENDPOINT, URL_)).toEqual({ valid: false, reason: "requirements_mismatch" });
  });

  it("returns the Hedera transaction ID on settlement", async () => {
    const result = await (await gateway()).settle(await paymentHeader(), ENDPOINT, URL_);
    expect(result).toEqual({ success: true, transactionId: "0.0.9185802@1.2", payer: "0.0.51234" });
  });

  it("reports a failed settlement", async () => {
    const client = facilitator({
      settle: async () => ({ success: false, errorReason: "transaction_failed", transaction: "", network: NETWORK }),
    });
    const result = await (await gateway(client)).settle(await paymentHeader(), ENDPOINT, URL_);
    expect(result).toEqual({ success: false, reason: "transaction_failed" });
  });
});
