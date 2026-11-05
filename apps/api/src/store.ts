import { DatabaseSync } from "node:sqlite";
import type { SwapStatus } from "@crossfare/core";

export interface SettledPayment {
  transactionId: string;
  payer: string;
  amount: string;
  usedBy: string;
}

export interface StoredQuote {
  id: string;
  requestId: string;
  route: unknown;
  request: unknown;
  payer: string;
  validUntil: string;
  entityKey?: string | null;
}

export interface StoredSwap {
  id: string;
  quoteId: string;
  venue: string;
  status: SwapStatus;
  prepared: unknown;
  venueSwapId?: string | null;
  txHashes?: string[];
  amountReceived?: string | null;
}

export type SwapUpdate = Partial<Pick<StoredSwap, "status" | "txHashes" | "amountReceived">>;

export interface Store {
  /** Returns false when this payment was already claimed: the replay check. */
  claimPayment(fingerprint: string, endpoint: string): boolean;
  /** Frees an unsettled claim after a failed request, so the caller isn't charged. */
  releasePayment(fingerprint: string): void;
  settlePayment(fingerprint: string, payment: SettledPayment): void;
  saveQuote(quote: StoredQuote): void;
  getQuote(id: string): StoredQuote | null;
  setQuoteEntityKey(id: string, entityKey: string): void;
  saveSwap(swap: StoredSwap): void;
  getSwap(id: string): StoredSwap | null;
  updateSwap(id: string, update: SwapUpdate): void;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS payments (
    fingerprint TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL,
    transaction_id TEXT UNIQUE,
    payer TEXT,
    amount TEXT,
    used_by TEXT,
    settled_at TEXT
  );
  CREATE TABLE IF NOT EXISTS quotes (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    route TEXT NOT NULL,
    request TEXT NOT NULL,
    payer TEXT NOT NULL,
    valid_until TEXT NOT NULL,
    entity_key TEXT
  );
  CREATE TABLE IF NOT EXISTS swaps (
    id TEXT PRIMARY KEY,
    quote_id TEXT NOT NULL,
    venue TEXT NOT NULL,
    status TEXT NOT NULL,
    prepared TEXT NOT NULL,
    venue_swap_id TEXT,
    tx_hashes TEXT NOT NULL DEFAULT '[]',
    amount_received TEXT
  );
`;

type Row = Record<string, string | null>;

export function createStore(path: string): Store {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);

  return {
    claimPayment(fingerprint, endpoint) {
      const result = db
        .prepare("INSERT OR IGNORE INTO payments (fingerprint, endpoint) VALUES (?, ?)")
        .run(fingerprint, endpoint);
      return result.changes === 1;
    },

    releasePayment(fingerprint) {
      db.prepare("DELETE FROM payments WHERE fingerprint = ? AND settled_at IS NULL").run(fingerprint);
    },

    settlePayment(fingerprint, payment) {
      db.prepare(
        `UPDATE payments
         SET transaction_id = ?, payer = ?, amount = ?, used_by = ?, settled_at = ?
         WHERE fingerprint = ?`,
      ).run(
        payment.transactionId,
        payment.payer,
        payment.amount,
        payment.usedBy,
        new Date().toISOString(),
        fingerprint,
      );
    },

    saveQuote(quote) {
      db.prepare(
        `INSERT INTO quotes (id, request_id, route, request, payer, valid_until, entity_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        quote.id,
        quote.requestId,
        JSON.stringify(quote.route),
        JSON.stringify(quote.request),
        quote.payer,
        quote.validUntil,
        quote.entityKey ?? null,
      );
    },

    getQuote(id) {
      const row = db.prepare("SELECT * FROM quotes WHERE id = ?").get(id) as Row | undefined;
      if (!row) return null;
      return {
        id: row.id!,
        requestId: row.request_id!,
        route: JSON.parse(row.route!),
        request: JSON.parse(row.request!),
        payer: row.payer!,
        validUntil: row.valid_until!,
        entityKey: row.entity_key ?? null,
      };
    },

    setQuoteEntityKey(id, entityKey) {
      db.prepare("UPDATE quotes SET entity_key = ? WHERE id = ?").run(entityKey, id);
    },

    saveSwap(swap) {
      db.prepare(
        `INSERT INTO swaps (id, quote_id, venue, status, prepared, venue_swap_id, tx_hashes, amount_received)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        swap.id,
        swap.quoteId,
        swap.venue,
        swap.status,
        JSON.stringify(swap.prepared),
        swap.venueSwapId ?? null,
        JSON.stringify(swap.txHashes ?? []),
        swap.amountReceived ?? null,
      );
    },

    getSwap(id) {
      const row = db.prepare("SELECT * FROM swaps WHERE id = ?").get(id) as Row | undefined;
      if (!row) return null;
      return {
        id: row.id!,
        quoteId: row.quote_id!,
        venue: row.venue!,
        status: row.status as SwapStatus,
        prepared: JSON.parse(row.prepared!),
        venueSwapId: row.venue_swap_id ?? null,
        txHashes: JSON.parse(row.tx_hashes!) as string[],
        amountReceived: row.amount_received ?? null,
      };
    },

    updateSwap(id, update) {
      const current = this.getSwap(id);
      if (!current) throw new Error(`Unknown swap: ${id}`);
      db.prepare("UPDATE swaps SET status = ?, tx_hashes = ?, amount_received = ? WHERE id = ?").run(
        update.status ?? current.status,
        JSON.stringify(update.txHashes ?? current.txHashes ?? []),
        update.amountReceived ?? current.amountReceived ?? null,
        id,
      );
    },
  };
}
