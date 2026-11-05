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
  /** The provider's deposit channel, used to track a deposit with no known hash. */
  channelId?: string;
}

export interface PreparedSwap {
  venueSwapId?: string;
  transactions: UnsignedTransaction[];
  deposit?: Deposit;
}

export type SwapStatus =
  | "awaiting_deposit"
  | "confirming"
  | "exchanging"
  | "completed"
  | "refunded"
  | "failed"
  | "expired";

export interface TrackInput {
  route: Route;
  request: QuoteRequest;
  prepared: PreparedSwap;
  txHashes: string[];
  venueSwapId: string | null;
}

export interface TrackResult {
  status: SwapStatus;
  /** Decimal amount actually delivered, once known. */
  amountReceived?: string;
  txHashes?: string[];
}

/** A venue answered with an error that isn't simply "no route for this pair". */
export class VenueError extends Error {
  readonly venue: string;
  readonly status: number;
  /** Set when the caller can act on the reason, such as "insufficient_balance". */
  readonly code?: string;

  constructor(venue: string, status: number, message: string, code?: string) {
    super(`${venue}: ${message}`);
    this.name = "VenueError";
    this.venue = venue;
    this.status = status;
    if (code) this.code = code;
  }
}

/** The only interface the rest of Crossfare uses to reach a venue. */
export interface Venue {
  readonly name: string;
  /** Returns no routes when the venue can't serve the pair; throws VenueError on failure. */
  quote(request: QuoteRequest): Promise<Route[]>;
  prepare(route: Route, request: QuoteRequest): Promise<PreparedSwap>;
  track(input: TrackInput): Promise<TrackResult>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function toHexValue(value: string | undefined): string {
  return `0x${BigInt(value ?? "0").toString(16)}`;
}
