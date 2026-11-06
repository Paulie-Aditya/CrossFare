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
  arkiv: { entityKey: string | null; pending: boolean };
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
  error: string | null;
  notice: string | null;
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
  error: null,
  notice: null,
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
    }
  | { type: "wallet_send_requested" }
  | { type: "tx_sent"; hash: string }
  | { type: "signed" }
  | { type: "status"; status: string; amountReceived?: string | null; txHashes?: string[] }
  | { type: "failed"; message: string }
  | { type: "arkiv_keys"; keys: Record<string, string> }
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
        swapStatus: event.deposit ? "awaiting_deposit" : null,
      };
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
        // SwapKit can lag a broadcast, but the line shouldn't move backwards.
        swapStatus: event.status === "awaiting_deposit" && state.txHashes.length ? "confirming" : event.status,
        amountReceived: event.amountReceived ?? state.amountReceived,
        txHashes: event.txHashes?.length ? event.txHashes : state.txHashes,
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

const EXPLORERS: Record<string, { label: string; base: string }> = {
  eth: { label: "Etherscan", base: "https://etherscan.io/tx/" },
  base: { label: "Basescan", base: "https://basescan.org/tx/" },
  btc: { label: "mempool.space", base: "https://mempool.space/tx/" },
  sol: { label: "Solscan", base: "https://solscan.io/tx/" },
  xrp: { label: "XRPScan", base: "https://xrpscan.com/tx/" },
};

export function explorerTxUrl(chain: string, hash: string): string {
  return `${EXPLORERS[chain]?.base ?? EXPLORERS.base!.base}${hash}`;
}

/** The first hash is the sender's and the last lands on the destination. Any between may be on another chain. */
export function explorerLinks(hashes: string[], fromAsset: string, toAsset: string) {
  const ends = hashes.length > 2 ? [hashes[0]!, hashes.at(-1)!] : hashes;
  return ends.map((hash, index) => {
    const chain = (index === 0 ? fromAsset : toAsset).split(":")[0] ?? "";
    return { hash, label: EXPLORERS[chain]?.label ?? "explorer", url: explorerTxUrl(chain, hash) };
  });
}

export type RouteAction = "deposit" | "wallet" | "connect";

/** A plain transfer works from any wallet software; anything else needs a signature here. */
export function routeAction(route: PublicRoute, connected: boolean): RouteAction {
  if (route.depositable) return "deposit";
  return connected ? "wallet" : "connect";
}

export function defaultSlippage(from: string, to: string): string {
  return from.split(":")[0] === to.split(":")[0] ? "0.5" : "3";
}

export function walletMatches(connected: string | undefined, sender: string): boolean {
  return !!connected && connected.toLowerCase() === sender.trim().toLowerCase();
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
  "invalid sending address": "Your wallet address doesn't fit the chain you're sending from. Check it and try again.",
  "invalid receiving address": "The receiving address doesn't fit the chain you're swapping to. Check it and try again.",
  insufficient_balance: "That wallet address doesn't hold this amount. Add funds or enter the wallet you'll send from.",
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
