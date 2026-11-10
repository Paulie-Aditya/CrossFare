import { walletChain } from "./wallet-chains.ts";

export interface PublicRoute {
  quoteId: string;
  venue: string;
  provider?: string;
  amountOut: string;
  minAmountOut: string;
  fees: Record<string, string>;
  etaSeconds: number;
  validUntil: string;
  depositable?: boolean;
  usd?: { in: number; out: number };
  arkiv: { entityKey: string | null; pending: boolean };
  /** Set on a route in two legs: the caller holds the first leg's output, the hub, until signing the second. */
  legs?: RouteLeg[];
}

export interface RouteLeg {
  venue: string;
  provider?: string;
  from: string;
  to: string;
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  etaSeconds: number;
}

/** A leg of a swap in progress, as status reports it. */
export interface LegStatus {
  venue: string;
  status: string;
  amountReceived?: string;
}

/** An unsigned Solana transaction, to sign and send before it lapses with its blockhash. */
export interface SolanaTransaction {
  transaction: string;
  lastValidBlockHeight: number;
}

export interface SwapTransaction {
  kind: "approval" | "swap";
  chainId: number;
  to: string;
  data: string;
  value: string;
}

export interface Deposit {
  asset: string;
  address: string;
  memo?: string;
  amount: string;
  expiresAt?: string;
  channelId?: string;
  minAmount?: string;
  refundBy?: string;
}

export type Step = "idle" | "quoting" | "quoted" | "preparing" | "signing" | "tracking" | "finished";

export interface JourneyState {
  step: Step;
  requestId: string | null;
  swapToken: string | null;
  routes: PublicRoute[];
  quotePayment: string | null;
  chosenQuoteId: string | null;
  swapId: string | null;
  swapPayment: string | null;
  transactions: SwapTransaction[];
  deposit: Deposit | null;
  txHashes: string[];
  swapStatus: string | null;
  amountReceived: string | null;
  amountSent: string | null;
  depositShort: string | null;
  refundReason: string | null;
  partialRefund: boolean;
  error: string | null;
  notice: string | null;
  /** On a two-leg route: the leg in progress, from 1. */
  leg: number | null;
  legCount: number | null;
  /** What the first leg delivered, which the second leg spends. */
  hubReceived: string | null;
  solana: SolanaTransaction | null;
}

export const initialJourney: JourneyState = {
  step: "idle",
  requestId: null,
  swapToken: null,
  routes: [],
  quotePayment: null,
  chosenQuoteId: null,
  swapId: null,
  swapPayment: null,
  transactions: [],
  deposit: null,
  txHashes: [],
  swapStatus: null,
  amountReceived: null,
  amountSent: null,
  depositShort: null,
  refundReason: null,
  partialRefund: false,
  error: null,
  notice: null,
  leg: null,
  legCount: null,
  hubReceived: null,
  solana: null,
};

export type JourneyEvent =
  | { type: "quote_requested" }
  | { type: "quoted"; requestId: string; swapToken: string; routes: PublicRoute[]; quotePayment: string }
  | { type: "quote_replaced"; oldQuoteId: string; fresh: PublicRoute; reason: string }
  | { type: "swap_requested"; quoteId: string }
  | {
      type: "swap_prepared";
      swapId: string;
      swapPayment: string | null;
      transactions: SwapTransaction[];
      deposit?: Deposit;
      solana?: SolanaTransaction;
      leg?: number;
      legCount?: number;
    }
  | { type: "next_leg_requested" }
  | { type: "wallet_send_requested" }
  | { type: "tx_sent"; hash: string }
  | { type: "signed" }
  | {
      type: "status";
      status: string;
      amountReceived?: string | null;
      txHashes?: string[];
      amountSent?: string | null;
      depositShort?: string | null;
      refundReason?: string | null;
      partialRefund?: boolean;
      leg?: number;
      legCount?: number;
      legs?: LegStatus[];
    }
  | { type: "failed"; message: string }
  | { type: "arkiv_keys"; keys: Record<string, string> }
  | { type: "form_changed" }
  | { type: "reset" };

const FINISHED = ["completed", "refunded", "failed", "expired"];

export function reduceJourney(state: JourneyState, event: JourneyEvent): JourneyState {
  switch (event.type) {
    case "quote_requested":
      return { ...initialJourney, step: "quoting" };
    case "quoted":
      return {
        ...state,
        step: "quoted",
        requestId: event.requestId,
        swapToken: event.swapToken,
        routes: event.routes,
        quotePayment: event.quotePayment,
      };
    case "quote_replaced":
      return {
        ...state,
        step: "quoted",
        chosenQuoteId: null,
        routes: state.routes.map((route) => (route.quoteId === event.oldQuoteId ? event.fresh : route)),
        notice:
          event.reason === "price_moved"
            ? "The price moved past your slippage. Here is a new quote; you were not charged."
            : event.reason === "route_changed"
              ? "That provider is no longer available. Here is the best current quote; you were not charged."
              : "That quote expired. Here is a new one; you were not charged.",
      };
    case "swap_requested":
      return { ...state, step: "preparing", chosenQuoteId: event.quoteId, error: null, notice: null };
    case "swap_prepared":
      return {
        ...state,
        step: event.deposit ? "tracking" : "signing",
        swapId: event.swapId,
        swapPayment: event.swapPayment,
        transactions: event.transactions,
        deposit: event.deposit ?? null,
        solana: event.solana ?? null,
        swapStatus: event.deposit ? "awaiting_deposit" : null,
        ...(event.leg ? { leg: event.leg } : {}),
        ...(event.legCount ? { legCount: event.legCount } : {}),
      };
    case "next_leg_requested":
      return { ...state, step: "preparing", error: null, notice: null };
    case "wallet_send_requested":
      return { ...state, step: "signing", error: null };
    case "tx_sent":
      return { ...state, txHashes: [...state.txHashes, event.hash] };
    case "signed":
      return { ...state, step: "tracking", swapStatus: "confirming" };
    case "status":
      return {
        ...state,
        step: FINISHED.includes(event.status) ? "finished" : "tracking",
        // A venue can lag the chain, but progress shouldn't move backwards.
        swapStatus: event.depositShort
          ? "awaiting_deposit"
          : event.status === "awaiting_deposit" && state.swapStatus && state.swapStatus !== "awaiting_deposit"
            ? state.swapStatus
            : event.status === "awaiting_deposit" && state.txHashes.length
              ? "confirming"
              : event.status,
        amountReceived: event.amountReceived ?? state.amountReceived,
        amountSent: event.amountSent ?? state.amountSent,
        depositShort: event.depositShort === undefined ? state.depositShort : event.depositShort,
        refundReason: event.refundReason ?? state.refundReason,
        partialRefund: event.partialRefund ?? state.partialRefund,
        txHashes: event.txHashes?.length ? event.txHashes : state.txHashes,
        leg: event.leg ?? state.leg,
        legCount: event.legCount ?? state.legCount,
        hubReceived: event.status === "awaiting_next_leg" ? (event.legs?.at(-1)?.amountReceived ?? state.hubReceived) : state.hubReceived,
      };
    case "failed":
      return {
        ...state,
        // An order that exists can still be paid by a plain deposit.
        step: state.swapId && state.deposit ? "tracking" : state.routes.length ? "quoted" : "idle",
        error: event.message,
      };
    case "arkiv_keys":
      return {
        ...state,
        routes: state.routes.map((route) => {
          const entityKey = event.keys[route.quoteId];
          return entityKey ? { ...route, arkiv: { entityKey, pending: false } } : route;
        }),
      };
    case "form_changed":
      // Quotes answer the form as it was. An order already placed doesn't depend on it.
      return state.swapId ? state : initialJourney;
    case "reset":
      return initialJourney;
  }
}

export type StationState = "upcoming" | "current" | "done" | "failed";

export interface Station {
  id: "quote" | "publish" | "choose" | "sign" | "confirm" | "deliver";
  name: string;
  detail: string;
  state: StationState;
}

const STATIONS: Omit<Station, "state">[] = [
  { id: "quote", name: "Pay for quotes", detail: "0.01 USDC on Hedera, paid by this demo" },
  { id: "publish", name: "Publish on Arkiv", detail: "Each quote becomes a public record" },
  { id: "choose", name: "Choose a quote", detail: "The best guaranteed amount is marked" },
  { id: "sign", name: "Send your deposit", detail: "From your own wallet. Crossfare never holds your funds" },
  { id: "confirm", name: "Confirm on chain", detail: "Crossfare tracks the swap until it lands" },
  { id: "deliver", name: "Delivered", detail: "Quoted and received amounts are recorded" },
];

/** The index of the station in progress. Everything before it is done. */
function currentStation(state: JourneyState): number {
  switch (state.step) {
    case "idle":
      return -1;
    case "quoting":
      return 0;
    case "quoted":
      return 2;
    case "preparing":
    case "signing":
      return 3;
    case "tracking":
      return 4;
    case "finished":
      return 6;
  }
}

export function journeyStations(state: JourneyState): Station[] {
  const current = currentStation(state);
  const refused = state.step === "finished" && state.swapStatus !== "completed";
  const awaiting = state.step === "tracking" && state.swapStatus === "awaiting_deposit";
  return STATIONS.map((rawStation, index) => {
    const station =
      rawStation.id === "confirm" && state.swapStatus === "exchanging"
        ? { ...rawStation, detail: "SwapKit is exchanging your funds" }
        : rawStation;
    if (awaiting && station.id === "sign") return { ...station, state: "current" };
    if (awaiting && station.id === "confirm") return { ...station, state: "upcoming" };
    if (refused && station.id === "deliver") return { ...station, state: "failed" };
    if (current === -1 || index > current) return { ...station, state: "upcoming" };
    return { ...station, state: index === current ? "current" : "done" };
  });
}

function decimalKey(value: string, width: number): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole + fraction.padEnd(width, "0"));
}

export function bestRoute(routes: PublicRoute[]): PublicRoute | null {
  if (routes.length === 0) return null;
  const width = Math.max(...routes.map((route) => route.minAmountOut.split(".")[1]?.length ?? 0));
  return routes.reduce((best, route) =>
    decimalKey(route.minAmountOut, width) > decimalKey(best.minAmountOut, width) ? route : best,
  );
}

export function formatCountdown(validUntil: string, now: Date): string {
  const seconds = Math.floor((new Date(validUntil).getTime() - now.getTime()) / 1000);
  if (seconds <= 0) return "Expired";
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export const hashscanUrl = (transactionId: string) => `https://hashscan.io/testnet/transaction/${transactionId}`;
export const arkivEntityUrl = (entityKey: string) => `https://rabdi.explorer.arkiv.network/entity/${entityKey}`;

const EXPLORERS: Record<string, Explorer> = {
  eth: { label: "Etherscan", base: "https://etherscan.io/", evm: true },
  base: { label: "Basescan", base: "https://basescan.org/", evm: true },
  arb: { label: "Arbiscan", base: "https://arbiscan.io/", evm: true },
  op: { label: "Optimistic Etherscan", base: "https://optimistic.etherscan.io/", evm: true },
  pol: { label: "PolygonScan", base: "https://polygonscan.com/", evm: true },
  bsc: { label: "BscScan", base: "https://bscscan.com/", evm: true },
  avax: { label: "Snowtrace", base: "https://snowtrace.io/", evm: true },
  gno: { label: "GnosisScan", base: "https://gnosisscan.io/", evm: true },
  btc: { label: "mempool.space", base: "https://mempool.space/" },
  sol: { label: "Solscan", base: "https://solscan.io/", address: "account/" },
  xrp: { label: "XRPScan", base: "https://xrpscan.com/", address: "account/" },
};

type Explorer = { label: string; base: string; address?: string; evm?: true };

/** The hand-picked names first, then whatever viem knows for the other Uniswap chains. */
function explorerFor(chain: string): Explorer | undefined {
  const known = EXPLORERS[chain];
  if (known) return known;
  const wallet = walletChain(chain);
  const explorer = wallet?.blockExplorers?.default;
  if (!wallet || !explorer) return undefined;
  const label = explorer.name === "Explorer" ? `${wallet.name} explorer` : explorer.name;
  return { label, base: `${explorer.url.replace(/\/$/, "")}/`, evm: true };
}

export function explorerTxUrl(chain: string, hash: string): string {
  return `${(explorerFor(chain) ?? EXPLORERS.base!).base}tx/${hash}`;
}

export function explorerAddressUrl(chain: string, address: string): string | null {
  const explorer = explorerFor(chain);
  return explorer ? `${explorer.base}${explorer.address ?? "address/"}${address}` : null;
}

export const explorerName = (chain: string) => explorerFor(chain)?.label ?? null;

/** The first hash is the sender's and the last lands on the destination. Any between may be on another chain. */
export function explorerLinks(hashes: string[], fromAsset: string, toAsset: string) {
  const ends = hashes.length > 2 ? [hashes[0]!, hashes.at(-1)!] : hashes;
  return ends.flatMap((hash, index) => {
    const chain = (index === 0 ? fromAsset : toAsset).split(":")[0] ?? "";
    const explorer = explorerFor(chain);
    // No link beats a wrong one. The provider's own chain can also fill the last place until delivery.
    if (!explorer || (explorer.evm && !hash.startsWith("0x"))) return [];
    return [
      {
        hash,
        kind: index === 0 ? ("deposit" as const) : ("delivery" as const),
        label: explorer.label,
        url: explorerTxUrl(chain, hash),
      },
    ];
  });
}

const DIRECT_VENUES: Record<string, string> = {
  uniswap: "Uniswap",
  "near-intents": "NEAR Intents",
  thorchain: "THORChain",
  pancakeswap: "PancakeSwap",
  jupiter: "Jupiter",
};

/** Who fills a route: a venue Crossfare calls directly, or SwapKit and the provider behind it. */
export function venueLabel(venue: string | undefined, provider?: string): { full: string; short: string } {
  const direct = venue ? DIRECT_VENUES[venue] : undefined;
  if (direct) return { full: direct, short: direct };
  const via = provider?.replaceAll("_", " ").toUpperCase();
  return via ? { full: `SwapKit via ${via}`, short: via } : { full: "SwapKit", short: "SwapKit" };
}

/** Who fills each leg, in order. */
export function routeLabel(route: PublicRoute): string {
  if (!route.legs) return venueLabel(route.venue, route.provider).full;
  return route.legs.map((leg) => venueLabel(leg.venue, leg.provider).short).join(", then ");
}

export type RouteAction = "deposit" | "wallet" | "connect" | "unsupported" | "solana" | "connect-solana" | "other-wallet";

/** The wallets this page holds, and the form's addresses. */
export interface RouteWallets {
  evm?: string;
  solana?: string;
  sender?: string;
  recipient?: string;
}

const sameWallet = (a: string | undefined, b: string | undefined) => !!a && !!b && (a.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The page's wallet signs on every chain Uniswap trades on. */
export const canSignOn = (asset: string) => walletChain(asset.split(":")[0] ?? "") !== undefined;

/** A plain transfer works from any wallet software. Anything else needs a signature on a chain this page can use. */
export function routeAction(route: PublicRoute, connected: boolean, sourceChain = "base", wallets: RouteWallets = {}): RouteAction {
  // Jupiter's transaction is signed by a Solana wallet.
  if (route.venue === "jupiter" || route.legs?.[0]?.venue === "jupiter") return wallets.solana ? "solana" : "connect-solana";
  if (route.depositable) return "deposit";
  if (!walletChain(sourceChain)) return "unsupported";
  if (!connected) return "connect";
  const hub = route.legs?.[0]?.to;
  if (hub) {
    // The hub stays with the sender on the source chain, else it lands at the receiving address.
    const holder = hub.split(":")[0] === sourceChain ? wallets.sender : wallets.recipient;
    const signer = hub.startsWith("sol:") ? wallets.solana : wallets.evm;
    if (wallets.evm !== undefined && !sameWallet(signer, holder?.trim())) return "other-wallet";
  }
  return "wallet";
}

/** The chain ID when an asset is a chain's gas coin, which a second leg's gas is paid in too. */
export function nativeHubChain(asset: string): number | null {
  const [code, symbol] = asset.split(":");
  const chain = walletChain(code ?? "");
  return chain && chain.nativeCurrency.symbol.toLowerCase() === symbol ? chain.id : null;
}

/** How much of what arrived a second leg can spend, gas first coming out of what the wallet already held. */
export function spendableAfterGas(received: bigint, balance: bigint, gasCost: bigint): bigint | null {
  const spare = balance - received;
  if (spare >= gasCost) return received;
  const amount = received - (gasCost - (spare > 0n ? spare : 0n));
  return amount > 0n ? amount : null;
}

export function defaultSlippage(from: string, to: string): string {
  return from.split(":")[0] === to.split(":")[0] ? "0.5" : "3";
}

export function walletMatches(connected: string | undefined, sender: string): boolean {
  return !!connected && connected.toLowerCase() === sender.trim().toLowerCase();
}

export interface SwapForm {
  from: string;
  to: string;
  amount: string;
  recipient: string;
  refundAddress: string;
  slippage: string;
}

/** Without the sending wallet connected, the deposit can come from anywhere, including an exchange. */
export function buildQuoteRequest(form: SwapForm, connected: string | undefined) {
  const refundAddress = form.refundAddress.trim();
  return {
    from: { asset: form.from, amount: form.amount, address: refundAddress },
    to: { asset: form.to, address: form.recipient.trim() },
    mode: "exact_in",
    slippageBps: Math.round(Number(form.slippage) * 100),
    refundAddress,
    ...(walletMatches(connected, refundAddress) ? {} : { flexibleDeposit: true }),
    // A route in two legs needs a wallet here to sign the second.
    ...(connected ? { multiLeg: true } : {}),
  };
}

/** Keeps enough digits to read a price, without eighteen decimals. */
export function formatAmount(amount: string | number): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return String(amount);
  return value.toLocaleString("en-US", { maximumSignificantDigits: 5 });
}

export function formatRate(amountIn: string, amountOut: string, fromSymbol: string, toSymbol: string): string | null {
  const sold = Number(amountIn);
  if (!(sold > 0)) return null;
  return `1 ${fromSymbol} = ${formatAmount(Number(amountOut) / sold)} ${toSymbol}`;
}

export function formatUsd(value: number | undefined): string | null {
  if (value === undefined) return null;
  if (value < 0.01) return "<$0.01";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** What one unit of the bought asset costs at this quote. */
export function unitPrice(amountOut: string, usdOut: number | undefined): string | null {
  const bought = Number(amountOut);
  if (usdOut === undefined || !(bought > 0)) return null;
  return formatUsd(usdOut / bought);
}

export function swapCost(usd: { in: number; out: number } | undefined): string | null {
  if (!usd || !(usd.in > 0) || usd.out >= usd.in) return null;
  return `${formatUsd(usd.in - usd.out)} (${(((usd.in - usd.out) / usd.in) * 100).toFixed(2)}%)`;
}

function decimalPair(left: string, right: string): [bigint, bigint, number] {
  const width = Math.max(left.split(".")[1]?.length ?? 0, right.split(".")[1]?.length ?? 0);
  return [decimalKey(left, width), decimalKey(right, width), width];
}

export function sentComparedToQuote(sent: string | null, quoted: string): "less" | "more" | null {
  if (!sent) return null;
  const [got, wanted] = decimalPair(sent, quoted);
  return got === wanted ? null : got < wanted ? "less" : "more";
}

/** Exact, because a person will send precisely what this says. */
export function topUpNeeded(seen: string, minimum: string): string | null {
  const [got, needed, width] = decimalPair(seen, minimum);
  if (got >= needed) return null;
  const digits = (needed - got).toString().padStart(width + 1, "0");
  const fraction = digits.slice(digits.length - width).replace(/0+$/, "");
  return fraction ? `${digits.slice(0, digits.length - width)}.${fraction}` : digits.slice(0, digits.length - width);
}

export function formatEta(seconds: number): string | null {
  if (!(seconds > 0)) return null;
  if (seconds < 5) return "A few seconds";
  if (seconds < 90) return `About ${Math.round(seconds)} seconds`;
  return `About ${Math.round(seconds / 60)} minutes`;
}

export function isPriceable(amount: string): boolean {
  return /^[0-9]*\.?[0-9]+$/.test(amount) && Number(amount) > 0;
}

export function bestAdvantage(routes: PublicRoute[]): string | null {
  const best = bestRoute(routes);
  const others = routes.filter((route) => route !== best && route.usd);
  if (!best?.usd || others.length === 0) return null;
  const next = Math.max(...others.map((route) => route.usd!.out));
  return best.usd.out > next ? formatUsd(best.usd.out - next) : null;
}

export function receivedAboveMinimum(received: string | null, minimum: string): string | null {
  const got = Number(received);
  const floor = Number(minimum);
  if (!(got > floor) || !(floor > 0)) return null;
  return `${(((got - floor) / floor) * 100).toFixed(2)}%`;
}

const STATUS_LABELS: Record<string, string> = {
  awaiting_deposit: "Awaiting deposit",
  exchanging: "Swapping",
  awaiting_next_leg: "First leg done",
  executing: "In progress",
};

/** Records written before the labels hold lower-case codes, so both forms read the same. */
export function statusLabel(status: string): string {
  const label = STATUS_LABELS[status] ?? status;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export interface OrderStage {
  id: "sent" | "swap" | "delivered";
  name: string;
  state: StationState;
}

export function orderStages(state: JourneyState): OrderStage[] {
  const status = state.swapStatus ?? "";
  const awaiting = status === "awaiting_deposit" || status === "expired" || !status;
  const sent = awaiting ? "Send deposit" : state.deposit ? "Deposit received" : "Transaction sent";
  const refused = status === "refunded" || status === "failed";
  const finished = status === "completed";
  return [
    { id: "sent", name: sent, state: awaiting ? "current" : "done" },
    { id: "swap", name: "Swapping", state: refused ? "failed" : finished ? "done" : awaiting ? "upcoming" : "current" },
    { id: "delivered", name: "Delivered", state: finished ? "done" : "upcoming" },
  ];
}

export interface WalletConnector {
  id: string;
  name: string;
  type: string;
  icon?: string | undefined;
}

/** Browsers announce each installed wallet. The generic entry only helps when none did. */
export function walletOptions<T extends WalletConnector>(connectors: readonly T[]): T[] {
  const discovered = connectors.filter((connector) => connector.id !== "injected");
  if (discovered.length) return discovered;
  return connectors.map((connector) => ({ ...connector, name: "Browser wallet" }));
}

export function formatDeadline(deadline: string, now: Date): string {
  const seconds = Math.floor((new Date(deadline).getTime() - now.getTime()) / 1000);
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return formatCountdown(deadline, now);
}

export function shorten(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

const ERROR_MESSAGES: Record<string, string> = {
  no_route: "No route supports this pair and amount. Try a larger amount or another pair.",
  venues_unavailable: "The swap venues did not answer. Try again in a moment.",
  "invalid sending address": "The refund address doesn't fit the chain you're sending from. Check it and try again.",
  "invalid receiving address": "The receiving address doesn't fit the chain you're swapping to. Check it and try again.",
  insufficient_balance: "That wallet address doesn't hold this amount. Add funds or enter the wallet you'll send from.",
  price_busy: "Prices are busy. Try again in a few seconds.",
  sample_address: "The swap provider treats one of those addresses as a sample. Enter a real wallet address you control.",
  wallet_required: "That route needs a wallet signature on a chain this page can't use. Choose another route.",
  invalid_recipient: "The swap provider refused that receiving address, because funds sent there would be lost.",
  invalid_swap_token: "This quote can't be used from here. Get new quotes and try again.",
  too_many_requotes: "This quote has been refreshed too many times. Get new quotes and try again.",
  route_unavailable: "That route is no longer available. Get new quotes and try again.",
  upstream_failed: "A swap venue failed, so you were not charged. Try again in a moment.",
  demo_limit_reached: "This demo has reached its usage limit. Try again later.",
  demo_payment_failed: "The demo could not pay the Crossfare fee. Try again in a moment.",
  address_flagged: "A screening check flagged the sender or recipient address, so this swap can't go ahead.",
  settlement_failed: "The Crossfare fee did not settle, so nothing was charged. Try again.",
};

export function errorMessage(body: unknown, status: number): string {
  const code = (body as { error?: unknown } | null)?.error;
  if (typeof code === "string") return ERROR_MESSAGES[code] ?? `The request failed: ${code}.`;
  return `The request failed with status ${status}.`;
}

/** A token on no list is quoted on Uniswap only, so it can't cross chains. Blaming the amount would mislead. */
export function noRouteMessage(from: string, to: string, unverified: (id: string) => boolean): string {
  const chainOf = (id: string) => id.split(":")[0] ?? "";
  if (chainOf(from) !== chainOf(to)) {
    const name = (id: string) => walletChain(chainOf(id))?.name ?? chainOf(id).toUpperCase();
    if (unverified(to)) return `A token on no list only swaps on its own chain. Send something on ${name(to)}.`;
    if (unverified(from)) return `A token on no list only swaps on its own chain. Receive something on ${name(from)}.`;
  }
  return "No route for this amount. Try a larger one.";
}
