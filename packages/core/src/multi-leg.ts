import { getAsset, listAssets, type Asset, type AssetId } from "./assets.ts";
import { fromBaseUnits, preferDirectRoutes, rankRoutes, type Route } from "./routes.ts";
import type { QuoteRequest, Venue } from "./venues/types.ts";

/**
 * Two-leg routes (FR-14). When no venue serves a pair, a swap can still go through a hub token:
 * one leg into the hub, one leg out of it. The caller holds the hub in their own wallet between
 * the legs, so Crossfare never touches the funds, and signs each leg in turn.
 */

const NATIVE_EVM = "0x0000000000000000000000000000000000000000";

/**
 * Stablecoins worth holding between legs, by contract, so a look-alike with the same symbol is
 * never picked. Only the issuers' own deployments: bridged copies are left out.
 */
const STABLE_HUBS: Record<string, readonly string[]> = {
  eth: ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0xdac17f958d2ee523a2206206994597c13d831ec7"],
  base: ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"],
  arb: ["0xaf88d065e77c8cc2239327c5edb3a432268e5831", "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9"],
  op: ["0x0b2c639c533813f4aa9d7837caf62653d097ff85", "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58"],
  pol: ["0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", "0xc2132d05d31c914a87c6611c10748aeb04b58e8f"],
  bsc: ["0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", "0x55d398326f99059ff775485246999027b3197955"],
  avax: ["0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7"],
};

/** Each request tries at most this many hubs, so one quote can't use up a venue's rate limit. */
export const MAX_INTERMEDIATES = 2;

const isNative = (asset: Asset) =>
  asset.uniswap ? asset.uniswap.address.toLowerCase() === NATIVE_EVM : !!asset.swapkit && !asset.swapkit.includes("-");

const contractOf = (asset: Asset) => (asset.uniswap?.address ?? asset.swapkit?.split("-")[1] ?? "").toLowerCase();

/** The chain's native coin, then its USDC and USDT. A chain with several native coins gets none. */
export function hubAssets(chain: string): AssetId[] {
  const onChain = listAssets().filter((asset) => asset.chain === chain);
  // A list can name one coin twice; it is still one coin.
  const natives = [...new Map(onChain.filter(isNative).map((asset) => [asset.id, asset])).values()];
  const stables = (STABLE_HUBS[chain] ?? []).flatMap((contract) => onChain.find((asset) => !isNative(asset) && contractOf(asset) === contract) ?? []);
  return [...(natives.length === 1 ? natives : []), ...stables].map((asset) => asset.id);
}

const anyServes = (venues: readonly Venue[], from: Asset, to: Asset) => venues.some((venue) => !venue.serves || venue.serves(from, to));

/**
 * Hubs on the source or destination chain, where the caller already has an address, that some
 * venue serves into and some venue serves out of. Native coins come first, then stablecoins,
 * the destination chain before the source.
 */
export function intermediates(venues: readonly Venue[], request: QuoteRequest, limit = MAX_INTERMEDIATES): AssetId[] {
  const from = getAsset(request.from.asset);
  const to = getAsset(request.to.asset);
  const toHubs = hubAssets(to.chain);
  const fromHubs = from.chain === to.chain ? [] : hubAssets(from.chain);
  const interleaved = [toHubs[0], fromHubs[0], ...toHubs.slice(1), ...fromHubs.slice(1)].filter((id): id is AssetId => !!id);
  const candidates = [...new Set(interleaved)].filter((id) => id !== from.id && id !== to.id);
  return candidates
    .filter((id) => {
      const hub = getAsset(id);
      return anyServes(venues, from, hub) && anyServes(venues, hub, to);
    })
    .slice(0, limit);
}

/** The caller's own address on the hub's chain: the sender's on the source chain, else the recipient's. */
function holder(request: QuoteRequest, hub: AssetId): string {
  return getAsset(hub).chain === getAsset(request.from.asset).chain ? request.from.address : request.to.address;
}

const shared = (request: QuoteRequest) => ({
  mode: "exact_in" as const,
  slippageBps: request.slippageBps,
  ...(request.indicative ? { indicative: true } : {}),
});

function firstLegRequest(request: QuoteRequest, hub: AssetId): QuoteRequest {
  return {
    ...shared(request),
    from: request.from,
    to: { asset: hub, address: holder(request, hub) },
    ...(request.refundAddress ? { refundAddress: request.refundAddress } : {}),
    ...(request.flexibleDeposit ? { flexibleDeposit: true } : {}),
  };
}

/** The caller's fee goes on the last leg only, so it's charged once, on what they receive. */
function secondLegRequest(request: QuoteRequest, hub: AssetId, amountIn: string): QuoteRequest {
  const address = holder(request, hub);
  return {
    ...shared(request),
    from: { asset: hub, amount: fromBaseUnits(amountIn, getAsset(hub).decimals), address },
    to: request.to,
    ...(address ? { refundAddress: address } : {}),
    ...(request.fee ? { fee: request.fee } : {}),
  };
}

/**
 * The request for one leg of a planned route. The second leg runs on what the first delivered,
 * which the caller can name as `amountIn` (base units); otherwise it's the planned amount.
 */
export function legRequest(request: QuoteRequest, route: Route, index: number, amountIn?: string): QuoteRequest {
  const legs = route.legs;
  if (!legs || legs.length !== 2 || (index !== 0 && index !== 1)) throw new Error("not a two-leg route");
  const hub = legs[0]!.to;
  return index === 0 ? firstLegRequest(request, hub) : secondLegRequest(request, hub, amountIn ?? legs[1]!.amountIn);
}

const prefixed = (leg: number, fees: Record<string, string>) =>
  Object.fromEntries(Object.entries(fees).map(([key, value]) => [`leg${leg}.${key}`, value]));

/**
 * One route from two legs. The guarantee is the second leg's minimum on the least the first leg
 * delivers, so it holds when both legs fill at their worst.
 */
export function composeRoute(first: Route, second: Route): Route {
  const minAmountOut = (BigInt(second.minAmountOut) * BigInt(first.minAmountOut)) / BigInt(second.amountIn || "1");
  return {
    venue: `${first.venue}+${second.venue}`,
    from: first.from,
    to: second.to,
    amountIn: first.amountIn,
    amountOut: second.amountOut,
    minAmountOut: minAmountOut.toString(),
    fees: { ...prefixed(1, first.fees), ...prefixed(2, second.fees) },
    etaSeconds: first.etaSeconds + second.etaSeconds,
    validUntil: first.validUntil < second.validUntil ? first.validUntil : second.validUntil,
    ...(first.usd && second.usd ? { usd: { in: first.usd.in, out: second.usd.out } } : {}),
    // The second leg always needs the caller to act, so no single transfer pays for the route.
    depositable: false,
    venueData: null,
    legs: [first, second],
  };
}

/** Every venue's routes for one leg, best first, asking only the venues that serve it. */
async function quoteLeg(venues: readonly Venue[], request: QuoteRequest, onError: (error: unknown) => void): Promise<Route[]> {
  const from = getAsset(request.from.asset);
  const to = getAsset(request.to.asset);
  const asked = venues.filter((venue) => !venue.serves || venue.serves(from, to));
  const answers = await Promise.allSettled(asked.map((venue) => venue.quote(request)));
  for (const answer of answers) if (answer.status === "rejected") onError(answer.reason);
  return rankRoutes(preferDirectRoutes(asked, answers.flatMap((answer) => (answer.status === "fulfilled" ? answer.value : []))));
}

export interface TwoLegOptions {
  maxIntermediates?: number;
  onError?: (error: unknown) => void;
}

/**
 * Two-leg routes through each hub, best first. The first leg is the best route into the hub; the
 * second is quoted at what it's expected to deliver, once per venue that answers.
 */
export async function findTwoLegRoutes(venues: readonly Venue[], request: QuoteRequest, options: TwoLegOptions = {}): Promise<Route[]> {
  if (request.mode !== "exact_in") return [];
  const onError = options.onError ?? (() => {});
  const hubs = intermediates(venues, request, options.maxIntermediates ?? MAX_INTERMEDIATES);
  const perHub = await Promise.all(
    hubs.map(async (hub) => {
      const [first] = await quoteLeg(venues, firstLegRequest(request, hub), onError);
      if (!first) return [];
      const seconds = await quoteLeg(venues, secondLegRequest(request, hub, first.amountOut), onError);
      return seconds.map((second) => composeRoute(first, second));
    }),
  );
  return rankRoutes(perHub.flat());
}
