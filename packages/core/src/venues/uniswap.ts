import { getAsset, toBaseUnits, type Asset, type UniswapToken } from "../assets.ts";
import type { Route } from "../routes.ts";
import {
  VenueError,
  toHexValue,
  type FetchLike,
  type PreparedSwap,
  type QuoteRequest,
  type UnsignedTransaction,
  type Venue,
} from "./types.ts";

const BASE_URL = "https://trade-api.gateway.uniswap.org/v1";
const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";
const VENUE = "uniswap";
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

export interface UniswapOptions {
  apiKey: string;
  fetch?: FetchLike;
  now?: () => Date;
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
        swapper: request.from.address,
        recipient: request.to.address,
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
  };
}
