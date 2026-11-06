import { getAsset, type AssetId } from "./assets.ts";

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
  /** Approximate dollar values of what's sent and expected, when the venue gives prices. */
  usd?: { in: number; out: number };
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

const STABLECOINS = ["usdc", "usdt", "dai"];
const humanAmount = (amount: string, id: AssetId) => Number(fromBaseUnits(amount, getAsset(id).decimals));

/** Not every venue gives prices, so a bare route borrows them from its neighbour or from a stablecoin side. */
export function withUsdValues(routes: readonly Route[]): Route[] {
  const priced = routes.find((route) => route.usd);
  return routes.map((route) => {
    if (route.usd) return route;
    if (priced?.usd && route.from === priced.from && route.to === priced.to) {
      const ratio = Number(route.amountOut) / Number(priced.amountOut);
      return { ...route, usd: { in: priced.usd.in, out: priced.usd.out * ratio } };
    }
    if (STABLECOINS.includes(getAsset(route.from).symbol)) {
      const value = humanAmount(route.amountIn, route.from);
      return { ...route, usd: { in: value, out: value } };
    }
    if (STABLECOINS.includes(getAsset(route.to).symbol)) {
      const value = humanAmount(route.amountOut, route.to);
      return { ...route, usd: { in: value, out: value } };
    }
    return route;
  });
}

const CHAIN_NAMES: Record<string, string> = { base: "Base", eth: "Ethereum", btc: "Bitcoin", sol: "Solana", xrp: "XRP Ledger" };
const amountLine = (amount: string, id: AssetId) => {
  const { symbol, chain } = getAsset(id);
  const value = humanAmount(amount, id).toLocaleString("en-US", { maximumSignificantDigits: 5, useGrouping: false });
  return `${value} ${symbol.toUpperCase()} on ${CHAIN_NAMES[chain] ?? chain}`;
};
const assetLine = (id: AssetId) => {
  const { symbol, chain } = getAsset(id);
  return `${symbol.toUpperCase()} on ${CHAIN_NAMES[chain] ?? chain}`;
};

/** One line for the public record, so an entry reads as history rather than a database row. */
export function describeSwap(swap: { from: AssetId; to: AssetId; amountIn: string; amountOut: string; outcome: string }): string {
  const sold = amountLine(swap.amountIn, swap.from);
  if (swap.outcome === "quoted") return `${sold} for about ${amountLine(swap.amountOut, swap.to)}`;
  if (swap.outcome === "completed") return `Swapped ${sold} for ${amountLine(swap.amountOut, swap.to)}`;
  const label = swap.outcome.charAt(0).toUpperCase() + swap.outcome.slice(1);
  return `${label}: ${sold} to ${assetLine(swap.to)}`;
}

