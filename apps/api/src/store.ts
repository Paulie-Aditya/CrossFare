import { DatabaseSync } from "node:sqlite";
import type { Asset, SwapStatus } from "@crossfare/core";

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
  /** Lets only the caller who got this quote execute it. Never published. */
  swapToken?: string | null;
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
  depositDetails?: DepositDetails;
}

/** What really happened to a deposit, which can differ from the quote. */
export interface DepositDetails {
  amountSent?: string;
  /** What has arrived so far, while it's below the provider's minimum. */
  depositShort?: string;
  refundReason?: string;
  partialRefund?: boolean;
}

export type VipScope = "quote" | "swap";

/** A caller that skips x402. Only the key's SHA-256 is stored. */
export interface VipKeyRecord {
  id: string;
  /** Public: it becomes the payer on Arkiv, as vip:<label>. */
  label: string;
  keyHash: string;
  scopes: VipScope[];
  /** Null means no limit. */
  ratePerMinute: number | null;
  /** Metered calls per calendar month (UTC). Null means no limit. */
  monthlyQuota: number | null;
  createdAt: string;
  revokedAt?: string | null;
}

export interface VipUsage {
  keyId: string;
  endpoint: string;
  usedBy: string;
  at: string;
}

export interface VipUsageLine {
  keyId: string;
  label: string;
  endpoint: string;
  calls: number;
}

export type SwapUpdate = Partial<Pick<StoredSwap, "status" | "txHashes" | "amountReceived" | "depositDetails">>;

export interface Store {
  /** Returns false when this payment was already claimed: the replay check. */
  claimPayment(fingerprint: string, endpoint: string): boolean;
  /** Frees an unsettled claim after a failed request, so the caller isn't charged. */
  releasePayment(fingerprint: string): void;
  settlePayment(fingerprint: string, payment: SettledPayment): void;
  saveQuote(quote: StoredQuote): void;
  getQuote(id: string): StoredQuote | null;
  setQuoteEntityKey(id: string, entityKey: string): void;
  setQuoteRoute(id: string, route: unknown): void;
  countQuotes(requestId: string): number;
  saveSwap(swap: StoredSwap): void;
  getSwap(id: string): StoredSwap | null;
  getSwapByQuote(quoteId: string): StoredSwap | null;
  updateSwap(id: string, update: SwapUpdate): void;
  saveVipKey(key: VipKeyRecord): void;
  getVipKeyByHash(keyHash: string): VipKeyRecord | null;
  listVipKeys(): VipKeyRecord[];
  /** Returns false when no key has this ID. */
  revokeVipKey(id: string, at: string): boolean;
  recordVipUsage(usage: VipUsage): void;
  countVipUsage(keyId: string, since: string): number;
  /** Calls per key and endpoint from since (inclusive) to until (exclusive). */
  vipUsageSummary(since: string, until: string): VipUsageLine[];
  /** The first save wins, so a stored swap's decimals never change under it. */
  saveUnlistedAsset(asset: Asset): void;
  listUnlistedAssets(): Asset[];
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
    entity_key TEXT,
    swap_token TEXT
  );
  CREATE TABLE IF NOT EXISTS swaps (
    id TEXT PRIMARY KEY,
    quote_id TEXT NOT NULL,
    venue TEXT NOT NULL,
    status TEXT NOT NULL,
    prepared TEXT NOT NULL,
    venue_swap_id TEXT,
    tx_hashes TEXT NOT NULL DEFAULT '[]',
    amount_received TEXT,
    deposit_details TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS vip_keys (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL,
    rate_per_minute INTEGER,
    monthly_quota INTEGER,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE TABLE IF NOT EXISTS vip_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    used_by TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS vip_usage_key_at ON vip_usage (key_id, at);
  CREATE TABLE IF NOT EXISTS unlisted_assets (
    id TEXT PRIMARY KEY,
    asset TEXT NOT NULL
  );
`;

type Row = Record<string, string | null>;

function toSwap(row: Row | undefined): StoredSwap | null {
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
    depositDetails: JSON.parse(row.deposit_details ?? "{}") as DepositDetails,
  };
}

function toVipKey(row: Record<string, string | number | null> | undefined): VipKeyRecord | null {
  if (!row) return null;
  return {
    id: row.id as string,
    label: row.label as string,
    keyHash: row.key_hash as string,
    scopes: JSON.parse(row.scopes as string) as VipScope[],
    ratePerMinute: (row.rate_per_minute as number | null) ?? null,
    monthlyQuota: (row.monthly_quota as number | null) ?? null,
    createdAt: row.created_at as string,
    revokedAt: (row.revoked_at as string | null) ?? null,
  };
}

export function createStore(path: string): Store {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  // A database from before this column keeps its rows.
  const columns = db.prepare("PRAGMA table_info(swaps)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "deposit_details")) {
    db.exec("ALTER TABLE swaps ADD COLUMN deposit_details TEXT NOT NULL DEFAULT '{}'");
  }

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
        `INSERT INTO quotes (id, request_id, route, request, payer, valid_until, entity_key, swap_token)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        quote.id,
        quote.requestId,
        JSON.stringify(quote.route),
        JSON.stringify(quote.request),
        quote.payer,
        quote.validUntil,
        quote.entityKey ?? null,
        quote.swapToken ?? null,
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
        swapToken: row.swap_token ?? null,
      };
    },

    setQuoteEntityKey(id, entityKey) {
      db.prepare("UPDATE quotes SET entity_key = ? WHERE id = ?").run(entityKey, id);
    },

    setQuoteRoute(id, route) {
      db.prepare("UPDATE quotes SET route = ? WHERE id = ?").run(JSON.stringify(route), id);
    },

    countQuotes(requestId) {
      const row = db.prepare("SELECT COUNT(*) AS total FROM quotes WHERE request_id = ?").get(requestId) as {
        total: number;
      };
      return row.total;
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
      return toSwap(db.prepare("SELECT * FROM swaps WHERE id = ?").get(id) as Row | undefined);
    },

    getSwapByQuote(quoteId) {
      return toSwap(db.prepare("SELECT * FROM swaps WHERE quote_id = ?").get(quoteId) as Row | undefined);
    },

    updateSwap(id, update) {
      const current = this.getSwap(id);
      if (!current) throw new Error(`Unknown swap: ${id}`);
      db.prepare("UPDATE swaps SET status = ?, tx_hashes = ?, amount_received = ?, deposit_details = ? WHERE id = ?").run(
        update.status ?? current.status,
        JSON.stringify(update.txHashes ?? current.txHashes ?? []),
        update.amountReceived ?? current.amountReceived ?? null,
        JSON.stringify(update.depositDetails ?? current.depositDetails ?? {}),
        id,
      );
    },

    saveUnlistedAsset(asset) {
      db.prepare("INSERT OR IGNORE INTO unlisted_assets (id, asset) VALUES (?, ?)").run(asset.id, JSON.stringify(asset));
    },

    listUnlistedAssets() {
      return (db.prepare("SELECT asset FROM unlisted_assets").all() as { asset: string }[]).map((row) => JSON.parse(row.asset) as Asset);
    },

    saveVipKey(key) {
      db.prepare(
        `INSERT INTO vip_keys (id, label, key_hash, scopes, rate_per_minute, monthly_quota, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(key.id, key.label, key.keyHash, JSON.stringify(key.scopes), key.ratePerMinute, key.monthlyQuota, key.createdAt, key.revokedAt ?? null);
    },

    getVipKeyByHash(keyHash) {
      return toVipKey(db.prepare("SELECT * FROM vip_keys WHERE key_hash = ?").get(keyHash) as never);
    },

    listVipKeys() {
      return (db.prepare("SELECT * FROM vip_keys ORDER BY created_at").all() as never[]).map((row) => toVipKey(row)!);
    },

    revokeVipKey(id, at) {
      const known = db.prepare("SELECT id FROM vip_keys WHERE id = ?").get(id);
      if (!known) return false;
      db.prepare("UPDATE vip_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(at, id);
      return true;
    },

    recordVipUsage(usage) {
      db.prepare("INSERT INTO vip_usage (key_id, endpoint, used_by, at) VALUES (?, ?, ?, ?)").run(
        usage.keyId,
        usage.endpoint,
        usage.usedBy,
        usage.at,
      );
    },

    countVipUsage(keyId, since) {
      const row = db.prepare("SELECT COUNT(*) AS total FROM vip_usage WHERE key_id = ? AND at >= ?").get(keyId, since) as {
        total: number;
      };
      return row.total;
    },

    vipUsageSummary(since, until) {
      return db
        .prepare(
          `SELECT u.key_id AS keyId, k.label AS label, u.endpoint AS endpoint, COUNT(*) AS calls
           FROM vip_usage u JOIN vip_keys k ON k.id = u.key_id
           WHERE u.at >= ? AND u.at < ?
           GROUP BY u.key_id, u.endpoint
           ORDER BY k.label, u.endpoint`,
        )
        .all(since, until)
        .map((row) => ({ ...(row as unknown as VipUsageLine) }));
    },
  };
}
