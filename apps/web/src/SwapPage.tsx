import { useEffect, useMemo, useReducer, useState } from "react";
import { useAccount, useConfig, useSwitchChain, useSendTransaction } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { QRCodeSVG } from "qrcode.react";
import { get, post } from "./api.ts";
import {
  arkivEntityUrl,
  bestRoute,
  defaultSlippage,
  explorerLinks,
  formatCountdown,
  formatDeadline,
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

function useNow(active: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function Ticket(props: {
  route: PublicRoute;
  toAsset: string;
  isBest: boolean;
  now: Date;
  disabled: boolean;
  chosen: boolean;
  onSwap: () => void;
  connected: boolean;
}) {
  const { route, toAsset, isBest, now, disabled, chosen, onSwap, connected } = props;
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
  return (
    <article className={`ticket ticket-${route.venue}`} data-chosen={chosen || undefined}>
      <div className="ticket-main">
        <p className="ticket-venue">
          {route.venue === "uniswap" ? "Uniswap" : "SwapKit"}
          {route.provider && <span> through {route.provider.replaceAll("_", " ")}</span>}
        </p>
        <p className="ticket-amount">
          {route.minAmountOut} <span>{symbolOf(toAsset)}</span>
        </p>
        <p className="ticket-note">Guaranteed minimum. Expected {route.amountOut}.</p>
        {isBest && <p className="ticket-best">Best guaranteed amount</p>}
      </div>
      <div className="ticket-stub">
        <p className={expired ? "ticket-clock is-expired" : "ticket-clock"} aria-label={`Quote valid for ${countdown}`}>
          {countdown}
        </p>
        <p className="ticket-link">
          {route.arkiv.entityKey ? (
            <a href={arkivEntityUrl(route.arkiv.entityKey)} target="_blank" rel="noreferrer">
              Check on Arkiv
            </a>
          ) : (
            "Publishing to Arkiv"
          )}
        </p>
        <button className="ticket-action" disabled={disabled || action === "connect"} onClick={onSwap}>
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
  minimum: string | null;
  toAsset: string;
  sender: string;
  recipient: string;
  now: Date;
  connected: string | undefined;
  sending: boolean;
  canSendWithWallet: boolean;
  onSendWithWallet: () => void;
  onStartOver: () => void;
}) {
  const { deposit, minimum, toAsset, sender, recipient, now, connected, sending, canSendWithWallet } = props;
  const matches = walletMatches(connected, sender);
  return (
    <section className="order" aria-label="Deposit instructions">
      <h2>Send your deposit</h2>
      <p className="order-lead">
        Send exactly{" "}
        <strong>
          {deposit.amount} {symbolOf(deposit.asset)} on {chainNameOf(deposit.asset)}
        </strong>{" "}
        to:
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
          <QRCodeSVG value={deposit.address} size={132} marginSize={2} title="Deposit address as a QR code" />
        </div>
        <dl className="order-facts">
          {deposit.expiresAt && (
            <div>
              <dt>Send before</dt>
              <dd>{formatDeadline(deposit.expiresAt, now)}</dd>
            </div>
          )}
          {minimum && (
            <div>
              <dt>You get at least</dt>
              <dd>
                {minimum} {symbolOf(toAsset)}
              </dd>
            </div>
          )}
          <div>
            <dt>Arrives at</dt>
            <dd title={recipient}>{shorten(recipient)}</dd>
          </div>
        </dl>
      </div>
      <p className="order-note">
        Send from {shorten(sender)}. If the swap can't go ahead, your funds return to that address.
      </p>
      <div className="order-actions">
        {canSendWithWallet && matches && (
          <button className="order-send" disabled={sending} onClick={props.onSendWithWallet}>
            {sending ? "Confirm in your wallet" : "Send with wallet"}
          </button>
        )}
        {canSendWithWallet && connected && !matches && (
          <p className="order-note">Your connected wallet isn't {shorten(sender)}, so send the deposit from that wallet.</p>
        )}
        <button className="order-restart" onClick={props.onStartOver}>
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
  const [sender, setSender] = useState("");
  const [slippageChoice, setSlippageChoice] = useState<string | null>(null);

  const slippage = slippageChoice ?? defaultSlippage(from, to);
  const stations = useMemo(() => journeyStations(state), [state]);
  const now = useNow(state.step !== "idle" && state.step !== "finished");
  const best = bestRoute(state.routes);
  const busy = state.step === "quoting" || state.step === "preparing" || state.step === "signing";
  const hasPending = state.routes.some((route) => route.arkiv.pending);

  // A connected wallet fills in the sending address, which the person can still change.
  useEffect(() => {
    if (address) setSender(address);
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
    const answer = await post("/demo/quote", {
      from: { asset: from, amount, address: sender.trim() },
      to: { asset: to, address: recipient.trim() },
      mode: "exact_in",
      slippageBps: Math.round(Number(slippage) * 100),
      refundAddress: sender.trim(),
    }).catch(() => null);
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

  return (
    <div className="layout">
      <div className="column-main">
        <h1>Swap across chains. Check the quote afterwards.</h1>
        <p className="lede">
          Every quote goes on a public record before you send anything, so you can compare what you were promised with
          what you received.
        </p>

        {!hasOrder && (
          <form className="gate" onSubmit={getQuotes}>
            <label className="field field-amount">
              <span>You send</span>
              <input
                inputMode="decimal"
                required
                pattern="[0-9]*\.?[0-9]+"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </label>
            <label className="field">
              <span>From</span>
              <select value={from} onChange={(event) => setFrom(event.target.value)}>
                {fromOptions.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {assetLabel(asset)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>You get</span>
              <select value={to} onChange={(event) => setTo(event.target.value)}>
                {toOptions.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {assetLabel(asset)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field field-slippage">
              <span>Slippage %</span>
              <input
                inputMode="decimal"
                required
                pattern="[0-9]*\.?[0-9]+"
                value={slippage}
                onChange={(event) => setSlippageChoice(event.target.value)}
              />
            </label>
            <label className="field field-wide">
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
            <label className="field field-wide">
              <span>Your wallet address on {chainNameOf(from)}</span>
              <input
                required
                autoComplete="off"
                spellCheck={false}
                placeholder="The wallet you'll send from"
                value={sender}
                onChange={(event) => setSender(event.target.value)}
              />
              <small className="field-hint">It must already hold the amount. Refunds go back here.</small>
            </label>
            <button className="gate-action" disabled={busy}>
              {state.step === "quoting" ? "Getting quotes" : "Get quotes"}
            </button>
            <p className="gate-note">
              No account or wallet connection needed. Swaps run on mainnet with your own funds. Crossfare's quote fee is
              testnet USDC, and this demo pays it for you.
            </p>
          </form>
        )}

        {state.error && (
          <p className="message message-error" role="alert">
            {state.error}
          </p>
        )}
        {state.notice && (
          <p className="message" role="status">
            {state.notice}
          </p>
        )}

        {state.routes.length > 0 && !hasOrder && (
          <section className="tickets" aria-label="Quotes">
            {state.routes.map((route) => (
              <Ticket
                key={route.quoteId}
                route={route}
                toAsset={to}
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
            minimum={chosen?.minAmountOut ?? null}
            toAsset={to}
            sender={sender}
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
          <p className="message" role="status">
            Confirm the transaction in your wallet.
          </p>
        )}

        {(state.step === "tracking" || state.step === "finished") && !awaitingDeposit && chosen && (
          <section className="receipt" aria-label="Swap result">
            <h2>{state.swapStatus === "completed" ? "Delivered" : state.step === "finished" ? "Swap ended" : "Swap in progress"}</h2>
            <dl>
              <div>
                <dt>Quoted minimum</dt>
                <dd>{chosen.minAmountOut} {symbolOf(to)}</dd>
              </div>
              <div>
                <dt>Received</dt>
                <dd>{state.amountReceived ? `${state.amountReceived} ${symbolOf(to)}` : "Waiting"}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{(state.swapStatus ?? "").replaceAll("_", " ")}</dd>
              </div>
            </dl>
            {state.step === "finished" && (
              <button className="receipt-action" onClick={() => dispatch({ type: "reset" })}>
                Start another swap
              </button>
            )}
          </section>
        )}
      </div>

      <aside className="column-line" aria-label="Swap progress">
        <ol className="line">
          {stations.map((station) => (
            <li key={station.id} className={`station is-${station.state}`} aria-current={station.state === "current" ? "step" : undefined}>
              <span className="station-name">{station.name}</span>
              <span className="station-detail">{station.detail}</span>
              {station.id === "quote" && state.quotePayment && (
                <a href={hashscanUrl(state.quotePayment)} target="_blank" rel="noreferrer">
                  See the payment on HashScan
                </a>
              )}
              {station.id === "publish" && chosen?.arkiv.entityKey && (
                <a href={arkivEntityUrl(chosen.arkiv.entityKey)} target="_blank" rel="noreferrer">
                  See your quote on Arkiv
                </a>
              )}
              {station.id === "sign" && state.swapPayment && (
                <a href={hashscanUrl(state.swapPayment)} target="_blank" rel="noreferrer">
                  See the swap fee on HashScan
                </a>
              )}
              {station.id === "confirm" &&
                hashLinks.map((link) => (
                  <a key={link.hash} href={link.url} target="_blank" rel="noreferrer">
                    {shorten(link.hash)} on {link.label}
                  </a>
                ))}
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}
