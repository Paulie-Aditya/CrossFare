import { displaySymbol, getAsset, toBaseUnits, type Asset } from "../assets.ts";
import { fromBaseUnits, type Route } from "../routes.ts";
import { VenueError, type FetchLike, type PreparedSwap, type QuoteRequest, type SolanaTransaction, type TrackInput, type TrackResult, type Venue } from "./types.ts";

/**
 * Jupiter, Solana's aggregator, through its Router API (/build). It returns the swap's
 * instructions, which Crossfare assembles into a transaction for the caller to sign and send, and
 * takes the caller's fee per request into their own token account. Jupiter keeps none of it.
 */

const VENUE = "jupiter";
const BASE_URL = "https://api.jup.ag/swap/v2";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
/** /build needs a wallet even for a price; this one only ever prices. */
export const JUPITER_PRICE_TAKER = "GZRiD2TR1oiSXXFDsGhLR5fZWbfHqY9KyfHkiChUuVBR";
/** The transaction lapses with its blockhash, about 150 slots after the quote. */
const QUOTE_TTL_MS = 60_000;

/** /build's answer. Only the fields Crossfare reads are typed; the rest is passed to assembly. */
export interface JupiterBuild {
  inAmount: string;
  outAmount: string;
  /** The least the swap delivers, after slippage and the caller's fee. */
  otherAmountThreshold: string;
  [field: string]: unknown;
}

export interface SolanaTransactionOutcome {
  failed: boolean;
  feePayer: string;
  /** Token balance changes by owner and mint, in base units. */
  tokenChanges: { owner: string; mint: string; change: string }[];
}

export interface SolanaReader {
  /** The token account where `owner` holds `mint`, if it exists. A fee into one that doesn't would fail the swap. */
  feeTokenAccount(owner: string, mint: string): Promise<string | null>;
  /** A landed transaction's outcome, or null while it hasn't landed. */
  getTransaction(signature: string): Promise<SolanaTransactionOutcome | null>;
}

/** Turns /build's instructions into an unsigned transaction with the taker paying. */
export type AssembleSolana = (build: JupiterBuild, taker: string) => Promise<SolanaTransaction>;

export interface JupiterOptions {
  /** Optional: without one Jupiter allows about one request every two seconds. */
  apiKey?: string;
  fetch?: FetchLike;
  now?: () => Date;
  solana?: SolanaReader;
  assemble?: AssembleSolana;
}

interface JupiterVenueData {
  build: JupiterBuild;
  /** Built for the price-check wallet, so it can't be executed. */
  priceOnly?: true;
  outputMint: string;
}

/** A token's mint: SwapKit's identifier carries it, case intact. SOL is traded as its wrapped mint. */
function mintOf(asset: Asset): string | null {
  if (asset.chain !== "sol" || !asset.swapkit?.startsWith("SOL.")) return null;
  const dash = asset.swapkit.indexOf("-");
  return dash < 0 ? (asset.swapkit === "SOL.SOL" ? WSOL_MINT : null) : asset.swapkit.slice(dash + 1);
}

export function createJupiterVenue(options: JupiterOptions = {}): Venue {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());

  /** The caller's token account for the output, or else the input. With neither, no fee. */
  async function feeAccount(request: QuoteRequest, mints: string[]): Promise<{ bps: number; account: string } | null> {
    const wallet = request.fee && request.fee.bps > 0 ? request.fee.recipients.solana : undefined;
    if (!wallet || !options.solana) return null;
    for (const mint of mints) {
      const account = await options.solana.feeTokenAccount(wallet, mint);
      if (account) return { bps: request.fee!.bps, account };
    }
    return null;
  }

  return {
    name: VENUE,

    serves: (from, to) => mintOf(from) !== null && mintOf(to) !== null,

    async quote(request: QuoteRequest): Promise<Route[]> {
      if (request.mode !== "exact_in") return [];
      const from = getAsset(request.from.asset);
      const to = getAsset(request.to.asset);
      const inputMint = mintOf(from);
      const outputMint = mintOf(to);
      if (!inputMint || !outputMint) return [];
      // The swap pays the wallet that signs it; /build can't send the output anywhere else.
      if (!request.indicative && request.to.address !== request.from.address) return [];

      const amountIn = toBaseUnits(request.from.amount, from.decimals);
      const fee = request.indicative ? null : await feeAccount(request, [outputMint, inputMint]);
      const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: amountIn.toString(),
        taker: request.indicative ? JUPITER_PRICE_TAKER : request.from.address,
        slippageBps: String(request.slippageBps),
        ...(fee ? { platformFeeBps: String(fee.bps), feeAccount: fee.account } : {}),
      });
      const response = await fetchImpl(`${BASE_URL}/build?${params}`, {
        headers: { accept: "application/json", ...(options.apiKey ? { "x-api-key": options.apiKey } : {}) },
      });
      // Jupiter answers 400 for a pair or amount it can't route.
      if (response.status === 400) return [];
      if (!response.ok) throw new VenueError(VENUE, response.status, `/build returned ${response.status}`);
      const build = (await response.json()) as JupiterBuild;

      const amountOut = BigInt(build.outAmount);
      // Amounts are after the fee, so the fee is the share it took of the whole.
      const feeAmount = fee ? (amountOut * BigInt(fee.bps)) / BigInt(10_000 - fee.bps) : 0n;
      const venueData: JupiterVenueData = { build, outputMint, ...(request.indicative ? { priceOnly: true as const } : {}) };
      return [{
        venue: VENUE,
        from: from.id,
        to: to.id,
        amountIn: amountIn.toString(),
        amountOut: amountOut.toString(),
        minAmountOut: build.otherAmountThreshold,
        fees: feeAmount > 0n ? { integrator: `${fromBaseUnits(feeAmount.toString(), to.decimals)} ${displaySymbol(to.symbol)}` } : {},
        etaSeconds: 15,
        validUntil: new Date(now().getTime() + QUOTE_TTL_MS).toISOString(),
        venueData,
      }];
    },

    async prepare(route: Route, request: QuoteRequest): Promise<PreparedSwap> {
      const { build, priceOnly } = route.venueData as JupiterVenueData;
      if (priceOnly) throw new VenueError(VENUE, 422, "a price check can't be executed");
      if (!options.assemble) throw new VenueError(VENUE, 500, "no Solana transaction builder configured");
      return { transactions: [], solana: await options.assemble(build, request.from.address) };
    },

    async track({ route, request, txHashes }: TrackInput): Promise<TrackResult> {
      const signature = txHashes.at(-1);
      if (!signature) return { status: "awaiting_deposit" };
      if (!options.solana) throw new VenueError(VENUE, 500, "no Solana reader configured");
      const outcome = await options.solana.getTransaction(signature);
      if (!outcome) return { status: "confirming" };
      // Anyone can submit a signature, so it only counts if this wallet paid for it.
      if (outcome.feePayer !== request.from.address) return { status: "confirming" };
      if (outcome.failed) return { status: "failed" };

      const { outputMint } = route.venueData as JupiterVenueData;
      const change = outcome.tokenChanges.find((entry) => entry.owner === request.to.address && entry.mint === outputMint);
      // SOL arrives unwrapped, mixed with the network fee, so the quote's amount stands.
      if (!change || outputMint === WSOL_MINT) return { status: "completed", txHashes: [signature] };
      return {
        status: "completed",
        amountReceived: fromBaseUnits(change.change, getAsset(route.to).decimals),
        txHashes: [signature],
      };
    },
  };
}
