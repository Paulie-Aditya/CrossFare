import { getAsset, toBaseUnits } from "../assets.ts";
import type { Route } from "../routes.ts";
import {
  VenueError,
  toHexValue,
  type FetchLike,
  type Deposit,
  type PreparedSwap,
  type QuoteRequest,
  type SwapStatus,
  type TrackInput,
  type TrackResult,
  type UnsignedTransaction,
  type Venue,
} from "./types.ts";

const BASE_URL = "https://api.swapkit.dev";
const VENUE = "swapkit";
/** SwapKit caches a quote's route for 5 minutes. */
const QUOTE_TTL_MS = 5 * 60_000;

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
  txHint?: string;
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
  txHint?: string;
  meta?: { depositChannelExpiration?: number; providerDepositChannelId?: string };
}

interface ApiTrack {
  status: string;
  fromAddress?: string;
  toAmount?: string;
  legs?: { hash?: string }[];
}

export interface SwapKitOptions {
  apiKey: string;
  fetch?: FetchLike;
  now?: () => Date;
}

/** Turns SwapKit's refusals into reasons a caller can fix. */
async function refusalCode(response: Response): Promise<string | undefined> {
  const body = (await response.json().catch(() => null)) as { error?: string; data?: { code?: string } } | null;
  if (body?.error === "insufficientBalance") return "insufficient_balance";
  if (body?.data?.code === "invalid_recipient_address") return "invalid_recipient";
  return undefined;
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
        depositable: route.txHint === "simpleTransfer",
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
        throw new VenueError(VENUE, response.status, `/v3/swap returned ${response.status}`, await refusalCode(response));
      }
      const swap = (await response.json()) as ApiSwap;
      const source = getAsset(route.from);

      const depositDetails = (address: string): Deposit => {
        const deadline = swap.meta?.depositChannelExpiration ?? Number(swap.expiration ?? NaN);
        const channelId = swap.meta?.providerDepositChannelId;
        return {
          asset: source.id,
          address,
          ...(swap.memo ? { memo: swap.memo } : {}),
          amount: swap.sellAmount ?? request.from.amount,
          ...(Number.isFinite(deadline) ? { expiresAt: new Date(deadline * 1000).toISOString() } : {}),
          ...(channelId ? { channelId } : {}),
        };
      };

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
        const inbound = swap.inboundAddress ?? swap.targetAddress;
        return {
          venueSwapId: swap.swapId,
          transactions: [
            ...(swap.approvalTx ? [toUnsigned(swap.approvalTx, "approval")] : []),
            toUnsigned(swap.tx, "swap"),
          ],
          // A plain transfer can be sent from any wallet software, with no connection to this page.
          ...(swap.txHint === "simpleTransfer" && inbound ? { deposit: depositDetails(inbound) } : {}),
        };
      }

      const address = swap.targetAddress ?? swap.inboundAddress;
      if (!address) throw new VenueError(VENUE, 502, "/v3/swap returned no deposit address");
      return { venueSwapId: swap.swapId, transactions: [], deposit: depositDetails(address) };
    },

    async track({ route, request, prepared, txHashes }: TrackInput): Promise<TrackResult> {
      const { routeId } = route.venueData as { routeId: string };
      const hash = txHashes.at(-1);
      const chainId = prepared.transactions.at(-1)?.chainId;

      let body: Record<string, string>;
      if (prepared.deposit) {
        const { channelId, address } = prepared.deposit;
        body = channelId ? { depositChannelId: channelId } : { depositAddress: address };
      } else if (hash && chainId) {
        body = { hash, chainId: String(chainId), routeId };
      } else {
        return { status: "awaiting_deposit" };
      }

      const response = await call("/track", body);
      // SwapKit documents a 404 right after broadcast and a 202 as "keep polling".
      if (response.status === 404 || response.status === 202) {
        return { status: hash ? "confirming" : "awaiting_deposit" };
      }
      if (!response.ok) {
        throw new VenueError(VENUE, response.status, `/track returned ${response.status}`);
      }

      const tracked = (await response.json()) as ApiTrack;
      // Anyone can submit a hash, so it only counts if this swap's sender sent it.
      const sender = tracked.fromAddress?.toLowerCase();
      if (!prepared.deposit && hash && sender && sender !== request.from.address.toLowerCase()) {
        return { status: "confirming" };
      }

      const status = mapTrackStatus(tracked.status);
      const legHashes = (tracked.legs ?? []).flatMap((leg) => (leg.hash && leg.hash !== "0x" ? [leg.hash] : []));
      return {
        status,
        ...(status === "completed" && tracked.toAmount ? { amountReceived: tracked.toAmount } : {}),
        ...(legHashes.length ? { txHashes: legHashes } : {}),
      };
    },
  };
}

export interface ScreenedAddress {
  address: string;
  asset: string;
}

/** Resolves true if any address is flagged. Throws rather than pass an unchecked address. */
export type ScreenAddresses = (addresses: ScreenedAddress[]) => Promise<boolean>;

/** Sanctions screening through SwapKit, which its docs say to run when a user intends to swap. */
export function createSwapKitScreen(options: { apiKey: string; fetch?: FetchLike }): ScreenAddresses {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return async (addresses) => {
    const response = await fetchImpl(`${BASE_URL}/screen`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": options.apiKey },
      body: JSON.stringify({
        addresses: addresses.map((entry) => entry.address),
        chains: addresses.map((entry) => getAsset(entry.asset).swapkitChain),
      }),
    });
    if (!response.ok) throw new VenueError(VENUE, response.status, `/screen returned ${response.status}`);
    const { isRisky } = (await response.json()) as { isRisky?: unknown };
    if (typeof isRisky !== "boolean") throw new VenueError(VENUE, 502, "/screen gave no verdict");
    return isRisky;
  };
}
