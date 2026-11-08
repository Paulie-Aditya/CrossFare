import { getAsset, toBaseUnits, type Asset, type UniswapToken } from "../assets.ts";
import { evmChainById } from "../evm-chains.ts";
import { fromBaseUnits, type Route } from "../routes.ts";
import {
  VenueError,
  toHexValue,
  type FetchLike,
  type PreparedSwap,
  type QuoteRequest,
  type TrackInput,
  type TrackResult,
  type UnsignedTransaction,
  type Venue,
} from "./types.ts";

const BASE_URL = "https://trade-api.gateway.uniswap.org/v1";
const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";
const VENUE = "uniswap";
/** The API requires a swapper even for a price. It finds no route for a reserved address such as 0x01. */
const PRICE_CHECK_SWAPPER = "0x000000000000000000000000000000000000dEaD";
/** The API sets no quote expiry. Its guide says to refresh quotes older than 30 seconds. */
const QUOTE_TTL_MS = 60_000;

interface ApiTransaction {
  to: string;
  data: string;
  value?: string;
  chainId: number;
}

interface AggregatedOutput {
  minAmount?: string;
  fee?: string;
}

interface ApiQuote {
  input: { amount: string };
  output: { amount: string };
  aggregatedOutputs?: AggregatedOutput[];
  gasFeeUSD?: string;
}

interface QuoteResponse {
  routing: string;
  quote: ApiQuote;
}

export interface ChainLog {
  address: string;
  topics: readonly string[];
  data: string;
}

export interface ChainReceipt {
  status: "success" | "reverted";
  from: string;
  to: string | null;
  logs: readonly ChainLog[];
}

export type GetReceipt = (chainId: number, hash: string) => Promise<ChainReceipt | null>;

export interface UniswapOptions {
  apiKey: string;
  fetch?: FetchLike;
  now?: () => Date;
  /** Reads a transaction receipt, returning null until it is mined. */
  getReceipt?: GetReceipt;
}

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const WETH_WITHDRAWAL_TOPIC = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";

const sameAddress = (a: string | null | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
const topicAddress = (topic: string | undefined) => `0x${(topic ?? "").slice(-40)}`;

/**
 * Native output arrives through an internal call, which leaves no log of its own,
 * so the wrapped coin's unwrap stands in for the amount delivered. Null where that coin isn't known.
 */
function deliveredAmount(receipt: ChainReceipt, token: UniswapToken, recipient: string): bigint | null {
  const native = token.address === NATIVE_TOKEN;
  const wrapped = evmChainById(token.chainId)?.wrappedNative ?? "";
  if (native && !wrapped) return null;
  return receipt.logs.reduce((sum, log) => {
    if (native) {
      const isUnwrap = sameAddress(log.address, wrapped) && log.topics[0] === WETH_WITHDRAWAL_TOPIC;
      return isUnwrap ? sum + BigInt(log.data) : sum;
    }
    const isTransfer =
      sameAddress(log.address, token.address) &&
      log.topics[0] === TRANSFER_TOPIC &&
      sameAddress(topicAddress(log.topics[2]), recipient);
    return isTransfer ? sum + BigInt(log.data) : sum;
  }, 0n);
}

function samePairChain(from: Asset, to: Asset): { in: UniswapToken; out: UniswapToken } | null {
  if (!from.uniswap || !to.uniswap || from.uniswap.chainId !== to.uniswap.chainId) return null;
  return { in: from.uniswap, out: to.uniswap };
}

/** Uses the outputs that reach the caller; integrator fee entries are not theirs. */
function minimumOutput(quote: ApiQuote, slippageBps: number): string {
  const outputs = quote.aggregatedOutputs?.filter((output) => !output.fee && output.minAmount);
  if (outputs?.length) {
    return outputs.reduce((sum, output) => sum + BigInt(output.minAmount!), 0n).toString();
  }
  return ((BigInt(quote.output.amount) * BigInt(10_000 - slippageBps)) / 10_000n).toString();
}

export function createUniswapVenue(options: UniswapOptions): Venue {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());

  async function call(path: string, body: unknown): Promise<Response> {
    return fetchImpl(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-api-key": options.apiKey,
        // Crossfare hands back unsigned transactions, so it can't use typed-data permits.
        "x-permit2-disabled": "true",
      },
      body: JSON.stringify(body),
    });
  }

  async function callOk<T>(path: string, body: unknown): Promise<T> {
    const response = await call(path, body);
    if (!response.ok) {
      throw new VenueError(VENUE, response.status, `${path} returned ${response.status}`);
    }
    return (await response.json()) as T;
  }

  function normalize(tx: ApiTransaction, kind: UnsignedTransaction["kind"]): UnsignedTransaction {
    if (!tx.data || tx.data === "0x") {
      throw new VenueError(VENUE, 502, `${kind} transaction has empty calldata`);
    }
    return { kind, chainId: tx.chainId, to: tx.to, data: tx.data, value: toHexValue(tx.value) };
  }

  return {
    name: VENUE,

    async quote(request: QuoteRequest): Promise<Route[]> {
      const from = getAsset(request.from.asset);
      const to = getAsset(request.to.asset);
      const tokens = samePairChain(from, to);
      if (!tokens) return [];

      const exactIn = request.mode === "exact_in";
      const amount = toBaseUnits(request.from.amount, exactIn ? from.decimals : to.decimals);
      const response = await call("/quote", {
        type: exactIn ? "EXACT_INPUT" : "EXACT_OUTPUT",
        amount: amount.toString(),
        tokenInChainId: tokens.in.chainId,
        tokenOutChainId: tokens.out.chainId,
        tokenIn: tokens.in.address,
        tokenOut: tokens.out.address,
        swapper: request.indicative ? PRICE_CHECK_SWAPPER : request.from.address,
        ...(request.indicative ? {} : { recipient: request.to.address }),
        slippageTolerance: request.slippageBps / 100,
        protocols: ["V2", "V3", "V4"],
      });
      if (response.status === 404) return [];
      if (!response.ok) {
        throw new VenueError(VENUE, response.status, `/quote returned ${response.status}`);
      }

      const { routing, quote } = (await response.json()) as QuoteResponse;
      if (routing !== "CLASSIC") return [];

      return [
        {
          venue: VENUE,
          from: from.id,
          to: to.id,
          amountIn: quote.input.amount,
          amountOut: quote.output.amount,
          minAmountOut: minimumOutput(quote, request.slippageBps),
          fees: quote.gasFeeUSD ? { networkUsd: quote.gasFeeUSD } : {},
          etaSeconds: 30,
          validUntil: new Date(now().getTime() + QUOTE_TTL_MS).toISOString(),
          venueData: { quote },
        },
      ];
    },

    async prepare(route: Route, request: QuoteRequest): Promise<PreparedSwap> {
      const { quote } = route.venueData as { quote: ApiQuote };
      const token = getAsset(route.from).uniswap;
      if (!token) throw new VenueError(VENUE, 422, `${route.from} is not a Uniswap token`);

      const transactions: UnsignedTransaction[] = [];
      if (token.address !== NATIVE_TOKEN) {
        const { approval, cancel } = await callOk<{
          approval: ApiTransaction | null;
          cancel: ApiTransaction | null;
        }>("/check_approval", {
          walletAddress: request.from.address,
          token: token.address,
          amount: route.amountIn,
          chainId: token.chainId,
        });
        if (cancel) transactions.push(normalize(cancel, "approval"));
        if (approval) transactions.push(normalize(approval, "approval"));
      }

      const { swap } = await callOk<{ swap: ApiTransaction }>("/swap", { quote });
      transactions.push(normalize(swap, "swap"));
      return { transactions };
    },

    async track({ route, request, prepared, txHashes }: TrackInput): Promise<TrackResult> {
      const swapTx = prepared.transactions.at(-1);
      const hash = txHashes.at(-1);
      if (!hash || !swapTx) return { status: "awaiting_deposit" };
      if (!options.getReceipt) throw new VenueError(VENUE, 500, "no chain reader configured");

      const receipt = await options.getReceipt(swapTx.chainId, hash);
      if (!receipt) return { status: "confirming" };
      // Anyone can submit a hash, so it only counts if it is this swap's transaction.
      if (!sameAddress(receipt.from, request.from.address) || !sameAddress(receipt.to, swapTx.to)) {
        return { status: "confirming" };
      }
      if (receipt.status === "reverted") return { status: "failed" };

      const output = getAsset(route.to);
      if (!output.uniswap) return { status: "completed" };
      const amount = deliveredAmount(receipt, output.uniswap, request.to.address);
      // With no wrapped coin to measure by, the quote's amount stands.
      if (amount === null) return { status: "completed" };
      return {
        status: "completed",
        amountReceived: fromBaseUnits(amount.toString(), output.decimals),
      };
    },
  };
}
