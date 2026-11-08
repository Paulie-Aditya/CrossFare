import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store, VipKeyRecord, VipScope } from "./store.ts";

/**
 * VIP mode (FR-29 to FR-32): a caller with a key skips the per-call x402 payment.
 *
 * Every request carries the key and a signature:
 *   Authorization: Bearer cf_live_...
 *   X-Crossfare-Timestamp: Unix seconds
 *   X-Crossfare-Sign: hex HMAC-SHA256 of "<timestamp>\n<METHOD>\n<path>\n<raw body>"
 * The HMAC secret is the hex SHA-256 of the key. The server stores only that hash,
 * so a copy of the database can sign but can't pass the Bearer check, and a leaked
 * Bearer header alone can't make new requests after 60 seconds.
 */

const KEY_PREFIX = "cf_live_";
const SIGNATURE_WINDOW_SECONDS = 60;
const RATE_WINDOW_MS = 60_000;
const LABEL = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function generateVipKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("base64url");
}

export function hashVipKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Labels are published on Arkiv as the payer, so they stay short and plain. */
export function isValidVipLabel(label: string): boolean {
  return LABEL.test(label);
}

export interface SignedParts {
  timestamp: string;
  method: string;
  path: string;
  body: string;
}

export function signVipRequest(key: string, parts: SignedParts): string {
  return createHmac("sha256", hashVipKey(key))
    .update(`${parts.timestamp}\n${parts.method.toUpperCase()}\n${parts.path}\n${parts.body}`)
    .digest("hex");
}

export interface VipRequest {
  authorization?: string | undefined;
  timestamp?: string | undefined;
  signature?: string | undefined;
  method: string;
  path: string;
  body: string;
}

export type VipDecision =
  | { kind: "none" }
  | { kind: "allowed"; key: VipKeyRecord; payer: string }
  | { kind: "denied"; status: 402 | 403 | 429; error: string };

export interface VipGate {
  check(request: VipRequest, scope: VipScope): VipDecision;
  /** Meters a call that succeeded. Failed calls aren't billed, as with x402. */
  record(key: VipKeyRecord, endpoint: string, usedBy: string): void;
}

const startOfMonth = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();

function sameHex(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(given, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export function createVipGate(options: { store: Store; now?: () => Date }): VipGate {
  const { store } = options;
  const now = options.now ?? (() => new Date());
  const recent = new Map<string, number[]>();

  const deny = (status: 402 | 403 | 429, error: string): VipDecision => ({ kind: "denied", status, error });

  return {
    check(request, scope) {
      const match = /^Bearer\s+(\S+)$/i.exec(request.authorization ?? "");
      const key = match?.[1];
      if (!key?.startsWith(KEY_PREFIX)) return { kind: "none" };

      const record = store.getVipKeyByHash(hashVipKey(key));
      if (!record || record.revokedAt) return deny(402, "invalid_vip_key");
      if (!request.signature || !request.timestamp) return deny(402, "vip_signature_missing");

      const at = now().getTime();
      const sent = Number(request.timestamp);
      if (!Number.isInteger(sent) || Math.abs(at / 1000 - sent) > SIGNATURE_WINDOW_SECONDS) {
        return deny(402, "vip_timestamp_out_of_window");
      }
      const expected = signVipRequest(key, { timestamp: request.timestamp, method: request.method, path: request.path, body: request.body });
      if (!sameHex(expected, request.signature)) return deny(402, "vip_signature_invalid");

      if (!record.scopes.includes(scope)) return deny(403, "vip_scope_missing");

      if (record.ratePerMinute !== null) {
        const window = (recent.get(record.id) ?? []).filter((time) => at - time < RATE_WINDOW_MS);
        if (window.length >= record.ratePerMinute) {
          recent.set(record.id, window);
          return deny(429, "vip_rate_limited");
        }
        recent.set(record.id, [...window, at]);
      }
      if (record.monthlyQuota !== null && store.countVipUsage(record.id, startOfMonth(now())) >= record.monthlyQuota) {
        return deny(429, "vip_quota_exceeded");
      }
      return { kind: "allowed", key: record, payer: `vip:${record.label}` };
    },

    record(key, endpoint, usedBy) {
      store.recordVipUsage({ keyId: key.id, endpoint, usedBy, at: now().toISOString() });
    },
  };
}
