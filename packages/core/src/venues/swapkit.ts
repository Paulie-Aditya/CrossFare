import { getAsset, toBaseUnits } from "../assets.ts";
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

const BASE_URL = "https://api.swapkit.dev";
const VENUE = "swapkit";
/** SwapKit caches a quote's route for 5 minutes. */
const QUOTE_TTL_MS = 5 * 60_000;

export type SwapStatus =
  | "awaiting_deposit"
  | "confirming"
  | "exchanging"
  | "completed"
  | "refunded"
  | "failed"
  | "expired";

const TRACK_STATUS: Record<string, SwapStatus> = {
  not_started: "awaiting_deposit",
  pending: "confirming",
  swapping: "exchanging",
  completed: "completed",
  refunded: "refunded",
  failed: "failed",
};

/** Non-terminal unknowns stay `confirming` so polling continues. */
export function mapTrackStatus(status: string): SwapStatus {
  return TRACK_STATUS[status] ?? "confirming";
}

interface ApiFee {
  type: string;
  amount?: string;
  asset?: string;
}

interface ApiRoute {
  routeId: string;
  providers: string[];
  expectedBuyAmount: string;
  expectedBuyAmountMaxSlippage: string;
  fees?: ApiFee[];
  estimatedTime?: { total?: number };
}

interface ApiEvmTx {
  to: string;
  value?: string;
  data?: string;
}

interface ApiSwap {
  swapId: string;
  tx?: ApiEvmTx | string;
  approvalTx?: ApiEvmTx;
  sellAmount?: string;
  targetAddress?: string;
  inboundAddress?: string;
  memo?: string;
  expiration?: string;
  meta?: { depositChannelExpiration?: number };
}

export interface SwapKitOptions {
  apiKey: string;
  fetch?: FetchLike;
  now?: () => Date;
}

export function createSwapKitVenue(options: SwapKitOptions): Venue {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());

  function call(path: string, body: unknown): Promise<Response> {
    return fetchImpl(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": options.apiKey },
      body: JSON.stringify(body),
    });
  }

  return {
    name: VENUE,

    async quote(request: QuoteRequest): Promise<Route[]> {
      const from = getAsset(request.from.asset);
      const to = getAsset(request.to.asset);
      const exactIn = request.mode === "exact_in";

      const response = await call("/v3/quote", {
        sellAsset: from.swapkit,
        buyAsset: to.swapkit,
        ...(exactIn ? { sellAmount: request.from.amount } : { buyAmount: request.from.amount }),
        sourceAddress: request.from.address,
        destinationAddress: request.to.address,
        ...(request.refundAddress ? { refundAddress: request.refundAddress } : {}),
        slippage: request.slippageBps / 100,
        quoteType: exactIn ? "EXACT_INPUT" : "EXACT_OUTPUT",
      });
      if (response.status === 404) return [];
      if (!response.ok) {
        throw new VenueError(VENUE, response.status, `/v3/quote returned ${response.status}`);
      }

      const { routes } = (await response.json()) as { routes?: ApiRoute[] };
      const validUntil = new Date(now().getTime() + QUOTE_TTL_MS).toISOString();

      return (routes ?? []).map((route) => ({
        venue: VENUE,
        provider: route.providers.join("+").toLowerCase(),
        from: from.id,
        to: to.id,
        amountIn: toBaseUnits(request.from.amount, from.decimals).toString(),
        amountOut: toBaseUnits(route.expectedBuyAmount, to.decimals).toString(),
        minAmountOut: toBaseUnits(route.expectedBuyAmountMaxSlippage, to.decimals).toString(),
        fees: Object.fromEntries(
          (route.fees ?? []).map((fee) => [fee.type, `${fee.amount ?? "?"} ${fee.asset ?? ""}`.trim()]),
        ),
        etaSeconds: route.estimatedTime?.total ?? 0,
        validUntil,
        venueData: { routeId: route.routeId },
      }));
    },

    async prepare(route: Route, request: QuoteRequest): Promise<PreparedSwap> {
      const { routeId } = route.venueData as { routeId: string };
      const response = await call("/v3/swap", {
        routeId,
        sourceAddress: request.from.address,
        destinationAddress: request.to.address,
        ...(request.refundAddress ? { refundAddress: request.refundAddress } : {}),
      });
      if (!response.ok) {
        throw new VenueError(VENUE, response.status, `/v3/swap returned ${response.status}`);
      }
      const swap = (await response.json()) as ApiSwap;
      const source = getAsset(route.from);

      if (source.uniswap) {
        const chainId = source.uniswap.chainId;
        const toUnsigned = (tx: ApiEvmTx, kind: UnsignedTransaction["kind"]): UnsignedTransaction => ({
          kind,
          chainId,
          to: tx.to,
          data: tx.data ?? "0x",
          value: toHexValue(tx.value),
        });
        if (!swap.tx || typeof swap.tx === "string") {
          throw new VenueError(VENUE, 502, "/v3/swap returned no EVM transaction");
        }
        return {
          venueSwapId: swap.swapId,
          transactions: [
            ...(swap.approvalTx ? [toUnsigned(swap.approvalTx, "approval")] : []),
            toUnsigned(swap.tx, "swap"),
          ],
        };
      }

      const address = swap.targetAddress ?? swap.inboundAddress;
      if (!address) throw new VenueError(VENUE, 502, "/v3/swap returned no deposit address");
      const deadline = swap.meta?.depositChannelExpiration ?? Number(swap.expiration ?? NaN);
      return {
        venueSwapId: swap.swapId,
        transactions: [],
        deposit: {
          asset: source.id,
          address,
          ...(swap.memo ? { memo: swap.memo } : {}),
          amount: swap.sellAmount ?? request.from.amount,
          ...(Number.isFinite(deadline) ? { expiresAt: new Date(deadline * 1000).toISOString() } : {}),
        },
      };
    },
  };
}
