import type { AssetId } from "../assets.ts";
import type { Route } from "../routes.ts";

export interface QuoteRequest {
  from: { asset: AssetId; amount: string; address: string };
  to: { asset: AssetId; address: string };
  mode: "exact_in" | "exact_out";
  slippageBps: number;
  refundAddress?: string;
}

export interface UnsignedTransaction {
  kind: "approval" | "swap";
  chainId: number;
  to: string;
  data: string;
  /** Hex wei. */
  value: string;
}

export interface Deposit {
  asset: AssetId;
  address: string;
  memo?: string;
  /** Decimal amount of the source asset to send. */
  amount: string;
  expiresAt?: string;
}

export interface PreparedSwap {
  venueSwapId?: string;
  transactions: UnsignedTransaction[];
  deposit?: Deposit;
}

/** A venue answered with an error that isn't simply "no route for this pair". */
export class VenueError extends Error {
  constructor(
    readonly venue: string,
    readonly status: number,
    message: string,
  ) {
    super(`${venue}: ${message}`);
    this.name = "VenueError";
  }
}

/** The only interface the rest of Crossfare uses to reach a venue. */
export interface Venue {
  readonly name: string;
  /** Returns no routes when the venue can't serve the pair; throws VenueError on failure. */
  quote(request: QuoteRequest): Promise<Route[]>;
  prepare(route: Route, request: QuoteRequest): Promise<PreparedSwap>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function toHexValue(value: string | undefined): string {
  return `0x${BigInt(value ?? "0").toString(16)}`;
}
