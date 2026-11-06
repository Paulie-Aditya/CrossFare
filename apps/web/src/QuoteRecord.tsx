import { useEffect, useState } from "react";
import { get } from "./api.ts";
import { arkivEntityUrl, explorerLinks, formatAmount, formatUsd, shorten, statusLabel } from "./journey.ts";
import { CHAIN_NAMES, Coin } from "./ui.tsx";

interface RecordRow {
  entityKey: string;
  quoteId: string;
  venue: string;
  fromAsset: string;
  toAsset: string;
  status: string;
  summary?: string;
  createdAt?: number;
  amountReceived?: string;
  txHashes?: string[];
  payload?: { amountOut?: string; minAmountOut?: string; provider?: string; usd?: { in: number; out: number } };
}

const assetName = (id: string) => `${id.split(":")[1]?.toUpperCase() ?? id} on ${CHAIN_NAMES[id.split(":")[0] ?? ""] ?? ""}`;
const symbolOf = (id: string) => id.split(":")[1]?.toUpperCase() ?? id;
const isSwap = (row: RecordRow) => !["quoted", "expired"].includes(row.status.toLowerCase());
const whenText = (seconds?: number) =>
  seconds
    ? new Date(seconds * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true })
    : "";
const venueName = (row: RecordRow) => {
  const provider = row.payload?.provider?.replaceAll("_", " ").toUpperCase();
  if (row.venue === "uniswap") return "Uniswap";
  return provider ? `SwapKit via ${provider}` : "SwapKit";
};

function HistoryRow({ row }: { row: RecordRow }) {
  const out = row.amountReceived ?? row.payload?.amountOut;
  const links = explorerLinks(row.txHashes ?? [], row.fromAsset, row.toAsset);
  const usd = row.payload?.usd;
  const value = out && usd && row.payload?.amountOut ? (usd.out / Number(row.payload.amountOut)) * Number(out) : undefined;
  const key = row.status.toLowerCase().replace(/\s+/g, "-");
  return (
    <li className="history-row">
      <span className="history-coins" aria-hidden="true">
        <Coin asset={row.fromAsset} size={30} />
        <Coin asset={row.toAsset} size={30} />
      </span>
      <div className="history-main">
        <p className="history-title">{row.summary ?? `${assetName(row.fromAsset)} to ${assetName(row.toAsset)}`}</p>
        <p className="history-meta">
          <span>{whenText(row.createdAt)}</span>
          <span>{venueName(row)}</span>
        </p>
        <p className="history-links">
          <a href={arkivEntityUrl(row.entityKey)} target="_blank" rel="noreferrer">
            Record {shorten(row.entityKey)}
          </a>
          {links.map((link) => (
            <a key={link.hash} href={link.url} target="_blank" rel="noreferrer">
              {link.kind === "deposit" ? "Deposit" : "Delivery"} on {link.label}
            </a>
          ))}
        </p>
      </div>
      <div className="history-side">
        <span className={`status status-${key}`}>{statusLabel(row.status)}</span>
        {out && (
          <p className="history-amount">
            {row.amountReceived ? "+" : "~"}
            {formatAmount(out)} {symbolOf(row.toAsset)}
          </p>
        )}
        {value !== undefined && <p className="history-usd">{formatUsd(value)}</p>}
      </div>
    </li>
  );
}

export function QuoteRecord() {
  const [rows, setRows] = useState<RecordRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"swaps" | "all">("swaps");

  useEffect(() => {
    get("/v1/quotes").then((answer) => {
      if (answer.ok) setRows(answer.body.quotes);
      else setError("Arkiv did not answer, so your history can't load right now. Reload to try again.");
    });
  }, []);

  const swaps = rows?.filter(isSwap) ?? [];
  const shown = view === "swaps" ? swaps : (rows ?? []);

  return (
    <div className="record">
      <header className="intro">
        <h1>Swap history, on the record.</h1>
        <p>
          Every line comes straight from Arkiv, written by Crossfare's own wallet. Finished swaps stay for 7 days, with the
          amount received beside the amount quoted. Unused quotes disappear shortly after they expire.
        </p>
      </header>
      {error && <p className="message message-error glass" role="alert">{error}</p>}
      {!error && rows === null && <p className="record-empty">Reading from Arkiv</p>}
      {rows && (
        <div className="record-panel glass">
          <div className="segments" role="group" aria-label="What to show">
            <button aria-pressed={view === "swaps"} onClick={() => setView("swaps")}>Swaps</button>
            <button aria-pressed={view === "all"} onClick={() => setView("all")}>All quotes</button>
          </div>
          {shown.length === 0 ? (
            <p className="record-empty">
              {view === "swaps" ? "No swaps in the last 7 days. Finished swaps appear here." : "No live quotes right now. Get a quote on the Swap page and it appears here."}
            </p>
          ) : (
            <ul className="history">
              {shown.map((row) => (
                <HistoryRow key={row.entityKey} row={row} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
