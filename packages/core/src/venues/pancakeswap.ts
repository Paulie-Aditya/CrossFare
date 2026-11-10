import { encodeFunctionData, erc20Abi, parseAbi, type Address } from "viem";
import { displaySymbol, getAsset, toBaseUnits, type Asset } from "../assets.ts";
import { fromBaseUnits, type Route } from "../routes.ts";
import { deliveredAmount, sameAddress, type GetReceipt } from "./evm-receipt.ts";
import { VenueError, type PreparedSwap, type QuoteRequest, type TrackInput, type TrackResult, type UnsignedTransaction, type Venue } from "./types.ts";

/**
 * PancakeSwap, reached directly: its pools are quoted on-chain and its Universal Router called
 * with calldata built here, so the caller's fee goes to their own wallet in the same transaction
 * (PAY_PORTION). PancakeSwap's hosted aggregator doesn't cover BNB Chain and pays fees to one
 * wallet only, so it isn't used.
 */

const VENUE = "pancakeswap";
const NATIVE_EVM = "0x0000000000000000000000000000000000000000";
/** Where PancakeSwap trades for Crossfare. BNB Chain only, for now. */
export const PANCAKESWAP_CHAINS: readonly number[] = [56];
/** PancakeSwap's own Permit2, the same address on every chain it lists. Not Uniswap's. */
export const PANCAKE_PERMIT2 = "0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768";
export const PERMIT2_ABI = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);

/** A quote is a reading of the pools; refresh it within the minute. */
const QUOTE_TTL_MS = 60_000;
/** How long the router may pull the token through Permit2. */
const PERMIT2_TTL_S = 30 * 86_400;

export interface PancakeToken {
  address: string;
  decimals: number;
  symbol: string;
}

export interface PancakeQuoteInput {
  chainId: number;
  tokenIn: PancakeToken;
  tokenOut: PancakeToken;
  amountIn: bigint;
  slippageBps: number;
  /** Set when the caller can execute, so calldata is built for them. */
  recipient?: string;
  /** The caller's fee, paid from the output to their wallet. */
  fee?: { bps: number; recipient: string };
}

export interface PancakeQuote {
  /** The trade's output, before the caller's fee. */
  amountOut: bigint;
  /** The least the trade delivers at the slippage given, before the caller's fee. */
  minAmountOut: bigint;
  /** The Universal Router call, when a recipient was given. */
  transaction?: { to: string; data: string; value: string };
}

/** Finds the best trade across PancakeSwap's pools. Null when no pools connect the pair. */
export interface PancakeRouter {
  quote(input: PancakeQuoteInput): Promise<PancakeQuote | null>;
}

export interface Permit2Allowances {
  /** What the token lets Permit2 move. */
  token: bigint;
  /** What Permit2 lets the router move, and until when (seconds). */
  router: { amount: bigint; expiration: number };
}

export interface PancakeSwapOptions {
  router: PancakeRouter;
  getReceipt?: GetReceipt;
  /** Reads the wallet's allowances, so approvals already given aren't asked for again. */
  readAllowances?: (chainId: number, token: string, owner: string, spender: string) => Promise<Permit2Allowances>;
  now?: () => Date;
}

interface PancakeVenueData {
  transaction?: { to: string; data: string; value: string };
  feeBps: number;
}

function tokenOf(asset: Asset): (PancakeToken & { chainId: number }) | null {
  const token = asset.uniswap;
  if (!token || !PANCAKESWAP_CHAINS.includes(token.chainId)) return null;
  return { chainId: token.chainId, address: token.address, decimals: asset.decimals, symbol: displaySymbol(asset.symbol) };
}

const lessFee = (amount: bigint, bps: number) => amount - (amount * BigInt(bps)) / 10_000n;

export function createPancakeSwapVenue(options: PancakeSwapOptions): Venue {
  const now = options.now ?? (() => new Date());

  return {
    name: VENUE,

    serves(from, to) {
      const tokenIn = tokenOf(from);
      const tokenOut = tokenOf(to);
      return !!tokenIn && !!tokenOut && tokenIn.chainId === tokenOut.chainId;
    },

    async quote(request: QuoteRequest): Promise<Route[]> {
      if (request.mode !== "exact_in") return [];
      const from = getAsset(request.from.asset);
      const to = getAsset(request.to.asset);
      const tokenIn = tokenOf(from);
      const tokenOut = tokenOf(to);
      if (!tokenIn || !tokenOut || tokenIn.chainId !== tokenOut.chainId) return [];

      const wallet = request.fee && request.fee.bps > 0 ? request.fee.recipients.evm : undefined;
      const feeBps = wallet ? request.fee!.bps : 0;
      const amountIn = toBaseUnits(request.from.amount, from.decimals);
      let quote: PancakeQuote | null;
      try {
        quote = await options.router.quote({
          chainId: tokenIn.chainId,
          tokenIn: { address: tokenIn.address, decimals: tokenIn.decimals, symbol: tokenIn.symbol },
          tokenOut: { address: tokenOut.address, decimals: tokenOut.decimals, symbol: tokenOut.symbol },
          amountIn,
          slippageBps: request.slippageBps,
          ...(request.indicative ? {} : { recipient: request.to.address }),
          ...(wallet ? { fee: { bps: feeBps, recipient: wallet } } : {}),
        });
      } catch (error) {
        throw new VenueError(VENUE, 502, `quote failed: ${(error as Error).message}`);
      }
      if (!quote) return [];

      const fee = quote.amountOut - lessFee(quote.amountOut, feeBps);
      const venueData: PancakeVenueData = { feeBps, ...(quote.transaction ? { transaction: quote.transaction } : {}) };
      return [{
        venue: VENUE,
        from: from.id,
        to: to.id,
        amountIn: amountIn.toString(),
        amountOut: lessFee(quote.amountOut, feeBps).toString(),
        minAmountOut: lessFee(quote.minAmountOut, feeBps).toString(),
        fees: fee > 0n ? { integrator: `${fromBaseUnits(fee.toString(), to.decimals)} ${displaySymbol(to.symbol)}` } : {},
        // A few BNB Chain blocks.
        etaSeconds: 15,
        validUntil: new Date(now().getTime() + QUOTE_TTL_MS).toISOString(),
        venueData,
      }];
    },

    async prepare(route: Route, request: QuoteRequest): Promise<PreparedSwap> {
      const { transaction } = route.venueData as PancakeVenueData;
      if (!transaction) throw new VenueError(VENUE, 422, "a price check can't be executed");
      const token = tokenOf(getAsset(route.from));
      if (!token) throw new VenueError(VENUE, 422, `${route.from} is not on PancakeSwap`);

      const transactions: UnsignedTransaction[] = [];
      if (token.address.toLowerCase() !== NATIVE_EVM) {
        const amount = BigInt(route.amountIn);
        const nowSeconds = Math.floor(now().getTime() / 1000);
        const allowed = options.readAllowances
          ? await options.readAllowances(token.chainId, token.address, request.from.address, transaction.to)
          : { token: 0n, router: { amount: 0n, expiration: 0 } };
        if (allowed.token < amount) {
          transactions.push({
            kind: "approval",
            chainId: token.chainId,
            to: token.address,
            data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PANCAKE_PERMIT2, amount] }),
            value: "0x0",
          });
        }
        if (allowed.router.amount < amount || allowed.router.expiration <= nowSeconds) {
          transactions.push({
            kind: "approval",
            chainId: token.chainId,
            to: PANCAKE_PERMIT2,
            data: encodeFunctionData({
              abi: PERMIT2_ABI,
              functionName: "approve",
              args: [token.address as Address, transaction.to as Address, amount, nowSeconds + PERMIT2_TTL_S],
            }),
            value: "0x0",
          });
        }
      }
      transactions.push({ kind: "swap", chainId: token.chainId, ...transaction });
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
      const { feeBps } = route.venueData as PancakeVenueData;
      const amount = deliveredAmount(receipt, output.uniswap, request.to.address, feeBps);
      if (amount === null) return { status: "completed" };
      return { status: "completed", amountReceived: fromBaseUnits(amount.toString(), output.decimals) };
    },
  };
}
