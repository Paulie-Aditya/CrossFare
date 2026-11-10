import { encodeFunctionData, erc20Abi, type Address } from "viem";
import { displaySymbol, getAsset, toBaseUnits, type Asset } from "../assets.ts";
import { fromBaseUnits, type Route } from "../routes.ts";
import {
  VenueError,
  toHexValue,
  type FetchLike,
  type PreparedSwap,
  type QuoteRequest,
  type SwapStatus,
  type TrackInput,
  type TrackResult,
  type Venue,
} from "./types.ts";

const BASE_URL = "https://1click.chaindefuser.com";
const VENUE = "near-intents";
const QUOTE_TTL_MS = 5 * 60_000;
const TOKENS_TTL_MS = 60 * 60_000;
/**
 * When 1Click starts refunding a deposit that hasn't swapped. Longer than Crossfare's
 * 30-minute order window, so a deposit sent near its end still has time to confirm.
 */
const DEADLINE_MS = 60 * 60_000;
const NATIVE_EVM = "0x0000000000000000000000000000000000000000";

/** A token as GET /v0/tokens lists it. */
export interface NearToken {
  assetId: string;
  blockchain: string;
  symbol: string;
  decimals: number;
  contractAddress?: string;
}

/** SwapKit's chain prefixes and the EVM chain IDs, in 1Click's chain names. */
const BLOCKCHAIN_BY_PREFIX: Record<string, string> = {
  ETH: "eth",
  BASE: "base",
  ARB: "arb",
  OP: "op",
  POL: "pol",
  BSC: "bsc",
  AVAX: "avax",
  GNO: "gnosis",
  BERA: "bera",
  MONAD: "monad",
  XLAYER: "xlayer",
  HOOD: "hood",
  BTC: "btc",
  LTC: "ltc",
  BCH: "bch",
  DOGE: "doge",
  DASH: "dash",
  ZEC: "zec",
  SOL: "sol",
  XRP: "xrp",
  TRON: "tron",
  TON: "ton",
  SUI: "sui",
  NEAR: "near",
  ADA: "cardano",
  XLM: "stellar",
  STRK: "starknet",
};
const BLOCKCHAIN_BY_CHAIN_ID: Record<number, string> = {
  1: "eth",
  8453: "base",
  42161: "arb",
  10: "op",
  137: "pol",
  56: "bsc",
  43114: "avax",
  143: "monad",
  196: "xlayer",
};

/** 1Click can only take a deposit on these chains with a memo, which not every wallet can send. */
const MEMO_CHAINS = new Set(["stellar", "ton"]);

const STATUS: Record<string, SwapStatus> = {
  PENDING_DEPOSIT: "awaiting_deposit",
  INCOMPLETE_DEPOSIT: "awaiting_deposit",
  KNOWN_DEPOSIT_TX: "confirming",
  PROCESSING: "exchanging",
  SUCCESS: "completed",
  REFUNDED: "refunded",
  FAILED: "failed",
};

/** The chain and contract an asset lives at, in 1Click's terms. A native coin has no contract. */
function locate(asset: Asset): { blockchain: string; contract?: string } | undefined {
  if (asset.swapkit) {
    const [prefix, rest = ""] = asset.swapkit.split(/\.(.*)/s);
    const blockchain = BLOCKCHAIN_BY_PREFIX[prefix!];
    const dash = rest.indexOf("-");
    return blockchain ? { blockchain, ...(dash >= 0 ? { contract: rest.slice(dash + 1) } : {}) } : undefined;
  }
  if (asset.uniswap) {
    const blockchain = BLOCKCHAIN_BY_CHAIN_ID[asset.uniswap.chainId];
    const native = asset.uniswap.address.toLowerCase() === NATIVE_EVM;
    return blockchain ? { blockchain, ...(native ? {} : { contract: asset.uniswap.address }) } : undefined;
  }
  return undefined;
}

/** EVM addresses are case-insensitive. Others, such as Solana's, are not. */
const sameContract = (a: string, b: string) => (a.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b);

/** 1Click's entry for an asset. Decimals must agree, or every amount would be off by a power of ten. */
export function findNearToken(asset: Asset, tokens: readonly NearToken[]): NearToken | undefined {
  const place = locate(asset);
  if (!place) return undefined;
  const match = tokens.find(
    (token) =>
      token.blockchain === place.blockchain &&
      (place.contract
        ? !!token.contractAddress && sameContract(token.contractAddress, place.contract)
        : !token.contractAddress && token.symbol.toLowerCase() === asset.symbol.toLowerCase()),
  );
  return match?.decimals === asset.decimals ? match : undefined;
}

interface ApiQuote {
  amountIn: string;
  minAmountIn: string;
  amountOut: string;
  minAmountOut: string;
  amountInUsd?: string;
  amountOutUsd?: string;
  timeEstimate?: number;
  withdrawFee?: string;
  depositAddress?: string;
  depositMemo?: string;
}

interface ApiStatus {
  status: string;
  swapDetails?: {
    amountOutFormatted?: string | null;
    depositedAmountFormatted?: string | null;
    refundedAmount?: string | null;
    refundReason?: string | null;
    originChainTxHashes?: { hash: string }[];
    destinationChainTxHashes?: { hash: string }[];
  };
}

interface NearVenueData {
  originAsset: string;
  destinationAsset: string;
}

/**
 * The caller's Intents account for its fee: a named account, an implicit one or an EVM address.
 * Null charges no fee.
 */
function feeRecipient(request: QuoteRequest): string | null {
  const fee = request.fee;
  return fee && fee.bps > 0 ? (fee.recipients.near ?? fee.recipients.evm ?? null) : null;
}

export interface NearIntentsOptions {
  /** A 1Click partner key, sent when set. */
  apiKey?: string;
  fetch?: FetchLike;
  now?: () => Date;
}

export function createNearIntentsVenue(options: NearIntentsOptions): Venue {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  let tokens: { at: number; list: NearToken[] } | null = null;

  const headers = (extra: Record<string, string> = {}) => ({
    ...extra,
    ...(options.apiKey ? { "x-api-key": options.apiKey } : {}),
  });

  async function tokenList(): Promise<NearToken[]> {
    if (tokens && now().getTime() - tokens.at < TOKENS_TTL_MS) return tokens.list;
    const response = await fetchImpl(`${BASE_URL}/v0/tokens`, { headers: headers() });
    if (!response.ok) {
      // A stale list still names the right tokens, so it beats no route at all.
      if (tokens) return tokens.list;
      throw new VenueError(VENUE, response.status, `/v0/tokens returned ${response.status}`);
    }
    tokens = { at: now().getTime(), list: (await response.json()) as NearToken[] };
    return tokens.list;
  }

  function ask(request: QuoteRequest, dry: boolean, data: NearVenueData): Promise<Response> {
    const exactIn = request.mode === "exact_in";
    const amountAsset = getAsset(exactIn ? request.from.asset : request.to.asset);
    const recipient = feeRecipient(request);
    return fetchImpl(`${BASE_URL}/v0/quote`, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        dry,
        swapType: !exactIn ? "EXACT_OUTPUT" : request.flexibleDeposit ? "FLEX_INPUT" : "EXACT_INPUT",
        slippageTolerance: request.slippageBps,
        originAsset: data.originAsset,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: data.destinationAsset,
        amount: toBaseUnits(request.from.amount, amountAsset.decimals).toString(),
        refundTo: request.refundAddress ?? request.from.address,
        refundType: "ORIGIN_CHAIN",
        recipient: request.to.address,
        recipientType: "DESTINATION_CHAIN",
        deadline: new Date(now().getTime() + DEADLINE_MS).toISOString(),
        // 1Click keeps half of the app fee, and at least 20 bps, out of what the customer pays.
        ...(recipient && request.fee ? { appFees: [{ recipient, fee: request.fee.bps }] } : {}),
        referral: "crossfare",
      }),
    });
  }

  return {
    name: VENUE,
    replaces: ["near"],

    // 1Click's token list is fetched, so this goes by chain: a token it doesn't list still answers no route.
    serves: (from, to) => locate(from) !== undefined && locate(to) !== undefined,

    async quote(request: QuoteRequest): Promise<Route[]> {
      // 1Click won't quote without real addresses, and it has a price check's worth of nothing to say.
      if (request.indicative) return [];
      const from = getAsset(request.from.asset);
      const to = getAsset(request.to.asset);
      const list = await tokenList();
      const origin = findNearToken(from, list);
      const destination = findNearToken(to, list);
      if (!origin || !destination) return [];

      const venueData: NearVenueData = { originAsset: origin.assetId, destinationAsset: destination.assetId };
      const response = await ask(request, true, venueData);
      // 1Click answers 400 for a pair, amount or address it won't serve.
      if (response.status === 400) return [];
      if (!response.ok) throw new VenueError(VENUE, response.status, `/v0/quote returned ${response.status}`);
      const { quote, quoteRequest } = (await response.json()) as { quote: ApiQuote; quoteRequest?: { appFees?: { recipient: string; fee: number }[] } };
      // What reaches the caller, as 1Click restates the fees it will apply.
      const recipient = feeRecipient(request);
      const passedOn = recipient ? quoteRequest?.appFees?.find((fee) => fee.recipient === recipient)?.fee : undefined;

      const usdIn = Number(quote.amountInUsd);
      const usdOut = Number(quote.amountOutUsd);
      return [
        {
          venue: VENUE,
          from: from.id,
          to: to.id,
          amountIn: quote.amountIn,
          amountOut: quote.amountOut,
          minAmountOut: quote.minAmountOut,
          fees: {
            ...(passedOn ? { integrator: `${passedOn} bps` } : {}),
            ...(quote.withdrawFee ? { withdraw: `${fromBaseUnits(quote.withdrawFee, to.decimals)} ${displaySymbol(to.symbol)}` } : {}),
          },
          etaSeconds: quote.timeEstimate ?? 0,
          validUntil: new Date(now().getTime() + QUOTE_TTL_MS).toISOString(),
          depositable: !MEMO_CHAINS.has(origin.blockchain),
          ...(Number.isFinite(usdIn) && Number.isFinite(usdOut) && quote.amountInUsd && quote.amountOutUsd
            ? { usd: { in: usdIn, out: usdOut } }
            : {}),
          venueData,
        },
      ];
    },

    async prepare(route: Route, request: QuoteRequest): Promise<PreparedSwap> {
      if (request.indicative) throw new VenueError(VENUE, 422, "a price check can't be executed");
      const response = await ask(request, false, route.venueData as NearVenueData);
      if (!response.ok) throw new VenueError(VENUE, response.status, `/v0/quote returned ${response.status}`);
      const { quote, quoteRequest } = (await response.json()) as { quote: ApiQuote; quoteRequest: { deadline: string } };
      if (!quote.depositAddress) throw new VenueError(VENUE, 502, "/v0/quote returned no deposit address");

      const source = getAsset(route.from);
      const deposit = {
        asset: source.id,
        address: quote.depositAddress,
        ...(quote.depositMemo ? { memo: quote.depositMemo } : {}),
        amount: fromBaseUnits(quote.amountIn, source.decimals),
        // 1Click refunds a deposit below this by its deadline.
        minAmount: fromBaseUnits(quote.minAmountIn, source.decimals),
        expiresAt: new Date(quoteRequest.deadline).toISOString(),
      };

      // An EVM wallet can sign the transfer itself. Other chains pay the address from any wallet.
      const transactions = [];
      if (source.evmChainId !== undefined && source.uniswap) {
        const token = source.uniswap.address;
        const native = token.toLowerCase() === NATIVE_EVM;
        transactions.push({
          kind: "swap" as const,
          chainId: source.evmChainId,
          to: native ? quote.depositAddress : token,
          data: native
            ? "0x"
            : encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [quote.depositAddress as Address, BigInt(quote.amountIn)] }),
          value: toHexValue(native ? quote.amountIn : "0"),
        });
      }
      return { venueSwapId: quote.depositAddress, transactions, deposit };
    },

    async track({ prepared }: TrackInput): Promise<TrackResult> {
      const deposit = prepared.deposit;
      if (!deposit) return { status: "awaiting_deposit" };
      const query = new URLSearchParams({ depositAddress: deposit.address, ...(deposit.memo ? { depositMemo: deposit.memo } : {}) });
      const response = await fetchImpl(`${BASE_URL}/v0/status?${query}`, { headers: headers() });
      // Right after a quote, 1Click may not know the address yet.
      if (response.status === 404) return { status: "awaiting_deposit" };
      if (!response.ok) throw new VenueError(VENUE, response.status, `/v0/status returned ${response.status}`);

      const { status: raw, swapDetails: details = {} } = (await response.json()) as ApiStatus;
      const status = STATUS[raw] ?? "confirming";
      const hashes = [...(details.originChainTxHashes ?? []), ...(details.destinationChainTxHashes ?? [])].map((entry) => entry.hash);
      const refunded = BigInt(details.refundedAmount || "0") > 0n;
      return {
        status,
        ...(status === "completed" && details.amountOutFormatted ? { amountReceived: details.amountOutFormatted } : {}),
        ...(details.depositedAmountFormatted ? { amountSent: details.depositedAmountFormatted } : {}),
        ...(hashes.length ? { txHashes: hashes } : {}),
        ...(details.refundReason ? { refundReason: details.refundReason } : {}),
        ...(status === "completed" && refunded ? { partialRefund: true } : {}),
      };
    },
  };
}
