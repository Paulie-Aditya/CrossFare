import type { Asset, AssetId } from "../assets.ts";
import type { Route } from "../routes.ts";

export interface QuoteRequest {
  from: { asset: AssetId; amount: string; address: string };
  to: { asset: AssetId; address: string };
  mode: "exact_in" | "exact_out";
  slippageBps: number;
  refundAddress?: string;
  /** The deposit may come from any sender, such as an exchange, and may differ slightly. */
  flexibleDeposit?: boolean;
  /** A price check with no addresses behind it. It can't be executed. */
  indicative?: boolean;
  /** The caller's own fee on this swap. Crossfare takes none. */
  fee?: CallerFee;
}

/**
 * A fee the caller charges on its swap. Each venue pays it to the recipient it can reach:
 * Uniswap to `evm` on the output chain, NEAR Intents to `near` (or `evm`, which is also an
 * Intents account), THORChain to the `thorchain` THORName. A venue with no matching recipient
 * charges nothing. SwapKit pays the operator's dashboard wallets, so its fee is owed to the caller.
 */
export interface CallerFee {
  bps: number;
  recipients: { evm?: string; near?: string; thorchain?: string };
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
  /** The least a provider documents swapping. Below it the deposit isn't swapped. Unset where none is documented. */
  minAmount?: string;
  /** When a deposit that can't be swapped goes back, as the provider set it. */
  refundBy?: string;
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
  /** A two-leg route's first leg delivered; the caller holds the hub token until it asks for the next leg. */
  | "awaiting_next_leg"
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
  /** Decimal amount that was really deposited, which can differ from the quote. */
  amountSent?: string;
  refundReason?: string;
  /** Part of the deposit was swapped and the rest returned. */
  partialRefund?: boolean;
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
  /**
   * SwapKit providers this venue reaches directly. When it has a route, SwapKit's routes
   * through those providers are dropped, so SwapKit stays the fallback for them.
   */
  readonly replaces?: readonly string[];
  /**
   * Whether the venue might serve the pair, judged from what it already knows, with no network
   * call. False is certain; true only means a quote is worth asking for. Route planning uses it to
   * skip venues, so a venue without it is always asked.
   */
  serves?(from: Asset, to: Asset): boolean;
  /** Returns no routes when the venue can't serve the pair; throws VenueError on failure. */
  quote(request: QuoteRequest): Promise<Route[]>;
  prepare(route: Route, request: QuoteRequest): Promise<PreparedSwap>;
  track(input: TrackInput): Promise<TrackResult>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function toHexValue(value: string | undefined): string {
  return `0x${BigInt(value ?? "0").toString(16)}`;
}
