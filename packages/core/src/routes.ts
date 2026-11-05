import type { AssetId } from "./assets.ts";

/**
 * One way to fill a quote request, normalized across venues (FR-12).
 * Amounts are base-unit integer strings so they compare without precision loss.
 */
export interface Route {
  venue: string;
  provider?: string;
  from: AssetId;
  to: AssetId;
  amountIn: string;
  amountOut: string;
  /** The amount the caller is guaranteed after slippage and fees. Routes rank on this. */
  minAmountOut: string;
  fees: Record<string, string>;
  etaSeconds: number;
  validUntil: string;
  /** True when a plain transfer to a deposit address pays for it, with no contract call. */
  depositable?: boolean;
  /** Venue-specific state needed to execute. Private: never published or returned. */
  venueData: unknown;
}

export function rankRoutes(routes: readonly Route[]): Route[] {
  return [...routes].sort((a, b) => {
    const left = BigInt(a.minAmountOut);
    const right = BigInt(b.minAmountOut);
    if (left === right) return 0;
    return left > right ? -1 : 1;
  });
}

export function fromBaseUnits(amount: string, decimals: number): string {
  const digits = amount.padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
