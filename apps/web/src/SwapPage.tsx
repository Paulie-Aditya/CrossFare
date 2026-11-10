import { useEffect, useReducer, useRef, useState } from "react";
import { useAccount, useConfig, useSendTransaction, useSwitchChain } from "wagmi";
import { getBalance, getGasPrice, waitForTransactionReceipt } from "wagmi/actions";
import { formatUnits, parseUnits } from "viem";
import { QRCodeSVG } from "qrcode.react";
import { get, post } from "./api.ts";
import { chainLabel, chainNameOf, contractOf, isEvmAsset, isUnverified, symbolOf, type AssetOption, type CatalogStatus, type ChainOption } from "./asset-book.ts";
import { Delivered } from "./Delivered.tsx";
import {
  arkivEntityUrl,
  bestAdvantage,
  bestRoute,
  buildQuoteRequest,
  canSignOn,
  defaultSlippage,
  explorerAddressUrl,
  explorerLinks,
  explorerName,
  formatAmount,
  formatCountdown,
  formatDeadline,
  formatEta,
  formatRate,
  formatUsd,
  hashscanUrl,
  initialJourney,
  journeyStations,
  orderStages,
  reduceJourney,
  routeAction,
  routeLabel,
  nativeHubChain,
  spendableAfterGas,
  noRouteMessage,
  sentComparedToQuote,
  shorten,
  statusLabel,
  swapCost,
  topUpNeeded,
  unitPrice,
  venueLabel,
  walletMatches,
  type Deposit,
  type OrderStage,
  type PublicRoute,
  type RouteWallets,
  type SolanaTransaction,
  type SwapTransaction,
} from "./journey.ts";
import { SolanaWalletChooser, useSolanaWallet } from "./SolanaWallet.tsx";
import { walletChain } from "./wallet-chains.ts";
import { useLivePrice } from "./live-price.ts";
import { InFlight, Stepper } from "./OrderTracker.tsx";
import { TokenButton } from "./TokenPicker.tsx";
import { CopyButton } from "./ui.tsx";
import type { WalletChainId } from "./wagmi.ts";

const STATUS_POLL_MS = 4_000;
const ARKIV_POLL_MS = 5_000;
const BASE_TITLE = "Crossfare";

const looksEvm = (address: string) => /^0x/i.test(address.trim());
const providerName = (route: PublicRoute) => routeLabel(route);
const providerShort = (route: PublicRoute | undefined) => (route?.legs ? routeLabel(route) : venueLabel(route?.venue, route?.provider).short);
/** Gas for a second leg: a swap, approvals included, at twice the current price. */
const SECOND_LEG_GAS = 600_000n;

function useNow(active: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function PriceRows(props: { amount: string; amountOut: string; usd: { in: number; out: number } | undefined; from: string; to: string; etaSeconds: number }) {
  const { amount, amountOut, usd, from, to, etaSeconds } = props;
  const rate = formatRate(amount, amountOut, symbolOf(from), symbolOf(to));
  const price = unitPrice(amountOut, usd?.out);
  const cost = swapCost(usd);
  const eta = formatEta(etaSeconds);
  return (
    <>
      {rate && (
        <div>
          <dt>Rate</dt>
          <dd>{rate}</dd>
        </div>
      )}
      {price && (
        <div>
          <dt>{symbolOf(to)} price</dt>
          <dd>{price}</dd>
        </div>
      )}
      {cost && (
        <div>
          <dt>Swap cost</dt>
          <dd>{cost}</dd>
        </div>
      )}
      {eta && (
        <div>
          <dt>Time</dt>
          <dd>{eta}</dd>
        </div>
      )}
    </>
  );
}

function RouteRow(props: {
  route: PublicRoute;
  from: string;
  to: string;
  amount: string;
  isBest: boolean;
  advantage: string | null;
  now: Date;
  disabled: boolean;
  chosen: boolean;
  connected: boolean;
  wallets: RouteWallets;
  onSwap: () => void;
  onConnect: () => void;
  onConnectSolana: () => void;
}) {
  const { route, from, to, amount, isBest, advantage, now, disabled, chosen, connected, wallets, onSwap, onConnect, onConnectSolana } = props;
  const countdown = formatCountdown(route.validUntil, now);
  const expired = countdown === "Expired";
  const sourceChain = from.split(":")[0] ?? "";
  const action = routeAction(route, connected, sourceChain, wallets);
  const hub = route.legs?.[0];
  const actionLabel = chosen
    ? "Preparing"
    : expired
      ? "Get a new price"
      : action === "deposit"
        ? "Get deposit address"
        : action === "wallet"
          ? "Swap with wallet"
          : action === "connect"
            ? "Connect a wallet for this route"
            : action === "solana"
              ? "Swap with Solana wallet"
              : action === "connect-solana"
                ? "Connect a Solana wallet"
                : action === "other-wallet"
                  ? "Second leg needs your receiving wallet"
                  : `Needs a ${chainLabel(sourceChain)} wallet`;
  const usdOut = formatUsd(route.usd?.out);
  const usdIn = formatUsd(route.usd?.in);
  const rate = formatRate(amount, route.amountOut, symbolOf(from), symbolOf(to));
  const price = unitPrice(route.amountOut, route.usd?.out);
  const cost = swapCost(route.usd);
  const eta = formatEta(route.etaSeconds);
  return (
    <article className={isBest ? "route route-best glass" : "route glass"} data-chosen={chosen || undefined}>
      <div className="route-head">
        <p className="route-venue">{providerName(route)}</p>
        {hub && (
          <p className="route-badge route-legs">
            2 steps, through {formatAmount(hub.amountOut)} {symbolOf(hub.to)}
          </p>
        )}
        {isBest && <p className="route-badge">{advantage ? `Best price, ${advantage} more` : "Best price"}</p>}
        <p className={expired ? "route-clock is-expired" : "route-clock"} aria-label={`Quote valid for ${countdown}`}>
          {countdown}
        </p>
      </div>
      <p className="route-amount">
        {formatAmount(route.amountOut)} <span>{symbolOf(to)}</span>
        {usdOut && <small>{usdOut}</small>}
      </p>
      {rate && (
        <p className="route-rate">
          {rate}
          {price && ` (${symbolOf(to)} at ${price})`}
        </p>
      )}
      <dl className="route-facts">
        <div>
          <dt>You pay</dt>
          <dd>
            {amount} {symbolOf(from)}
            {usdIn && ` (${usdIn})`}
          </dd>
        </div>
        <div>
          <dt>You get at least</dt>
          <dd>
            {formatAmount(route.minAmountOut)} {symbolOf(to)}
          </dd>
        </div>
        {cost && (
          <div>
            <dt>Swap cost</dt>
            <dd>{cost}</dd>
          </div>
        )}
        {eta && (
          <div>
            <dt>Time</dt>
            <dd>{eta}</dd>
          </div>
        )}
      </dl>
      <div className="route-foot">
        {route.arkiv.entityKey ? (
          <a href={arkivEntityUrl(route.arkiv.entityKey)} target="_blank" rel="noreferrer">
            Public record on Arkiv
          </a>
        ) : (
          <span className="route-pending">Publishing to Arkiv</span>
        )}
        <button
          className="route-action"
          disabled={disabled || action === "unsupported" || action === "other-wallet"}
          onClick={action === "connect" ? onConnect : action === "connect-solana" ? onConnectSolana : onSwap}
        >
          {chosen && <span className="spinner" aria-hidden="true" />}
          {actionLabel}
        </button>
      </div>
    </article>
  );
}

function OrderPanel(props: {
  stages: OrderStage[];
  deposit: Deposit;
  route: PublicRoute | undefined;
  toAsset: string;
  refundAddress: string;
  recipient: string;
  now: Date;
  depositShort: string | null;
  connected: string | undefined;
  sending: boolean;
  canSendWithWallet: boolean;
  onSendWithWallet: () => void;
  onStartOver: () => void;
}) {
  const { deposit, route, toAsset, refundAddress, recipient, now, connected, sending, canSendWithWallet, depositShort } = props;
  const sold = symbolOf(deposit.asset);
  const flexible = deposit.minAmount && deposit.minAmount !== deposit.amount;
  const refundDate = deposit.refundBy
    ? new Date(deposit.refundBy).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true })
    : null;
  const more = depositShort && deposit.minAmount ? topUpNeeded(depositShort, deposit.minAmount) : null;
  const matches = walletMatches(connected, refundAddress);
  const usd = formatUsd(route?.usd?.out);
  return (
    <section className="order glass" aria-label="Deposit instructions">
      <Stepper stages={props.stages} />
      <div className="order-head">
        <h2>{depositShort ? "Your deposit is too small" : "Send your deposit"}</h2>
        {deposit.expiresAt && !depositShort && (
          <p className="order-clock">
            <span>Time left</span> {formatDeadline(deposit.expiresAt, now)}
          </p>
        )}
      </div>
      <div className="order-body">
        <div className="order-qr">
          <QRCodeSVG value={deposit.address} size={112} marginSize={1} title="Deposit address as a QR code" />
        </div>
        <div className="order-send-to">
          <p className="order-lead">
            {depositShort && more ? "Send at least " : "Send exactly "}
            <strong>
              {depositShort && more ? more : deposit.amount} {symbolOf(deposit.asset)}
            </strong>
            {depositShort && more ? " more" : ""} on {chainNameOf(deposit.asset)} to:
          </p>
          <div className="order-address">
            <span>{deposit.address}</span>
            <CopyButton value={deposit.address} />
          </div>
          {deposit.memo && (
            <p className="order-memo">
              Include this memo: <span>{deposit.memo}</span>
            </p>
          )}
        </div>
      </div>
      {depositShort ? (
        <div className="order-short" role="alert">
          <p>
            <strong>
              {depositShort} {sold} arrived, below the {deposit.minAmount} {sold} minimum, so it hasn't been swapped.
            </strong>
          </p>
          <p>
            {more && `Send at least ${more} ${sold} more to the same address and the swap goes ahead. `}
            Otherwise the provider returns it to {shorten(refundAddress)} after its deadline
            {refundDate ? `, ${refundDate}` : ""}. Keep this page open to follow it.
          </p>
        </div>
      ) : (
        <div className="order-watch" role="status">
          <span className="radar" aria-hidden="true" />
          <p>Watching {chainNameOf(deposit.asset)} for your deposit. This page moves on by itself once it lands.</p>
        </div>
      )}
      {route && (
        <dl className="order-facts">
          <div>
            <dt>You receive about</dt>
            <dd className="order-receive">
              {formatAmount(route.amountOut)} {symbolOf(toAsset)}
              {usd && <small>{usd}</small>}
            </dd>
          </div>
          <div>
            <dt>You get at least</dt>
            <dd>
              {formatAmount(route.minAmountOut)} {symbolOf(toAsset)}
            </dd>
          </div>
        </dl>
      )}
      <div className="order-recipient-row">
        <p>Arrives at, on {chainNameOf(toAsset)}</p>
        <p className="order-recipient">{recipient}</p>
      </div>
      <p className="order-note">
        Send from any wallet or exchange, on {chainNameOf(deposit.asset)} only.{" "}
        {flexible
          ? `If you send more, all of it swaps. Less than ${deposit.minAmount} ${sold} isn't swapped, and returns to ${shorten(refundAddress)} after the provider's deadline, which can take days.`
          : deposit.minAmount
            ? `Send the full amount. Less isn't swapped and any extra isn't either: both return to ${shorten(refundAddress)}, which can take days.`
            : `If an exchange takes a withdrawal fee, add it so the full amount arrives, because you receive less if less arrives. If the swap can't go ahead, your funds return to ${shorten(refundAddress)}.`}
      </p>
      <div className="order-actions">
        {canSendWithWallet && matches && (
          <button className="primary order-send" disabled={sending} onClick={props.onSendWithWallet}>
            {sending && <span className="spinner" aria-hidden="true" />}
            {sending ? "Confirm in your wallet" : "Send with wallet"}
          </button>
        )}
        {canSendWithWallet && connected && !matches && (
          <p className="order-note">
            Your connected wallet isn't the refund address, so send this deposit from your wallet app or exchange.
          </p>
        )}
        {!depositShort && (
          <button className="ghost order-restart" onClick={props.onStartOver}>
            Start over
          </button>
        )}
      </div>
    </section>
  );
}

function depositAddressLink(chain: string, address: string) {
  const url = explorerAddressUrl(chain, address);
  const label = explorerName(chain);
  return url && label ? { label, url } : null;
}

export function SwapPage(props: { onConnectWallet: () => void; assets: AssetOption[]; chains: ChainOption[]; catalogStatus: CatalogStatus }) {
  const { onConnectWallet, assets, chains, catalogStatus } = props;
  const { address, chainId, isConnected } = useAccount();
  const config = useConfig();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();

  const [state, dispatch] = useReducer(reduceJourney, initialJourney);
  const solana = useSolanaWallet();
  const [solanaChooserOpen, setSolanaChooserOpen] = useState(false);
  /** A second leg priced below the guarantee, which the person may still accept. */
  const [nextLegOffer, setNextLegOffer] = useState<{ amountOut: string; minAmountOut: string } | null>(null);
  const [from, setFrom] = useState("eth:usdc");
  const [to, setTo] = useState("base:eth");
  const [amount, setAmount] = useState("5");
  const [recipient, setRecipient] = useState("");
  const [refundAddress, setRefundAddress] = useState("");
  const [slippageChoice, setSlippageChoice] = useState<string | null>(null);

  const slippage = slippageChoice ?? defaultSlippage(from, to);
  const now = useNow(state.step !== "idle" && state.step !== "finished");
  const best = bestRoute(state.routes);
  const busy = state.step === "quoting" || state.step === "preparing" || state.step === "signing";
  const hasPending = state.routes.some((route) => route.arkiv.pending);
  const hasOrder = state.swapId !== null;
  const price = useLivePrice(from, to, amount, !hasOrder && state.routes.length === 0 && state.step !== "quoting");
  const live = price.status === "ready" ? price.price : null;
  const pricing = price.status === "loading";

  // Quotes answer the form as it was, so changing it withdraws them.
  useEffect(() => {
    dispatch({ type: "form_changed" });
  }, [from, to, amount, recipient, refundAddress, slippage]);

  const moving = state.swapStatus === "confirming" || state.swapStatus === "exchanging";
  const startedAt = useRef<number | null>(null);
  const [elapsedFinal, setElapsedFinal] = useState<number | null>(null);
  useEffect(() => {
    if (moving && startedAt.current === null) startedAt.current = Date.now();
    if (state.swapStatus === "completed" && startedAt.current !== null) {
      setElapsedFinal(Math.round((Date.now() - startedAt.current) / 1000));
    }
    if (state.swapStatus === null) {
      startedAt.current = null;
      setElapsedFinal(null);
    }
  }, [moving, state.swapStatus]);

  // Each new screen starts at its top, and quotes arriving below the form come into view.
  const routesRef = useRef<HTMLElement>(null);
  const screen = state.swapStatus === "completed" ? "done" : moving ? "moving" : hasOrder ? "order" : "form";
  useEffect(() => {
    if (screen !== "form") window.scrollTo(0, 0);
  }, [screen]);
  const quotesReady = state.step === "quoted" && state.routes.length > 0;
  useEffect(() => {
    if (!quotesReady) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    routesRef.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  }, [quotesReady]);

  // The tab says where the swap is, for someone who has switched away.
  useEffect(() => {
    const titles: Record<string, string> = {
      awaiting_deposit: `Waiting for deposit, ${BASE_TITLE}`,
      confirming: `Deposit received, ${BASE_TITLE}`,
      exchanging: `Swapping, ${BASE_TITLE}`,
      completed: `Swap complete, ${BASE_TITLE}`,
      refunded: `Refunded, ${BASE_TITLE}`,
      failed: `Failed, ${BASE_TITLE}`,
    };
    document.title = titles[state.swapStatus ?? ""] ?? BASE_TITLE;
  }, [state.swapStatus]);

  // A connected wallet fills in the refund address, which the person can still change.
  useEffect(() => {
    if (address && isEvmAsset(from)) setRefundAddress(address);
  }, [address, from, assets]);
  useEffect(() => {
    if (solana.account && from.startsWith("sol:")) setRefundAddress(solana.account.address);
  }, [solana.account, from]);

  // An address for one kind of chain is useless on another, so it isn't carried across.
  useEffect(() => {
    if (assets.length === 0) return;
    setRefundAddress((value) => (value && looksEvm(value) !== isEvmAsset(from) ? "" : value));
  }, [from, assets]);
  useEffect(() => {
    if (assets.length === 0) return;
    setRecipient((value) => (value && looksEvm(value) !== isEvmAsset(to) ? "" : value));
  }, [to, assets]);

  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(async () => {
      const answer = await get("/v1/quotes");
      if (!answer.ok) return;
      const keys: Record<string, string> = {};
      for (const quote of answer.body.quotes) keys[quote.quoteId] = quote.entityKey;
      dispatch({ type: "arkiv_keys", keys });
    }, ARKIV_POLL_MS);
    return () => clearInterval(timer);
  }, [hasPending]);

  useEffect(() => {
    if (state.step !== "tracking" || !state.swapId) return;
    const swapId = state.swapId;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    // Waits for each answer, because a slow provider must not stack up requests.
    const poll = async () => {
      const answer = await get(`/v1/swaps/${swapId}`).catch(() => null);
      if (stopped) return;
      if (answer?.ok) {
        dispatch({
          type: "status",
          status: answer.body.status,
          amountReceived: answer.body.amountReceived,
          txHashes: answer.body.txHashes,
          amountSent: answer.body.amountSent,
          depositShort: answer.body.depositShort,
          refundReason: answer.body.refundReason,
          partialRefund: answer.body.partialRefund,
          leg: answer.body.leg,
          legCount: answer.body.legCount,
          legs: answer.body.legs,
        });
      }
      timer = setTimeout(poll, STATUS_POLL_MS);
    };
    timer = setTimeout(poll, STATUS_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [state.step, state.swapId]);

  async function getQuotes(event: React.FormEvent) {
    event.preventDefault();
    dispatch({ type: "quote_requested" });
    const answer = await post(
      "/demo/quote",
      buildQuoteRequest({ from, to, amount, recipient, refundAddress, slippage }, address),
    ).catch(() => null);
    if (!answer) return dispatch({ type: "failed", message: "Crossfare did not answer. Check your connection and try again." });
    if (!answer.ok) return dispatch({ type: "failed", message: answer.message });
    dispatch({
      type: "quoted",
      requestId: answer.body.requestId,
      swapToken: answer.body.swapToken,
      routes: answer.body.routes,
      quotePayment: answer.body.payment.transactionId,
    });
  }

  async function signAll(swapId: string, transactions: SwapTransaction[]) {
    for (const transaction of transactions) {
      const target = transaction.chainId as WalletChainId;
      if (chainId !== target) await switchChainAsync({ chainId: target });
      const hash = await sendTransactionAsync({
        chainId: target,
        to: transaction.to as `0x${string}`,
        data: transaction.data as `0x${string}`,
        value: BigInt(transaction.value),
      });
      dispatch({ type: "tx_sent", hash });
      // A swap depends on the approval before it, so each must land before the next.
      await waitForTransactionReceipt(config, { hash, chainId: target });
      if (transaction.kind === "swap") await post(`/v1/swaps/${swapId}/tx`, { hash });
    }
    dispatch({ type: "signed" });
  }

  async function swap(route: PublicRoute) {
    dispatch({ type: "swap_requested", quoteId: route.quoteId });
    const answer = await post("/demo/swap", { quoteId: route.quoteId, swapToken: state.swapToken }).catch(() => null);
    if (!answer) return dispatch({ type: "failed", message: "Crossfare did not answer. Check your connection and try again." });
    if (answer.status === 409) {
      return dispatch({
        type: "quote_replaced",
        oldQuoteId: route.quoteId,
        fresh: answer.body.freshQuote,
        reason: answer.body.error,
      });
    }
    if (!answer.ok) return dispatch({ type: "failed", message: answer.message });

    const { swapId, transactions, deposit, payment, solana: solanaTx, leg, legCount } = answer.body;
    dispatch({ type: "swap_prepared", swapId, swapPayment: payment?.transactionId ?? null, transactions, deposit, solana: solanaTx, leg, legCount });
    if (solanaTx) await signWithSolana(swapId, solanaTx);
    else if (!deposit) await signWithWallet(swapId, transactions);
  }

  async function signWithSolana(swapId: string, transaction: SolanaTransaction) {
    try {
      const signature = await solana.signAndSend(transaction.transaction);
      dispatch({ type: "tx_sent", hash: signature });
      await post(`/v1/swaps/${swapId}/tx`, { hash: signature });
      dispatch({ type: "signed" });
    } catch (error) {
      const rejected = /reject|denied/i.test((error as Error).message);
      dispatch({
        type: "failed",
        message: rejected
          ? "You rejected the transaction in your Solana wallet, and nothing was sent."
          : "The Solana transaction did not go through. It lapses about a minute after the quote, so get a new price and try again.",
      });
    }
  }

  /** How much of the hub to spend: all of it, unless it is the gas coin and the wallet needs some for gas. */
  async function spendableHub(hub: string, received: string, holder: string): Promise<string | null> {
    const chainId = nativeHubChain(hub);
    const chain = chainId ? walletChain(hub.split(":")[0] ?? "") : undefined;
    if (!chainId || !chain) return received;
    const target = chainId as WalletChainId;
    const [balance, gasPrice] = await Promise.all([
      getBalance(config, { address: holder as `0x${string}`, chainId: target }),
      getGasPrice(config, { chainId: target }),
    ]);
    const decimals = chain.nativeCurrency.decimals;
    const amount = spendableAfterGas(parseUnits(received, decimals), balance.value, gasPrice * SECOND_LEG_GAS * 2n);
    return amount === null ? null : formatUnits(amount, decimals);
  }

  /** Once the first leg has delivered, prepares and signs the second (FR-14). */
  async function continueSecondLeg(minAmountOut?: string) {
    const route = state.routes.find((entry) => entry.quoteId === state.chosenQuoteId);
    const hub = route?.legs?.[0]?.to;
    if (!state.swapId || !hub || !state.hubReceived) return;
    const swapId = state.swapId;
    setNextLegOffer(null);
    dispatch({ type: "next_leg_requested" });
    const holder = hub.split(":")[0] === from.split(":")[0] ? refundAddress : recipient;
    let amount: string | null;
    try {
      amount = await spendableHub(hub, state.hubReceived, holder.trim());
    } catch {
      amount = state.hubReceived;
    }
    if (amount === null) {
      return dispatch({
        type: "failed",
        message: `Your ${symbolOf(hub)} is in your wallet, but not enough to pay the second leg's gas as well. Add a little ${symbolOf(hub)}, then continue.`,
      });
    }
    const answer = await post(`/v1/swaps/${swapId}/next`, {
      swapToken: state.swapToken,
      ...(amount !== state.hubReceived ? { amount } : {}),
      ...(minAmountOut ? { minAmountOut } : {}),
    }).catch(() => null);
    if (!answer) return dispatch({ type: "failed", message: "Crossfare did not answer. Your first leg's tokens are safe in your wallet; try again." });
    if (answer.status === 409 && answer.body?.error === "price_moved") {
      setNextLegOffer(answer.body.leg);
      return dispatch({
        type: "failed",
        message: `The second leg's price moved: it now gives about ${formatAmount(answer.body.leg.amountOut)} ${symbolOf(to)}, below the minimum you were quoted. Your ${symbolOf(hub)} is safe in your wallet.`,
      });
    }
    if (!answer.ok) return dispatch({ type: "failed", message: answer.message });
    const { transactions, solana: solanaTx, leg, legCount } = answer.body;
    dispatch({ type: "swap_prepared", swapId, swapPayment: null, transactions, solana: solanaTx, leg, legCount });
    if (solanaTx) await signWithSolana(swapId, solanaTx);
    else await signWithWallet(swapId, transactions);
  }

  async function signWithWallet(swapId: string, transactions: SwapTransaction[]) {
    try {
      await signAll(swapId, transactions);
    } catch (error) {
      const rejected = /reject|denied/i.test((error as Error).message);
      dispatch({
        type: "failed",
        message: rejected
          ? "You rejected the transaction in your wallet, and nothing was sent."
          : "The transaction did not go through. Check your wallet's balance, then try again.",
      });
    }
  }

  function sendWithWallet() {
    if (!state.swapId) return;
    dispatch({ type: "wallet_send_requested" });
    signWithWallet(state.swapId, state.transactions);
  }

  const toOptions = assets.filter((asset) => asset.id !== from);
  const chosen = state.routes.find((route) => route.quoteId === state.chosenQuoteId);
  const awaitingDeposit = state.swapStatus === "awaiting_deposit" || (state.step === "signing" && state.deposit !== null);
  const hashLinks = explorerLinks(state.txHashes, from, to);
  const stations = journeyStations(state);
  const stages = orderStages(state);
  const currentStation = stations.find((station) => station.state === "current");

  const shownOut = best?.amountOut ?? live?.amountOut ?? null;
  const shownUsd = best?.usd ?? live?.usd;
  const estimated = !best && !!live?.estimated;

  function pickFrom(id: string) {
    if (id === to) setTo(from);
    setFrom(id);
  }

  function flip() {
    const oldFrom = from;
    setFrom(to);
    setTo(oldFrom);
  }

  const sentHash = hashLinks.find((link) => link.kind === "deposit");
  const fromChain = from.split(":")[0] ?? "";
  const sentLink = sentHash
    ? { label: sentHash.label, url: sentHash.url }
    : state.deposit
      ? depositAddressLink(fromChain, state.deposit.address)
      : null;
  const proofLinks = [
    ...hashLinks.map((link) => ({ label: `${link.kind === "deposit" ? "Deposit" : "Delivery"} on ${link.label}`, url: link.url })),
    ...(chosen?.arkiv.entityKey ? [{ label: "Public record on Arkiv", url: arkivEntityUrl(chosen.arkiv.entityKey) }] : []),
    ...(state.quotePayment ? [{ label: "Quote payment on HashScan", url: hashscanUrl(state.quotePayment) }] : []),
    ...(state.swapPayment ? [{ label: "Swap fee on HashScan", url: hashscanUrl(state.swapPayment) }] : []),
  ];
  const quotesShowing = !hasOrder && (state.step === "quoting" || state.routes.length > 0);
  const elapsedSeconds = startedAt.current === null ? 0 : Math.max(0, Math.round((now.getTime() - startedAt.current) / 1000));

  return (
    <div className={quotesShowing ? "stage stage-split" : "stage"}>
      {!hasOrder && !quotesShowing && (
        <header className="intro">
          <h1>Swap across chains.</h1>
          <p>Every quote goes on a public record before you send anything.</p>
        </header>
      )}

      {!hasOrder && (
        <form className="swap glass" onSubmit={getQuotes}>
          <fieldset disabled={busy}>
            <div className="swap-panel">
              <label htmlFor="send-amount">You send</label>
              <div className="swap-row">
                <input
                  id="send-amount"
                  className="swap-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  required
                  pattern="[0-9]*\.?[0-9]+"
                  placeholder="0"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value.replace(",", "."))}
                />
                <TokenButton label="You send" asset={from} assets={assets} chains={chains} catalogStatus={catalogStatus} onPick={pickFrom} />
              </div>
              <p className={pricing && !shownUsd ? "swap-sub is-loading" : "swap-sub"}>{pricing ? " " : (formatUsd(shownUsd?.in) ?? " ")}</p>
            </div>

            <button type="button" className="swap-arrow" aria-label="Swap the two assets" onClick={flip}>
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path d="M12 5v14m0 0-6-6m6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            <div className="swap-panel">
              <span className="swap-label">You receive</span>
              <div className="swap-row">
                <output className={shownOut && !pricing ? "swap-amount" : "swap-amount is-empty"} aria-busy={pricing} aria-live="polite">
                  {pricing ? (
                    <span className="skeleton skeleton-amount" />
                  ) : shownOut ? (
                    <span className="tick" key={shownOut}>
                      {estimated && "~"}
                      {formatAmount(shownOut)}
                    </span>
                  ) : (
                    "0"
                  )}
                </output>
                <TokenButton label="You receive" asset={to} assets={toOptions} chains={chains} catalogStatus={catalogStatus} onPick={setTo} />
              </div>
              <p className={pricing ? "swap-sub is-loading" : "swap-sub"}>
                {pricing
                  ? " "
                  : price.status === "no_route"
                    ? noRouteMessage(from, to, isUnverified)
                    : price.status === "unavailable"
                      ? "Prices aren't available right now. You can still get quotes."
                      : (formatUsd(shownUsd?.out) ?? " ")}
              </p>
            </div>

            {[from, to].filter(isUnverified).map((id) => {
              const contract = contractOf(id);
              const chain = id.split(":")[0] ?? "";
              const link = explorerAddressUrl(chain, contract);
              return (
                <p key={id} className="swap-warning" role="alert">
                  {symbolOf(id)} is on no token list. Anyone can deploy a token with any name, so check its contract,{" "}
                  {link ? (
                    <a href={link} target="_blank" rel="noreferrer">
                      {shorten(contract)}
                    </a>
                  ) : (
                    shorten(contract)
                  )}
                  , before you swap.
                </p>
              );
            })}

            <details className="swap-details">
              <summary aria-busy={pricing}>
                {pricing ? (
                  <span className="skeleton skeleton-line" />
                ) : shownOut ? (
                  <span className="swap-summary tick" key={`${shownOut}-rate`}>
                    {formatRate(amount, shownOut, symbolOf(from), symbolOf(to))}
                    {unitPrice(shownOut, shownUsd?.out) && ` (${symbolOf(to)} at ${unitPrice(shownOut, shownUsd?.out)})`}
                  </span>
                ) : (
                  <span className="swap-summary-empty">Enter an amount to see the price</span>
                )}
                {price.status === "ready" && !best && (
                  <span className="refresh-ring" key={price.fetchedAt} style={{ animationDuration: `${price.refreshMs}ms` }} title="Time until this price refreshes" />
                )}
                <svg className="swap-chevron" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                  <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </summary>
              <dl>
                {shownOut && <PriceRows amount={amount} amountOut={shownOut} usd={shownUsd} from={from} to={to} etaSeconds={best?.etaSeconds ?? live?.etaSeconds ?? 0} />}
                {live && !best && (
                  <div>
                    <dt>Best route right now</dt>
                    <dd>{providerShort({ venue: live.venue, provider: live.provider } as PublicRoute)}</dd>
                  </div>
                )}
                <div className="swap-slippage">
                  <dt>
                    <label htmlFor="slippage">Max slippage</label>
                  </dt>
                  <dd className="swap-slippage-input">
                    <input
                      id="slippage"
                      inputMode="decimal"
                      required
                      pattern="[0-9]*\.?[0-9]+"
                      value={slippage}
                      onChange={(event) => setSlippageChoice(event.target.value)}
                    />
                    %
                  </dd>
                </div>
              </dl>
            </details>

            <label className="field">
              <span>Receiving address on {chainNameOf(to)}</span>
              <input
                required
                autoComplete="off"
                spellCheck={false}
                placeholder="Where the funds should arrive"
                value={recipient}
                onChange={(event) => setRecipient(event.target.value)}
              />
            </label>

            <label className="field">
              <span>Refund address on {chainNameOf(from)}</span>
              <input
                required
                autoComplete="off"
                spellCheck={false}
                placeholder="A wallet you control"
                value={refundAddress}
                onChange={(event) => setRefundAddress(event.target.value)}
              />
              <small>If the swap can't go ahead, your funds return here. Don't use an exchange address.</small>
            </label>

            <button className="primary swap-action" disabled={busy}>
              {state.step === "quoting" && <span className="spinner" aria-hidden="true" />}
              {state.step === "quoting" ? "Paying for quotes and publishing them" : "Get quotes"}
            </button>
            <p className="swap-note">No account or wallet needed: send the deposit from any wallet or exchange. Swaps use real funds on mainnet.</p>
          </fieldset>
        </form>
      )}

      <div className="stage-side">
      {state.error && (
        <p className="message message-error glass" role="alert">
          {state.error}
        </p>
      )}
      {state.notice && (
        <p className="message glass" role="status">
          {state.notice}
        </p>
      )}

      {state.step === "quoting" && (
        <section className="routes" aria-label="Loading quotes">
          <div className="route route-skeleton glass" aria-hidden="true">
            <span className="skeleton skeleton-line" />
            <span className="skeleton skeleton-big" />
            <span className="skeleton skeleton-line" />
          </div>
        </section>
      )}

      {state.routes.length > 0 && !hasOrder && (
        <section className="routes" aria-label="Quotes" ref={routesRef}>
          {state.routes.map((route) => (
            <RouteRow
              key={route.quoteId}
              route={route}
              from={from}
              to={to}
              amount={amount}
              isBest={best?.quoteId === route.quoteId && state.routes.length > 1}
              advantage={bestAdvantage(state.routes)}
              now={now}
              connected={isConnected}
              wallets={{
                ...(address ? { evm: address } : {}),
                ...(solana.account ? { solana: solana.account.address } : {}),
                sender: refundAddress,
                recipient,
              }}
              chosen={state.chosenQuoteId === route.quoteId}
              disabled={busy}
              onSwap={() => swap(route)}
              onConnect={onConnectWallet}
              onConnectSolana={() => setSolanaChooserOpen(true)}
            />
          ))}
        </section>
      )}

        {!hasOrder && state.step !== "idle" && currentStation && (
          <p className="quote-proof">
            <span>{currentStation.detail}.</span>
            {state.quotePayment && (
              <a href={hashscanUrl(state.quotePayment)} target="_blank" rel="noreferrer">
                Quote fee on HashScan
              </a>
            )}
          </p>
        )}
      </div>

      {state.deposit && awaitingDeposit && (
        <OrderPanel
          stages={stages}
          deposit={state.deposit}
          depositShort={state.depositShort}
          route={chosen}
          toAsset={to}
          refundAddress={refundAddress}
          recipient={recipient}
          now={now}
          connected={address}
          sending={state.step === "signing"}
          canSendWithWallet={state.transactions.length > 0 && isConnected && canSignOn(from)}
          onSendWithWallet={sendWithWallet}
          onStartOver={() => dispatch({ type: "reset" })}
        />
      )}

      {state.swapStatus === "awaiting_next_leg" && (
        <section className="order glass" aria-label="Second leg">
          <Stepper stages={stages} />
          <div className="order-head">
            <h2>First leg done</h2>
          </div>
          <p className="order-lead">
            {state.hubReceived ? `${formatAmount(state.hubReceived)} ${symbolOf(chosen?.legs?.[0]?.to ?? "")}` : "The first leg's tokens"} arrived in
            your wallet. Sign the second leg to finish the swap into {symbolOf(to)}.
          </p>
          <div className="order-actions">
            <button className="primary order-send" disabled={busy} onClick={() => continueSecondLeg()}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {busy ? "Preparing" : "Sign the second leg"}
            </button>
            {nextLegOffer && !busy && (
              <button className="ghost" onClick={() => continueSecondLeg(nextLegOffer.minAmountOut)}>
                Accept at least {formatAmount(nextLegOffer.minAmountOut)} {symbolOf(to)}
              </button>
            )}
          </div>
          <p className="order-note">Nothing happens until you sign. Your tokens stay in your wallet if you stop here.</p>
        </section>
      )}

      {solanaChooserOpen && <SolanaWalletChooser solana={solana} onClose={() => setSolanaChooserOpen(false)} />}

      {state.step === "signing" && !state.deposit && (
        <p className="message message-wait glass" role="status">
          <span className="spinner" aria-hidden="true" />
          Confirm the transaction in your wallet.
        </p>
      )}

      {state.step === "tracking" && !awaitingDeposit && moving && (
        <InFlight
          stages={stages}
          status={state.swapStatus ?? ""}
          route={chosen}
          providerName={providerShort(chosen)}
          from={from}
          to={to}
          amount={state.amountSent ?? amount}
          recipient={recipient}
          elapsedSeconds={elapsedSeconds}
          sentLink={sentLink}
          sentDiffers={sentComparedToQuote(state.amountSent, amount) !== null}
        />
      )}

      {state.swapStatus === "completed" && (
        <Delivered
          route={chosen}
          from={from}
          to={to}
          amount={amount}
          amountSent={state.amountSent}
          partialRefund={state.partialRefund}
          refundAddress={refundAddress}
          recipient={recipient}
          amountReceived={state.amountReceived}
          elapsedSeconds={elapsedFinal}
          links={proofLinks}
          onAgain={() => dispatch({ type: "reset" })}
        />
      )}

      {state.step === "finished" && state.swapStatus !== "completed" && (
        <section className="receipt glass" aria-label="Swap result">
          <h2>{state.swapStatus === "expired" ? "Order expired" : state.swapStatus === "refunded" ? "Swap refunded" : "Swap failed"}</h2>
          <p className="status">{statusLabel(state.swapStatus ?? "")}</p>
          <p className="receipt-note">
            {state.swapStatus === "expired"
              ? "Don't send to that deposit address. Start a new swap to get a fresh quote. If you already sent funds, keep the transaction hash, because the provider may still process them."
              : state.swapStatus === "refunded"
                ? `The provider returned ${state.amountSent ? `${state.amountSent} ${symbolOf(from)}` : "your funds"} to ${shorten(refundAddress)}.${state.refundReason ? ` Its reason: ${state.refundReason.replaceAll("_", " ").toLowerCase()}.` : ""}`
                : "The swap didn't complete. Check the links below for where your funds are."}
          </p>
          {proofLinks.length > 0 && (
            <div className="proof-links">
              {proofLinks.map((link) => (
                <a key={link.url} href={link.url} target="_blank" rel="noreferrer">
                  {link.label}
                </a>
              ))}
            </div>
          )}
          <button className="primary receipt-action" onClick={() => dispatch({ type: "reset" })}>
            Start another swap
          </button>
        </section>
      )}

      {hasOrder && awaitingDeposit && proofLinks.length > 0 && (
        <div className="proof-links proof-links-center">
          {proofLinks.map((link) => (
            <a key={link.url} href={link.url} target="_blank" rel="noreferrer">
              {link.label}
            </a>
          ))}
        </div>
      )}

    </div>
  );
}
