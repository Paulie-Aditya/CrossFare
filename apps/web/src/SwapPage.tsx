import { useEffect, useMemo, useReducer, useState } from "react";
import { useAccount, useConfig, useSendTransaction, useSwitchChain } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { QRCodeSVG } from "qrcode.react";
import { get, post } from "./api.ts";
import {
  arkivEntityUrl,
  bestRoute,
  buildQuoteRequest,
  defaultSlippage,
  explorerLinks,
  formatAmount,
  formatCountdown,
  formatDeadline,
  formatRate,
  formatUsd,
  hashscanUrl,
  initialJourney,
  journeyStations,
  reduceJourney,
  routeAction,
  shorten,
  walletMatches,
  type Deposit,
  type PublicRoute,
  type SwapTransaction,
} from "./journey.ts";

interface AssetOption {
  id: string;
  chain: string;
  symbol: string;
  venues: string[];
}

const CHAIN_NAMES: Record<string, string> = {
  base: "Base",
  eth: "Ethereum",
  btc: "Bitcoin",
  sol: "Solana",
  xrp: "XRP Ledger",
};
const EVM_CHAINS = ["base", "eth"];
const STATUS_POLL_MS = 15_000;
const ARKIV_POLL_MS = 5_000;
const COPIED_MS = 2_000;

const assetLabel = (asset: AssetOption) => `${asset.symbol.toUpperCase()} on ${CHAIN_NAMES[asset.chain] ?? asset.chain}`;
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

function useNow(active: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function RouteRow(props: {
  route: PublicRoute;
  from: string;
  to: string;
  amount: string;
  isBest: boolean;
  now: Date;
  disabled: boolean;
  chosen: boolean;
  connected: boolean;
  onSwap: () => void;
}) {
  const { route, from, to, amount, isBest, now, disabled, chosen, connected, onSwap } = props;
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
  const usd = formatUsd(route.usd?.out);
  const rate = formatRate(amount, route.amountOut, symbolOf(from), symbolOf(to));
  return (
    <article className={isBest ? "route route-best glass" : "route glass"} data-chosen={chosen || undefined}>
      <div className="route-head">
        <p className="route-venue">{providerName(route)}</p>
        {isBest && <p className="route-badge">Best price</p>}
        <p className={expired ? "route-clock is-expired" : "route-clock"} aria-label={`Quote valid for ${countdown}`}>
          {countdown}
        </p>
      </div>
      <p className="route-amount">
        {formatAmount(route.amountOut)} <span>{symbolOf(to)}</span>
        {usd && <small>{usd}</small>}
      </p>
      <dl className="route-facts">
        {rate && (
          <div>
            <dt>Rate</dt>
            <dd>{rate}</dd>
          </div>
        )}
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
          <span>Publishing to Arkiv</span>
        )}
        <button className="route-action" disabled={disabled || action === "connect"} onClick={onSwap}>
          {actionLabel}
        </button>
      </div>
    </article>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      setCopied(false);
    }
  }
  return (
    <button type="button" className="order-copy" onClick={copy}>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function OrderPanel(props: {
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
  const rate = route && formatRate(deposit.amount, route.amountOut, symbolOf(deposit.asset), symbolOf(toAsset));
  const usd = formatUsd(route?.usd?.out);
  return (
    <section className="order glass" aria-label="Deposit instructions">
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
          {rate && (
            <div>
              <dt>Rate</dt>
              <dd>{rate}</dd>
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

export function SwapPage() {
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
  const stations = useMemo(() => journeyStations(state), [state]);
  const now = useNow(state.step !== "idle" && state.step !== "finished");
  const best = bestRoute(state.routes);
  const busy = state.step === "quoting" || state.step === "preparing" || state.step === "signing";
  const hasPending = state.routes.some((route) => route.arkiv.pending);

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
    const timer = setInterval(async () => {
      const answer = await get(`/v1/swaps/${swapId}`);
      if (answer.ok) {
        dispatch({
          type: "status",
          status: answer.body.status,
          amountReceived: answer.body.amountReceived,
          txHashes: answer.body.txHashes,
        });
      }
    }, STATUS_POLL_MS);
    return () => clearInterval(timer);
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
  const hasOrder = state.swapId !== null;
  const awaitingDeposit = state.swapStatus === "awaiting_deposit" || (state.step === "signing" && state.deposit !== null);
  const hashLinks = explorerLinks(state.txHashes, from, to);
  const bestRate = best && formatRate(amount, best.amountOut, symbolOf(from), symbolOf(to));
  const currentStation = stations.find((station) => station.state === "current");
  const receiptTitle =
    state.swapStatus === "completed"
      ? "Delivered"
      : state.swapStatus === "expired"
        ? "Order expired"
        : state.step === "finished"
          ? "Swap ended"
          : "Swap in progress";

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
          <div className="swap-panel">
            <label htmlFor="send-amount">You send</label>
            <div className="swap-row">
              <input
                id="send-amount"
                className="swap-amount"
                inputMode="decimal"
                required
                pattern="[0-9]*\.?[0-9]+"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
              <select aria-label="Asset to send" value={from} onChange={(event) => setFrom(event.target.value)}>
                {fromOptions.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {assetLabel(asset)}
                  </option>
                ))}
              </select>
            </div>
            <p className="swap-sub">{formatUsd(best?.usd?.in) ?? " "}</p>
          </div>

          <div className="swap-arrow" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path d="M12 5v14m0 0-6-6m6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>

          <div className="swap-panel">
            <span className="swap-label">You receive</span>
            <div className="swap-row">
              <output className={best ? "swap-amount" : "swap-amount is-empty"}>
                {best ? formatAmount(best.amountOut) : "0"}
              </output>
              <select aria-label="Asset to receive" value={to} onChange={(event) => setTo(event.target.value)}>
                {toOptions.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {assetLabel(asset)}
                  </option>
                ))}
              </select>
            </div>
            <p className="swap-sub">
              {best ? [formatUsd(best.usd?.out), bestRate].filter(Boolean).join(", ") : "Get quotes to see the price"}
            </p>
          </div>

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
            {state.step === "quoting" ? "Getting quotes" : "Get quotes"}
          </button>
          <p className="swap-note">
            No account or wallet connection needed: send the deposit from any wallet or exchange. Swaps run on mainnet with
            your own funds. This demo pays Crossfare's quote fee in testnet USDC.
          </p>
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

      {state.routes.length > 0 && !hasOrder && (
        <section className="routes" aria-label="Quotes">
          {state.routes.map((route) => (
            <RouteRow
              key={route.quoteId}
              route={route}
              from={from}
              to={to}
              amount={amount}
              isBest={best?.quoteId === route.quoteId && state.routes.length > 1}
              now={now}
              connected={isConnected}
              chosen={state.chosenQuoteId === route.quoteId}
              disabled={busy}
              onSwap={() => swap(route)}
            />
          ))}
        </section>
      )}

      {state.deposit && awaitingDeposit && (
        <OrderPanel
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
        <p className="message glass" role="status">
          Confirm the transaction in your wallet.
        </p>
      )}

      {(state.step === "tracking" || state.step === "finished") && !awaitingDeposit && chosen && (
        <section className="receipt glass" aria-label="Swap result">
          <h2>{receiptTitle}</h2>
          {state.swapStatus === "expired" ? (
            <p className="receipt-note">
              Don't send to that deposit address. Start a new swap to get a fresh quote. If you already sent funds, keep the
              transaction hash, because the provider may still process them.
            </p>
          ) : (
            <dl>
              <div>
                <dt>You get at least</dt>
                <dd>
                  {formatAmount(chosen.minAmountOut)} {symbolOf(to)}
                </dd>
              </div>
              <div>
                <dt>Received</dt>
                <dd>{state.amountReceived ? `${formatAmount(state.amountReceived)} ${symbolOf(to)}` : "Waiting"}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{(state.swapStatus ?? "").replaceAll("_", " ")}</dd>
              </div>
            </dl>
          )}
          {state.step === "finished" && (
            <button className="primary receipt-action" onClick={() => dispatch({ type: "reset" })}>
              Start another swap
            </button>
          )}
        </section>
      )}

      {state.step !== "idle" && (
        <aside className="progress glass" aria-label="Swap progress">
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
          <div className="progress-links">
            {state.quotePayment && (
              <a href={hashscanUrl(state.quotePayment)} target="_blank" rel="noreferrer">
                Payment on HashScan
              </a>
            )}
            {chosen?.arkiv.entityKey && (
              <a href={arkivEntityUrl(chosen.arkiv.entityKey)} target="_blank" rel="noreferrer">
                Quote on Arkiv
              </a>
            )}
            {state.swapPayment && (
              <a href={hashscanUrl(state.swapPayment)} target="_blank" rel="noreferrer">
                Swap fee on HashScan
              </a>
            )}
            {hashLinks.map((link) => (
              <a key={link.hash} href={link.url} target="_blank" rel="noreferrer">
                {shorten(link.hash)} on {link.label}
              </a>
            ))}
          </div>
        </aside>
      )}
    </div>
  );
}
