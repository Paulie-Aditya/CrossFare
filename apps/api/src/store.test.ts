import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { createStore, type Store } from "./store.ts";

let store: Store;
beforeEach(() => {
  store = createStore(":memory:");
});

describe("payment claims", () => {
  it("lets a payment be claimed once", () => {
    expect(store.claimPayment("hash-1", "POST /v1/quote")).toBe(true);
    expect(store.claimPayment("hash-1", "POST /v1/quote")).toBe(false);
  });

  it("frees a claim when released", () => {
    store.claimPayment("hash-1", "POST /v1/quote");
    store.releasePayment("hash-1");
    expect(store.claimPayment("hash-1", "POST /v1/quote")).toBe(true);
  });

  it("never releases a settled payment", () => {
    store.claimPayment("hash-1", "POST /v1/quote");
    store.settlePayment("hash-1", { transactionId: "0.0.1@1.1", payer: "0.0.2", amount: "0.01", usedBy: "r_1" });
    store.releasePayment("hash-1");
    expect(store.claimPayment("hash-1", "POST /v1/quote")).toBe(false);
  });

  it("rejects the same Hedera transaction ID on a second payment", () => {
    store.claimPayment("hash-1", "POST /v1/quote");
    store.settlePayment("hash-1", { transactionId: "0.0.1@1.1", payer: "0.0.2", amount: "0.01", usedBy: "r_1" });
    store.claimPayment("hash-2", "POST /v1/quote");
    expect(() =>
      store.settlePayment("hash-2", { transactionId: "0.0.1@1.1", payer: "0.0.2", amount: "0.01", usedBy: "r_2" }),
    ).toThrow();
  });
});

describe("quotes", () => {
  const quote = {
    id: "q_1",
    requestId: "r_1",
    route: { venue: "uniswap" },
    request: { slippageBps: 50 },
    payer: "0.0.2",
    validUntil: "2026-11-07T00:00:00.000Z",
  };

  it("round-trips a quote and its JSON fields", () => {
    store.saveQuote(quote);
    expect(store.getQuote("q_1")).toMatchObject({ ...quote, entityKey: null });
  });

  it("returns null for an unknown quote", () => {
    expect(store.getQuote("nope")).toBeNull();
  });

  it("records the Arkiv entity key once known", () => {
    store.saveQuote(quote);
    store.setQuoteEntityKey("q_1", "0xabc");
    expect(store.getQuote("q_1")?.entityKey).toBe("0xabc");
  });
});

describe("swaps", () => {
  const swap = {
    id: "s_1",
    quoteId: "q_1",
    venue: "uniswap",
    status: "awaiting_deposit" as const,
    prepared: { transactions: [] },
  };

  it("round-trips a swap", () => {
    store.saveSwap(swap);
    expect(store.getSwap("s_1")).toMatchObject({ ...swap, txHashes: [], amountReceived: null });
  });

  it("applies partial updates", () => {
    store.saveSwap(swap);
    store.updateSwap("s_1", { status: "completed", txHashes: ["0x1"], amountReceived: "42" });
    expect(store.getSwap("s_1")).toMatchObject({
      status: "completed",
      txHashes: ["0x1"],
      amountReceived: "42",
    });
  });

  it("returns null for an unknown swap", () => {
    expect(store.getSwap("nope")).toBeNull();
  });
});

describe("a database from before deposit details", () => {
  it("gains the new column and keeps its swaps", () => {
    const path = join(mkdtempSync(join(tmpdir(), "crossfare-")), "old.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE swaps (id TEXT PRIMARY KEY, quote_id TEXT NOT NULL, venue TEXT NOT NULL, status TEXT NOT NULL, prepared TEXT NOT NULL, venue_swap_id TEXT, tx_hashes TEXT NOT NULL DEFAULT '[]', amount_received TEXT)`);
    old.prepare("INSERT INTO swaps (id, quote_id, venue, status, prepared) VALUES ('s1', 'q1', 'swapkit', 'completed', '{}')").run();
    old.close();
    const store = createStore(path);
    expect(store.getSwap("s1")).toMatchObject({ id: "s1", status: "completed", depositDetails: {} });
    store.updateSwap("s1", { depositDetails: { amountSent: "4.9" } });
    expect(store.getSwap("s1")?.depositDetails).toEqual({ amountSent: "4.9" });
    expect(createStore(path).getSwap("s1")?.depositDetails).toEqual({ amountSent: "4.9" });
  });
});


describe("VIP keys", () => {
  const key = {
    id: "vk_1",
    label: "partner",
    keyHash: "a".repeat(64),
    scopes: ["quote", "swap"] as const,
    ratePerMinute: 60,
    monthlyQuota: null,
    createdAt: "2026-11-08T00:00:00.000Z",
  };

  it("finds a key by its hash and never stores the key itself", () => {
    store.saveVipKey({ ...key, scopes: [...key.scopes] });
    expect(store.getVipKeyByHash("a".repeat(64))).toEqual({ ...key, scopes: ["quote", "swap"], revokedAt: null });
    expect(store.getVipKeyByHash("b".repeat(64))).toBeNull();
  });

  it("revokes a key by ID and lists it as revoked", () => {
    store.saveVipKey({ ...key, scopes: [...key.scopes] });
    expect(store.revokeVipKey("vk_1", "2026-11-09T00:00:00.000Z")).toBe(true);
    expect(store.revokeVipKey("vk_missing", "2026-11-09T00:00:00.000Z")).toBe(false);
    expect(store.getVipKeyByHash("a".repeat(64))?.revokedAt).toBe("2026-11-09T00:00:00.000Z");
    expect(store.listVipKeys()).toHaveLength(1);
  });

  it("counts a key's metered calls since a date, and sums usage per label", () => {
    store.saveVipKey({ ...key, scopes: [...key.scopes] });
    store.recordVipUsage({ keyId: "vk_1", endpoint: "POST /v1/quote", usedBy: "r_1", at: "2026-10-31T23:59:00.000Z" });
    store.recordVipUsage({ keyId: "vk_1", endpoint: "POST /v1/quote", usedBy: "r_2", at: "2026-11-01T00:00:00.000Z" });
    store.recordVipUsage({ keyId: "vk_1", endpoint: "POST /v1/swap", usedBy: "s_1", at: "2026-11-02T00:00:00.000Z" });
    expect(store.countVipUsage("vk_1", "2026-11-01T00:00:00.000Z")).toBe(2);
    expect(store.vipUsageSummary("2026-11-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z")).toEqual([
      { keyId: "vk_1", label: "partner", endpoint: "POST /v1/quote", calls: 1 },
      { keyId: "vk_1", label: "partner", endpoint: "POST /v1/swap", calls: 1 },
    ]);
  });
});

describe("unlisted tokens", () => {
  const token = {
    id: "base:pasted-0x9999999999999999999999999999999999999999",
    chain: "base",
    symbol: "PASTED",
    decimals: 18,
    evmChainId: 8453,
    uniswap: { chainId: 8453, address: "0x9999999999999999999999999999999999999999" },
    swapkitChain: "8453",
    unlisted: true as const,
  };

  it("are kept so stored swaps that name them still resolve after a restart", () => {
    const path = join(mkdtempSync(join(tmpdir(), "crossfare-")), "store.db");
    createStore(path).saveUnlistedAsset(token);
    expect(createStore(path).listUnlistedAssets()).toEqual([token]);
  });

  it("are saved once, however often they're looked up", () => {
    const store = createStore(":memory:");
    store.saveUnlistedAsset(token);
    store.saveUnlistedAsset({ ...token, symbol: "CHANGED" });
    expect(store.listUnlistedAssets()).toEqual([token]);
  });
});
