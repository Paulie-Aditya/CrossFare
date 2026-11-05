import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { PAYMENT_NETWORK, type PaymentGateway, type PricedEndpoint } from "./payment.ts";

const USDC_DECIMALS = 6;
const PAYMENT_TIMEOUT_SECONDS = 180;

export interface X402GatewayOptions {
  facilitator: FacilitatorClient;
  payTo: string;
  usdcTokenId: string;
}

function decode(header: string): PaymentPayload | null {
  try {
    return decodePaymentSignatureHeader(header);
  } catch {
    return null;
  }
}

/** The x402 protocol work, using the official resource server against a facilitator. */
export async function createX402Gateway(options: X402GatewayOptions): Promise<PaymentGateway> {
  const server = new x402ResourceServer(options.facilitator).register(
    PAYMENT_NETWORK,
    new ExactHederaScheme({
      defaultAssets: { [PAYMENT_NETWORK]: { asset: options.usdcTokenId, decimals: USDC_DECIMALS } },
    }),
  );
  await server.initialize();

  const requirementsFor = (endpoint: PricedEndpoint): Promise<PaymentRequirements[]> =>
    server.buildPaymentRequirements({
      scheme: "exact",
      network: PAYMENT_NETWORK,
      payTo: options.payTo,
      price: `$${endpoint.priceUsd}`,
      maxTimeoutSeconds: PAYMENT_TIMEOUT_SECONDS,
    });

  /** Matches the payment against this endpoint's own price, asset and recipient. */
  async function match(header: string, endpoint: PricedEndpoint) {
    const payload = decode(header);
    if (!payload) return { error: "malformed_payment" } as const;
    const requirements = server.findMatchingRequirements(await requirementsFor(endpoint), payload);
    if (!requirements) return { error: "requirements_mismatch" } as const;
    return { payload, requirements } as const;
  }

  return {
    async paymentRequired(endpoint, url, error) {
      const required = await server.createPaymentRequiredResponse(
        await requirementsFor(endpoint),
        { url, description: endpoint.description, mimeType: "application/json" },
        error,
      );
      return { body: required, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) } };
    },

    async verify(header, endpoint) {
      const matched = await match(header, endpoint);
      if ("error" in matched) return { valid: false, reason: matched.error! };
      const result = await server.verifyPayment(matched.payload, matched.requirements);
      if (!result.isValid || !result.payer) {
        return { valid: false, reason: result.invalidReason ?? "invalid_payment" };
      }
      return { valid: true, payer: result.payer };
    },

    async settle(header, endpoint) {
      const matched = await match(header, endpoint);
      if ("error" in matched) return { success: false, reason: matched.error! };
      const result = await server.settlePayment(matched.payload, matched.requirements);
      if (!result.success) return { success: false, reason: result.errorReason ?? "settlement_failed" };
      return { success: true, transactionId: result.transaction, payer: result.payer ?? "" };
    },
  };
}
