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
