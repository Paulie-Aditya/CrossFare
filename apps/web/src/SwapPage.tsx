import { useEffect, useMemo, useReducer, useState } from "react";
import { useAccount, useConfig, useSwitchChain, useSendTransaction } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { get, post } from "./api.ts";
import {
  arkivEntityUrl,
  bestRoute,
  explorerTxUrl,
  formatCountdown,
  hashscanUrl,
  initialJourney,
  journeyStations,
  reduceJourney,
  shorten,
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
const POLL_MS = 15_000;

const assetLabel = (asset: AssetOption) => `${asset.symbol.toUpperCase()} on ${CHAIN_NAMES[asset.chain] ?? asset.chain}`;
const symbolOf = (id: string) => id.split(":")[1]?.toUpperCase() ?? id;

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
        <button className="ticket-action" disabled={disabled || !connected} onClick={onSwap}>
          {chosen ? "Preparing swap" : expired ? "Get a new price" : "Swap with this quote"}
        </button>
      </div>
    </article>
  );
}

export function SwapPage() {
  const { address, chainId, isConnected } = useAccount();
  const config = useConfig();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();

  const [state, dispatch] = useReducer(reduceJourney, initialJourney);
  const [assets, setAssets] = useState<AssetOption[]>([]);
  const [from, setFrom] = useState("base:usdc");
  const [to, setTo] = useState("base:eth");
  const [amount, setAmount] = useState("1");
  const [recipient, setRecipient] = useState("");
  const [slippage, setSlippage] = useState("0.5");

  const toChain = to.split(":")[0] ?? "";
  const needsRecipient = !EVM_CHAINS.includes(toChain);
  const stations = useMemo(() => journeyStations(state), [state]);
  const now = useNow(state.step === "quoted" || state.step === "preparing");
  const best = bestRoute(state.routes);
  const busy = state.step === "quoting" || state.step === "preparing" || state.step === "signing";
  const hasPending = state.routes.some((route) => route.arkiv.pending);

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
    }, POLL_MS);
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
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [state.step, state.swapId]);

  async function getQuotes(event: React.FormEvent) {
    event.preventDefault();
    if (!address) return;
    dispatch({ type: "quote_requested" });
    const answer = await post("/demo/quote", {
      from: { asset: from, amount, address },
      to: { asset: to, address: needsRecipient ? recipient : address },
      mode: "exact_in",
      slippageBps: Math.round(Number(slippage) * 100),
      refundAddress: address,
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
      if (chainId !== transaction.chainId) await switchChainAsync({ chainId: transaction.chainId as 8453 });
      const hash = await sendTransactionAsync({
        chainId: transaction.chainId as 8453,
        to: transaction.to as `0x${string}`,
        data: transaction.data as `0x${string}`,
        value: BigInt(transaction.value),
      });
      dispatch({ type: "tx_sent", hash });
      // A swap depends on the approval before it, so each must land before the next.
      await waitForTransactionReceipt(config, { hash, chainId: transaction.chainId as 8453 });
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
    if (deposit) return;
    try {
      await signAll(swapId, transactions);
    } catch (error) {
      const rejected = /reject|denied/i.test((error as Error).message);
      dispatch({
        type: "failed",
        message: rejected
          ? "You rejected the transaction in your wallet. Choose a quote to try again."
          : "The transaction did not go through. Check your wallet's balance, then try again.",
      });
    }
  }

  const fromOptions = assets.filter((asset) => asset.chain === "base");
  const toOptions = assets.filter((asset) => asset.id !== from);
  const chosen = state.routes.find((route) => route.quoteId === state.chosenQuoteId);

  return (
    <div className="layout">
      <div className="column-main">
        <h1>Swap across chains. Check the quote afterwards.</h1>
        <p className="lede">
          Every quote goes on a public record before you sign, so you can compare what you were promised with what you
          received.
        </p>

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
            <span>To</span>
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
              onChange={(event) => setSlippage(event.target.value)}
            />
          </label>
          {needsRecipient && (
            <label className="field field-wide">
              <span>{CHAIN_NAMES[toChain]} address that receives the funds</span>
              <input required value={recipient} onChange={(event) => setRecipient(event.target.value)} />
            </label>
          )}
          <button className="gate-action" disabled={busy || !isConnected}>
            {state.step === "quoting" ? "Getting quotes" : isConnected ? "Get quotes" : "Connect a wallet to get quotes"}
          </button>
          <p className="gate-note">
            Swaps run on Base mainnet with your own funds. Crossfare's fee is testnet USDC, and this demo pays it for you.
          </p>
        </form>

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

        {state.routes.length > 0 && state.step !== "finished" && state.step !== "tracking" && (
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

        {state.deposit && (
          <section className="deposit" aria-label="Deposit instructions">
            <h2>Send your deposit</h2>
            <p>
              Send exactly <strong>{state.deposit.amount} {symbolOf(state.deposit.asset)}</strong> to:
            </p>
            <p className="deposit-address">{state.deposit.address}</p>
            {state.deposit.memo && <p>Memo: <span className="deposit-address">{state.deposit.memo}</span></p>}
          </section>
        )}

        {(state.step === "tracking" || state.step === "finished") && chosen && (
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
                state.txHashes.map((hash) => (
                  <a key={hash} href={explorerTxUrl(8453, hash)} target="_blank" rel="noreferrer">
                    {shorten(hash)} on Basescan
                  </a>
                ))}
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}
