import { useEffect, useState } from "react";
import { get } from "./api.ts";
import { arkivEntityUrl, formatAmount, shorten } from "./journey.ts";

interface RecordRow {
  entityKey: string;
  quoteId: string;
  venue: string;
  fromAsset: string;
  toAsset: string;
  status: string;
  createdAt?: number;
  amountReceived?: string;
  payload?: { minAmountOut?: string; provider?: string };
}

const label = (id: string) => id.replace(":", " ").toUpperCase();

export function QuoteRecord() {
  const [rows, setRows] = useState<RecordRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get("/v1/quotes").then((answer) => {
      if (answer.ok) setRows(answer.body.quotes);
      else setError("Arkiv did not answer, so the record can't load right now. Reload to try again.");
    });
  }, []);

  return (
    <div className="record">
      <header className="intro">
        <h1>Every quote, on the record.</h1>
        <p>
          These rows come straight from Arkiv, written by Crossfare's own wallet. Quotes disappear shortly after they
          expire. Completed swaps stay for 7 days, with the amount received beside the amount quoted.
        </p>
      </header>
      {error && <p className="message message-error glass" role="alert">{error}</p>}
      {!error && rows === null && <p className="record-empty">Reading from Arkiv</p>}
      {rows?.length === 0 && <p className="record-empty">No live quotes right now. Get a quote on the Swap page and it appears here.</p>}
      {rows && rows.length > 0 && (
        <div className="record-panel glass">
          <table>
            <thead>
              <tr>
                <th scope="col">Pair</th>
                <th scope="col">Venue</th>
                <th scope="col" className="numeric">Quoted minimum</th>
                <th scope="col" className="numeric">Received</th>
                <th scope="col">Status</th>
                <th scope="col">Record</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.entityKey}>
                  <td>{label(row.fromAsset)} to {label(row.toAsset)}</td>
                  <td>{row.venue}{row.payload?.provider ? `, ${row.payload.provider.replaceAll("_", " ")}` : ""}</td>
                  <td className="numeric">{row.payload?.minAmountOut ? formatAmount(row.payload.minAmountOut) : "Not recorded"}</td>
                  <td className="numeric">{row.amountReceived ? formatAmount(row.amountReceived) : "Not yet"}</td>
                  <td><span className={`status status-${row.status}`}>{row.status}</span></td>
                  <td><a href={arkivEntityUrl(row.entityKey)} target="_blank" rel="noreferrer">{shorten(row.entityKey)}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
