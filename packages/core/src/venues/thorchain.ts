import { encodeFunctionData, erc20Abi, parseAbi, type Address } from "viem";
import { getAsset, toBaseUnits, type Asset } from "../assets.ts";
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

const VENUE = "thorchain";
/** A public THORNode. Nine Realms' was unreachable when this was written. */
export const DEFAULT_THORNODE_URL = "https://gateway.liquify.com/chain/thorchain_api";
const QUOTE_TTL_MS = 5 * 60_000;
const POOLS_TTL_MS = 10 * 60_000;
/** THORChain counts every asset in 8 decimals. */
const THOR_DECIMALS = 8;
const NATIVE_EVM = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = /^0+$/;
/** Chains whose hashes explorers show with 0x, which THORChain drops. */
const EVM_CHAINS = new Set(["ETH", "BSC", "AVAX", "BASE"]);

export const THORCHAIN_ROUTER_ABI = parseAbi([
  "function depositWithExpiry(address vault, address asset, uint256 amount, string memo, uint256 expiration) payable",
]);

interface ApiQuote {
  inbound_address?: string;
  router?: string;
  memo?: string;
  expected_amount_out: string;
  expiry: number;
  recommended_min_amount_in?: string;
  total_swap_seconds?: number;
  fees?: { asset: string; affiliate?: string; outbound?: string; liquidity?: string };
}

interface ApiTx {
  id: string;
  chain: string;
  to_address: string;
  memo?: string;
  coins: { asset: string; amount: string }[];
}

interface ApiStatus {
  tx?: ApiTx;
  planned_out_txs?: { refund: boolean }[];
  out_txs?: ApiTx[];
  stages: {
    inbound_finalised?: { completed: boolean };
    swap_finalised?: { completed: boolean };
    outbound_signed?: { completed: boolean };
  };
}

interface ThorVenueData {
  inbound?: string;
  router?: string;
  memo?: string;
  expiry: number;
}

/** Moves an amount between an asset's own decimals and THORChain's 8. */
function rescale(amount: bigint, from: number, to: number): bigint {
  return from >= to ? amount / 10n ** BigInt(from - to) : amount * 10n ** BigInt(to - from);
}

/** THORChain's pool name for an asset: SwapKit's identifier, upper-cased. */
const poolName = (asset: Asset) => asset.swapkit?.toUpperCase();

/** "BTC.BTC" or "ETH.USDT-0X…" to the ticker a person reads. */
const ticker = (pool: string) => (pool.split(".")[1] ?? pool).split("-")[0]!;

/** The price limit in a swap memo, `=:asset:destination:limit/interval/quantity:…`. Zero means none. */
function memoLimit(memo: string | undefined): bigint {
  const limit = memo?.split(":")[3]?.split("/")[0];
  return limit && /^\d+$/.test(limit) ? BigInt(limit) : 0n;
}

/** Explorers write a hash in lower case, and an EVM one with 0x. */
function explorerHash(chain: string, hash: string): string {
  if (!/^[0-9A-Fa-f]{64}$/.test(hash)) return hash;
  return EVM_CHAINS.has(chain) ? `0x${hash.toLowerCase()}` : hash.toLowerCase();
}

export interface ThorchainOptions {
  thornodeUrl?: string;
  fetch?: FetchLike;
  now?: () => Date;
}

export function createThorchainVenue(options: ThorchainOptions): Venue {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const node = (options.thornodeUrl ?? DEFAULT_THORNODE_URL).replace(/\/$/, "");
  let pools: { at: number; names: Set<string> } | null = null;

  async function availablePools(): Promise<Set<string>> {
    if (pools && now().getTime() - pools.at < POOLS_TTL_MS) return pools.names;
    const response = await fetchImpl(`${node}/thorchain/pools`);
    if (!response.ok) {
      if (pools) return pools.names;
      throw new VenueError(VENUE, response.status, `/thorchain/pools returned ${response.status}`);
    }
    const list = (await response.json()) as { asset: string; status: string }[];
    pools = { at: now().getTime(), names: new Set(list.filter((pool) => pool.status === "Available").map((pool) => pool.asset)) };
    return pools.names;
  }

  return {
    name: VENUE,
    replaces: ["thorchain", "thorchain_streaming"],

    async quote(request: QuoteRequest): Promise<Route[]> {
      // THORChain fills exact inputs only, and refunds to the sender, which for an exchange isn't the caller.
      if (request.mode !== "exact_in" || request.flexibleDeposit) return [];
      const from = getAsset(request.from.asset);
      const to = getAsset(request.to.asset);
      const fromPool = poolName(from);
      const toPool = poolName(to);
      const names = await availablePools();
      if (!fromPool || !toPool || !names.has(fromPool) || !names.has(toPool)) return [];

      const amountIn = toBaseUnits(request.from.amount, from.decimals);
      // The caller's THORName. A thor1 address would make the memo too long for Bitcoin-style chains.
      const affiliate = request.fee && request.fee.bps > 0 ? request.fee.recipients.thorchain : undefined;
      const params = new URLSearchParams({
        from_asset: fromPool,
        to_asset: toPool,
        amount: rescale(amountIn, from.decimals, THOR_DECIMALS).toString(),
        ...(request.indicative ? {} : { destination: request.to.address }),
        streaming_interval: "1",
        streaming_quantity: "0",
        // Slippage on price alone. Plain tolerance_bps also counts THORChain's fees, which can exceed it.
        liquidity_tolerance_bps: String(request.slippageBps),
        ...(affiliate && request.fee ? { affiliate, affiliate_bps: String(request.fee.bps) } : {}),
      });
      const response = await fetchImpl(`${node}/thorchain/quote/swap?${params}`);
      // A halted chain, an amount below dust or a memo too long for the source chain.
      if (response.status === 400) return [];
      if (!response.ok) throw new VenueError(VENUE, response.status, `/thorchain/quote/swap returned ${response.status}`);
      const quote = (await response.json()) as ApiQuote;
      // Below THORChain's recommended amount, fees can eat the swap and it is refunded.
      if (quote.recommended_min_amount_in && rescale(amountIn, from.decimals, THOR_DECIMALS) < BigInt(quote.recommended_min_amount_in)) {
        return [];
      }

      const amountOut = rescale(BigInt(quote.expected_amount_out), THOR_DECIMALS, to.decimals);
      const limit = memoLimit(quote.memo);
      const minAmountOut =
        limit > 0n ? rescale(limit, THOR_DECIMALS, to.decimals) : (amountOut * BigInt(10_000 - request.slippageBps)) / 10_000n;
      const fees = quote.fees;
      const feeLine = (amount: string) => `${fromBaseUnits(amount, THOR_DECIMALS)} ${ticker(fees!.asset)}`;
      const venueData: ThorVenueData = {
        ...(quote.inbound_address ? { inbound: quote.inbound_address } : {}),
        ...(quote.router ? { router: quote.router } : {}),
        ...(quote.memo ? { memo: quote.memo } : {}),
        expiry: quote.expiry,
      };
      return [
        {
          venue: VENUE,
          from: from.id,
          to: to.id,
          amountIn: amountIn.toString(),
          amountOut: amountOut.toString(),
          minAmountOut: minAmountOut.toString(),
          fees: fees
            ? Object.fromEntries(
                (["affiliate", "outbound", "liquidity"] as const).flatMap((kind) =>
                  fees[kind] && fees[kind] !== "0" ? [[kind === "affiliate" ? "integrator" : kind, feeLine(fees[kind])]] : [],
                ),
              )
            : {},
          etaSeconds: quote.total_swap_seconds ?? 0,
          validUntil: new Date(Math.min(now().getTime() + QUOTE_TTL_MS, quote.expiry * 1000)).toISOString(),
          // The deposit must carry the memo, which a plain transfer from most wallets can't.
          depositable: false,
          venueData,
        },
      ];
    },

    async prepare(route: Route, request: QuoteRequest): Promise<PreparedSwap> {
      const data = route.venueData as ThorVenueData;
      if (request.indicative || !data.memo || !data.inbound) {
        throw new VenueError(VENUE, 422, "this quote has no memo to deposit with");
      }
      const source = getAsset(route.from);
      const amount = toBaseUnits(request.from.amount, source.decimals);

      if (source.evmChainId !== undefined) {
        if (!data.router) throw new VenueError(VENUE, 502, "the quote named no router");
        const token = source.uniswap?.address ?? source.swapkit?.split("-")[1];
        if (!token) throw new VenueError(VENUE, 502, `no contract for ${source.id}`);
        const native = token.toLowerCase() === NATIVE_EVM;
        const chainId = source.evmChainId;
        const router = data.router as Address;
        const transactions: UnsignedTransaction[] = [
          ...(native
            ? []
            : [
                {
                  kind: "approval" as const,
                  chainId,
                  to: token,
                  data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [router, amount] }),
                  value: "0x0",
                },
              ]),
          {
            kind: "swap",
            chainId,
            to: router,
            data: encodeFunctionData({
              abi: THORCHAIN_ROUTER_ABI,
              functionName: "depositWithExpiry",
              args: [data.inbound as Address, (native ? NATIVE_EVM : token) as Address, amount, data.memo, BigInt(data.expiry)],
            }),
            value: toHexValue(native ? amount.toString() : "0"),
          },
        ];
        return { transactions };
      }

      return {
        transactions: [],
        deposit: {
          asset: source.id,
          address: data.inbound,
          memo: data.memo,
          amount: request.from.amount,
          expiresAt: new Date(data.expiry * 1000).toISOString(),
        },
      };
    },

    async track({ route, request, txHashes }: TrackInput): Promise<TrackResult> {
      const hash = txHashes.at(-1);
      if (!hash) return { status: "awaiting_deposit" };
      const id = hash.replace(/^0x/i, "").toUpperCase();
      const response = await fetchImpl(`${node}/thorchain/tx/status/${id}`);
      if (!response.ok) throw new VenueError(VENUE, response.status, `/thorchain/tx/status returned ${response.status}`);
      const status = (await response.json()) as ApiStatus;

      const memo = (route.venueData as ThorVenueData).memo;
      const tx = status.tx;
      // Anyone can submit a hash, so it only counts if it carries this swap's memo.
      if (!tx || !memo || tx.memo?.toLowerCase() !== memo.toLowerCase()) return { status: "confirming" };

      const sent = tx.coins[0] ? { amountSent: fromBaseUnits(tx.coins[0].amount, THOR_DECIMALS) } : {};
      const outs = (status.out_txs ?? []).filter((out) => !ZERO_HASH.test(out.id));
      const hashes = [hash, ...outs.map((out) => explorerHash(out.chain, out.id))];
      const signed = status.stages.outbound_signed?.completed === true;

      if (status.planned_out_txs?.some((out) => out.refund)) {
        return signed ? { status: "refunded", ...sent, txHashes: hashes } : { status: "exchanging", ...sent };
      }
      if (status.stages.swap_finalised?.completed && signed) {
        const delivered = outs.find((out) => out.to_address.toLowerCase() === request.to.address.toLowerCase());
        return {
          status: "completed",
          ...sent,
          ...(delivered?.coins[0] ? { amountReceived: fromBaseUnits(delivered.coins[0].amount, THOR_DECIMALS) } : {}),
          txHashes: hashes,
        };
      }
      return { status: status.stages.inbound_finalised?.completed ? "exchanging" : "confirming", ...sent };
    },
  };
}
