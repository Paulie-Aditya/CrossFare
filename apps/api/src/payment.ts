import { createHash } from "node:crypto";
import type { Store } from "./store.ts";

export const PAYMENT_NETWORK = "hedera:testnet";

export interface PricedEndpoint {
  key: string;
  priceUsd: string;
  description: string;
}

export interface PaymentRequiredResponse {
  body: unknown;
  headers: Record<string, string>;
}

export type VerifyResult = { valid: true; payer: string } | { valid: false; reason: string };

export type SettleResult =
  | { success: true; transactionId: string; payer: string }
  | { success: false; reason: string };

/** The x402 side of a payment, separated so the guard's ordering rules are testable. */
export interface PaymentGateway {
  paymentRequired(endpoint: PricedEndpoint, url: string, error?: string): Promise<PaymentRequiredResponse>;
  verify(header: string, endpoint: PricedEndpoint, url: string): Promise<VerifyResult>;
  settle(header: string, endpoint: PricedEndpoint, url: string): Promise<SettleResult>;
}

export interface AuditEntry {
  payer: string;
  endpoint: string;
  amount: string;
  usedBy: string;
  transactionId: string;
}

export interface AuditLog {
  log(entry: AuditEntry): Promise<void>;
}

export interface HandlerResult {
  status: number;
  body: unknown;
  /** The quote request or swap this payment bought. Needed on success. */
  usedBy?: string;
}

export interface GuardedResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface PaymentGuardOptions {
  gateway: PaymentGateway;
  store: Store;
  audit: AuditLog;
  onError?: (context: string, error: unknown) => void;
}

export interface PaymentGuard {
  run(
    request: { endpoint: PricedEndpoint; url: string; header: string | undefined },
    handler: (payer: string) => Promise<HandlerResult>,
  ): Promise<GuardedResult>;
}

/**
 * Enforces the payment rules: verify before any work, settle only after success,
 * spend each payment once. The claim comes first so concurrent replays lose.
 */
export function createPaymentGuard(options: PaymentGuardOptions): PaymentGuard {
  const { gateway, store, audit } = options;
  const onError = options.onError ?? ((context, error) => console.error(context, error));

  return {
    async run({ endpoint, url, header }, handler) {
      if (!header) {
        const required = await gateway.paymentRequired(endpoint, url);
        return { status: 402, body: required.body, headers: required.headers };
      }

      const fingerprint = createHash("sha256").update(header).digest("hex");
      if (!store.claimPayment(fingerprint, endpoint.key)) {
        return { status: 402, body: { error: "payment_already_used" } };
      }

      const verified = await gateway.verify(header, endpoint, url).catch((error: unknown) => {
        onError("payment verification failed", error);
        return { valid: false, reason: "verification_unavailable" } as const;
      });
      if (!verified.valid) {
        store.releasePayment(fingerprint);
        const required = await gateway.paymentRequired(endpoint, url, verified.reason);
        return { status: 402, body: required.body, headers: required.headers };
      }

      let result: HandlerResult;
      try {
        result = await handler(verified.payer);
      } catch (error) {
        onError(`${endpoint.key} handler failed`, error);
        store.releasePayment(fingerprint);
        return { status: 502, body: { error: "upstream_failed" } };
      }
      if (result.status >= 400) {
        store.releasePayment(fingerprint);
        return { status: result.status, body: result.body };
      }

      const settled = await gateway.settle(header, endpoint, url).catch((error: unknown) => {
        onError("payment settlement failed", error);
        return { success: false, reason: "settlement_unavailable" } as const;
      });
      if (!settled.success) {
        store.releasePayment(fingerprint);
        return { status: 402, body: { error: "settlement_failed" } };
      }

      const usedBy = result.usedBy ?? "";
      store.settlePayment(fingerprint, {
        transactionId: settled.transactionId,
        payer: settled.payer,
        amount: endpoint.priceUsd,
        usedBy,
      });
      await audit
        .log({
          payer: settled.payer,
          endpoint: endpoint.key,
          amount: endpoint.priceUsd,
          usedBy,
          transactionId: settled.transactionId,
        })
        .catch((error: unknown) => onError("audit log failed", error));

      return {
        status: result.status,
        body: {
          ...(result.body as object),
          payment: { network: PAYMENT_NETWORK, transactionId: settled.transactionId },
        },
      };
    },
  };
}
