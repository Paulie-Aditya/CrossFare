import { useEffect, useReducer, useRef, useState } from "react";
import { useAccount, useConfig, useSendTransaction, useSwitchChain } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { QRCodeSVG } from "qrcode.react";
import { get, post } from "./api.ts";
import { Delivered } from "./Delivered.tsx";
import {
  arkivEntityUrl,
  bestAdvantage,
  bestRoute,
  buildQuoteRequest,
  defaultSlippage,
  explorerAddressUrl,
  explorerLinks,
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
  shorten,
  statusLabel,
  swapCost,
  unitPrice,
  walletMatches,
  type Deposit,
  type OrderStage,
  type PublicRoute,
  type SwapTransaction,
} from "./journey.ts";
import { useLivePrice } from "./live-price.ts";
import { InFlight, Stepper } from "./OrderTracker.tsx";
import { CHAIN_NAMES, Coin, CopyButton, Modal } from "./ui.tsx";

interface AssetOption {
  id: string;
  chain: string;
  symbol: string;
  venues: string[];
}

const EVM_CHAINS = ["base", "eth"];
const STATUS_POLL_MS = 4_000;
const ARKIV_POLL_MS = 5_000;
const BASE_TITLE = "Crossfare";

const symbolOf = (id: string) => id.split(":")[1]?.toUpperCase() ?? id;
const chainNameOf = (id: string) => {
  const chain = id.split(":")[0] ?? "";
  return CHAIN_NAMES[chain] ?? chain;
};
const providerName = (route: PublicRoute) => {
  if (route.venue === "uniswap") return "Uniswap";
  const provider = route.provider?.replaceAll("_", " ");
  return provider ? `SwapKit via ${provider.toUpperCase()}` : "SwapKit";
};
const providerShort = (route: PublicRoute | undefined) =>
  route?.venue === "uniswap" ? "Uniswap" : (route?.provider?.replaceAll("_", " ").toUpperCase() ?? "SwapKit");

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
  onSwap: () => void;
  onConnect: () => void;
}) {
  const { route, from, to, amount, isBest, advantage, now, disabled, chosen, connected, onSwap, onConnect } = props;
  const countdown = formatCountdown(route.validUntil, now);
  const expired = countdown === "Expired";
  const action = routeAction(route, connected);
  const actionLabel = chosen
    ? "Preparing"
    : expired
      ? "Get a new price"
      : action === "deposit"
        ? "Get deposit address"
        : action === "wallet"
          ? "Swap with wallet"
          : "Connect a wallet for this route";
  const usdOut = formatUsd(route.usd?.out);
  const usdIn = formatUsd(route.usd?.in);
  return (
    <article className={isBest ? "route route-best glass" : "route glass"} data-chosen={chosen || undefined}>
      <div className="route-head">
        <p className="route-venue">{providerName(route)}</p>
        {isBest && <p className="route-badge">{advantage ? `Best price, ${advantage} more` : "Best price"}</p>}
        <p className={expired ? "route-clock is-expired" : "route-clock"} aria-label={`Quote valid for ${countdown}`}>
          {countdown}
        </p>
      </div>
      <p className="route-amount">
        {formatAmount(route.amountOut)} <span>{symbolOf(to)}</span>
        {usdOut && <small>{usdOut}</small>}
      </p>
      <dl className="route-facts">
        <div>
          <dt>You pay</dt>
          <dd>
            {amount} {symbolOf(from)}
            {usdIn && ` (${usdIn})`}
          </dd>
        </div>
        <PriceRows amount={amount} amountOut={route.amountOut} usd={route.usd} from={from} to={to} etaSeconds={route.etaSeconds} />
        <div>
          <dt>You get at least</dt>
          <dd>
            {formatAmount(route.minAmountOut)} {symbolOf(to)}
          </dd>
        </div>
      </dl>
      <div className="route-foot">
        {route.arkiv.entityKey ? (
          <a href={arkivEntityUrl(route.arkiv.entityKey)} target="_blank" rel="noreferrer">
            Public record on Arkiv
          </a>
        ) : (
          <span className="route-pending">Publishing to Arkiv</span>
        )}
        <button className="route-action" disabled={disabled} onClick={action === "connect" ? onConnect : onSwap}>
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
  connected: string | undefined;
  sending: boolean;
  canSendWithWallet: boolean;
  onSendWithWallet: () => void;
  onStartOver: () => void;
}) {
  const { deposit, route, toAsset, refundAddress, recipient, now, connected, sending, canSendWithWallet } = props;
  const matches = walletMatches(connected, refundAddress);
  const usd = formatUsd(route?.usd?.out);
  return (
    <section className="order glass" aria-label="Deposit instructions">
      <Stepper stages={props.stages} />
      <div className="order-head">
        <h2>Send your deposit</h2>
        {deposit.expiresAt && (
          <p className="order-clock">
            <span>Time left</span> {formatDeadline(deposit.expiresAt, now)}
          </p>
        )}
      </div>
      <p className="order-lead">
        Send exactly{" "}
        <strong>
          {deposit.amount} {symbolOf(deposit.asset)}
        </strong>{" "}
        on {chainNameOf(deposit.asset)} to:
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
      <div className="order-watch" role="status">
        <span className="radar" aria-hidden="true" />
        <p>Watching {chainNameOf(deposit.asset)} for your deposit. This page moves on by itself once it lands.</p>
      </div>
      <div className="order-body">
        <div className="order-qr">
          <QRCodeSVG value={deposit.address} size={136} marginSize={1} title="Deposit address as a QR code" />
        </div>
        <dl className="order-facts">
          {route && (
            <div>
              <dt>You receive about</dt>
              <dd className="order-receive">
                {formatAmount(route.amountOut)} {symbolOf(toAsset)}
                {usd && <small>{usd}</small>}
              </dd>
            </div>
          )}
          {route && (
            <div>
              <dt>You get at least</dt>
              <dd>
                {formatAmount(route.minAmountOut)} {symbolOf(toAsset)}
              </dd>
            </div>
          )}
          {route && formatRate(deposit.amount, route.amountOut, symbolOf(deposit.asset), symbolOf(toAsset)) && (
            <div>
              <dt>Rate</dt>
              <dd>{formatRate(deposit.amount, route.amountOut, symbolOf(deposit.asset), symbolOf(toAsset))}</dd>
            </div>
          )}
        </dl>
      </div>
      <div className="order-recipient-row">
        <p>Arrives at, on {chainNameOf(toAsset)}</p>
        <p className="order-recipient">{recipient}</p>
      </div>
      <p className="order-note">
        Send from any wallet or exchange, on {chainNameOf(deposit.asset)} only. If an exchange takes a withdrawal fee, add
        it so the full amount arrives, because you receive less if less arrives. If the swap can't go ahead, your funds
        return to {shorten(refundAddress)}.
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
        <button className="ghost order-restart" onClick={props.onStartOver}>
          Start over
        </button>
      </div>
    </section>
  );
}

function TokenButton(props: { label: string; asset: string; options: AssetOption[]; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="token"
        aria-label={`${props.label}: ${symbolOf(props.asset)} on ${chainNameOf(props.asset)}`}
        onClick={() => setOpen(true)}
      >
        <Coin asset={props.asset} size={26} />
        <span className="token-text">
          <strong>{symbolOf(props.asset)}</strong>
          <small>{chainNameOf(props.asset)}</small>
        </span>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <Modal title={props.label} onClose={() => setOpen(false)}>
          <ul className="token-list">
            {props.options.map((option) => (
              <li key={option.id}>
                <button
                  type="button"
                  className="token-option"
                  aria-current={option.id === props.asset || undefined}
                  onClick={() => {
                    props.onPick(option.id);
                    setOpen(false);
                  }}
                >
                  <Coin asset={option.id} size={36} />
                  <span>
                    <strong>{option.symbol.toUpperCase()}</strong>
                    <small>on {CHAIN_NAMES[option.chain] ?? option.chain}</small>
                  </span>
                  {option.id === props.asset && (
                    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                      <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </>
  );
}

export function SwapPage({ onConnectWallet }: { onConnectWallet: () => void }) {
  const { address, chainId, isConnected } = useAccount();
  const config = useConfig();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();

  const [state, dispatch] = useReducer(reduceJourney, initialJourney);
  const [assets, setAssets] = useState<AssetOption[]>([]);
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
    if (address) setRefundAddress(address);
  }, [address]);

  useEffect(() => {
    get("/v1/assets").then((answer) => answer.ok && setAssets(answer.body.assets));
  }, []);

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
      const target = transaction.chainId as 1 | 8453;
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

    const { swapId, transactions, deposit, payment } = answer.body;
    dispatch({ type: "swap_prepared", swapId, swapPayment: payment?.transactionId ?? null, transactions, deposit });
    if (!deposit) await signWithWallet(swapId, transactions);
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

  const fromOptions = assets.filter((asset) => EVM_CHAINS.includes(asset.chain));
  const toOptions = assets.filter((asset) => asset.id !== from);
  const chosen = state.routes.find((route) => route.quoteId === state.chosenQuoteId);
  const awaitingDeposit = state.swapStatus === "awaiting_deposit" || (state.step === "signing" && state.deposit !== null);
  const hashLinks = explorerLinks(state.txHashes, from, to);
  const stations = journeyStations(state);
  const stages = orderStages(state);
  const currentStation = stations.find((station) => station.state === "current");
  const canFlip = EVM_CHAINS.includes(to.split(":")[0] ?? "");

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
      ? { label: fromChain === "base" ? "Basescan" : "Etherscan", url: explorerAddressUrl(fromChain, state.deposit.address) }
      : null;
  const proofLinks = [
    ...hashLinks.map((link) => ({ label: `${link.kind === "deposit" ? "Deposit" : "Delivery"} on ${link.label}`, url: link.url })),
    ...(chosen?.arkiv.entityKey ? [{ label: "Public record on Arkiv", url: arkivEntityUrl(chosen.arkiv.entityKey) }] : []),
    ...(state.quotePayment ? [{ label: "Quote payment on HashScan", url: hashscanUrl(state.quotePayment) }] : []),
    ...(state.swapPayment ? [{ label: "Swap fee on HashScan", url: hashscanUrl(state.swapPayment) }] : []),
  ];
  const elapsedSeconds = startedAt.current === null ? 0 : Math.max(0, Math.round((now.getTime() - startedAt.current) / 1000));

  return (
    <div className="stage">
      {!hasOrder && (
        <header className="intro">
          <h1>Swap across chains.</h1>
          <p>Every quote goes on a public record before you send anything, so you can check what you were promised.</p>
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
                <TokenButton label="You send" asset={from} options={fromOptions} onPick={pickFrom} />
              </div>
              <p className={pricing && !shownUsd ? "swap-sub is-loading" : "swap-sub"}>{pricing ? " " : (formatUsd(shownUsd?.in) ?? " ")}</p>
            </div>

            <button type="button" className="swap-arrow" aria-label="Swap the two assets" disabled={!canFlip} onClick={flip}>
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
                <TokenButton label="You receive" asset={to} options={toOptions} onPick={setTo} />
              </div>
              <p className={pricing ? "swap-sub is-loading" : "swap-sub"}>
                {pricing
                  ? " "
                  : price.status === "no_route"
                    ? "No route for this amount. Try a larger one."
                    : price.status === "unavailable"
                      ? "Prices aren't available right now. You can still get quotes."
                      : (formatUsd(shownUsd?.out) ?? " ")}
              </p>
            </div>

            {!best && (pricing || live) && (
              <dl className="swap-details" aria-busy={pricing}>
                {pricing || !live ? (
                  <>
                    <div><dt><span className="skeleton skeleton-line" /></dt><dd><span className="skeleton skeleton-line" /></dd></div>
                    <div><dt><span className="skeleton skeleton-line" /></dt><dd><span className="skeleton skeleton-line" /></dd></div>
                  </>
                ) : (
                  <>
                    <PriceRows amount={amount} amountOut={live.amountOut} usd={live.usd} from={from} to={to} etaSeconds={live.etaSeconds} />
                    <div>
                      <dt>Best route right now</dt>
                      <dd className="swap-route">
                        {providerShort({ venue: live.venue, provider: live.provider } as PublicRoute)}
                        {price.status === "ready" && (
                          <span className="refresh-ring" key={price.fetchedAt} style={{ animationDuration: `${price.refreshMs}ms` }} title="Time until this price refreshes" />
                        )}
                      </dd>
                    </div>
                  </>
                )}
              </dl>
            )}

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

            <label className="swap-slippage">
              <span>Max slippage</span>
              <span className="swap-slippage-input">
                <input
                  inputMode="decimal"
                  required
                  pattern="[0-9]*\.?[0-9]+"
                  aria-label="Slippage percent"
                  value={slippage}
                  onChange={(event) => setSlippageChoice(event.target.value)}
                />
                %
              </span>
            </label>

            <button className="primary swap-action" disabled={busy}>
              {state.step === "quoting" && <span className="spinner" aria-hidden="true" />}
              {state.step === "quoting" ? "Paying for quotes and publishing them" : "Get quotes"}
            </button>
            <p className="swap-note">
              No account or wallet connection needed: send the deposit from any wallet or exchange. Prices here are estimates
              until you get quotes. Swaps run on mainnet with your own funds. This demo pays Crossfare's quote fee in testnet USDC.
            </p>
          </fieldset>
        </form>
      )}

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
              chosen={state.chosenQuoteId === route.quoteId}
              disabled={busy}
              onSwap={() => swap(route)}
              onConnect={onConnectWallet}
            />
          ))}
        </section>
      )}

      {state.deposit && awaitingDeposit && (
        <OrderPanel
          stages={stages}
          deposit={state.deposit}
          route={chosen}
          toAsset={to}
          refundAddress={refundAddress}
          recipient={recipient}
          now={now}
          connected={address}
          sending={state.step === "signing"}
          canSendWithWallet={state.transactions.length > 0 && isConnected}
          onSendWithWallet={sendWithWallet}
          onStartOver={() => dispatch({ type: "reset" })}
        />
      )}

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
          amount={amount}
          recipient={recipient}
          elapsedSeconds={elapsedSeconds}
          sentLink={sentLink}
        />
      )}

      {state.swapStatus === "completed" && (
        <Delivered
          route={chosen}
          from={from}
          to={to}
          amount={amount}
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
                ? `The provider returned your funds to ${shorten(refundAddress)}.`
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

      {!hasOrder && state.step !== "idle" && (
        <aside className="progress glass" aria-label="How this quote was made">
          <ol className="line">
            {stations.map((station) => (
              <li
                key={station.id}
                className={`station is-${station.state}`}
                aria-current={station.state === "current" ? "step" : undefined}
              >
                <span className="station-name">{station.name}</span>
              </li>
            ))}
          </ol>
          {currentStation && <p className="progress-detail">{currentStation.detail}</p>}
          {state.quotePayment && (
            <div className="proof-links proof-links-center">
              <a href={hashscanUrl(state.quotePayment)} target="_blank" rel="noreferrer">
                Payment on HashScan
              </a>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}
