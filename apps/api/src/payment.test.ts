import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPaymentGuard, type AuditLog, type PaymentGateway } from "./payment.ts";
import { createStore, type Store } from "./store.ts";

const ENDPOINT = { key: "POST /v1/quote", priceUsd: "0.01", description: "Swap quotes" };
const URL_ = "https://crossfare.test/v1/quote";

let store: Store;
let gateway: { [K in keyof PaymentGateway]: ReturnType<typeof vi.fn> };
let audit: { log: ReturnType<typeof vi.fn> };
let events: string[];

beforeEach(() => {
  store = createStore(":memory:");
  events = [];
  gateway = {
    paymentRequired: vi.fn(async () => ({ body: { x402Version: 2, accepts: [] }, headers: { "PAYMENT-REQUIRED": "enc" } })),
    verify: vi.fn(async () => {
      events.push("verify");
      return { valid: true, payer: "0.0.51234" };
    }),
    settle: vi.fn(async () => {
      events.push("settle");
      return { success: true, transactionId: "0.0.1@1.1", payer: "0.0.51234" };
    }),
  };
  audit = { log: vi.fn(async () => {}) };
});

function guard() {
  return createPaymentGuard({
    gateway: gateway as unknown as PaymentGateway,
    store,
    audit: audit as unknown as AuditLog,
    onError: () => {},
  });
}

const okHandler = async () => {
  events.push("handler");
  return { status: 200, body: { requestId: "r_1" }, usedBy: "r_1" };
};

describe("payment guard", () => {
  it("answers 402 with requirements when no payment is attached", async () => {
    const result = await guard().run({ endpoint: ENDPOINT, url: URL_, header: undefined }, okHandler);
    expect(result.status).toBe(402);
    expect(result.headers).toEqual({ "PAYMENT-REQUIRED": "enc" });
    expect(events).toEqual([]);
  });

  it("verifies before the handler and settles after it", async () => {
    await guard().run({ endpoint: ENDPOINT, url: URL_, header: "pay" }, okHandler);
    expect(events).toEqual(["verify", "handler", "settle"]);
  });

  it("adds the settled transaction to the response", async () => {
    const result = await guard().run({ endpoint: ENDPOINT, url: URL_, header: "pay" }, okHandler);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      requestId: "r_1",
      payment: { network: "hedera:testnet", transactionId: "0.0.1@1.1" },
    });
  });

  it("passes the verified payer to the handler", async () => {
    const handler = vi.fn(okHandler);
    await guard().run({ endpoint: ENDPOINT, url: URL_, header: "pay" }, handler);
    expect(handler).toHaveBeenCalledWith("0.0.51234");
  });

  it("does not run the handler when verification fails", async () => {
    gateway.verify!.mockResolvedValue({ valid: false, reason: "bad signature" });
    const result = await guard().run({ endpoint: ENDPOINT, url: URL_, header: "pay" }, okHandler);
    expect(result.status).toBe(402);
    expect(events).toEqual([]);
    expect(gateway.settle).not.toHaveBeenCalled();
  });

  it("frees the claim when verification fails, so a corrected retry isn't blocked", async () => {
    gateway.verify!.mockResolvedValueOnce({ valid: false, reason: "not yet" });
    await guard().run({ endpoint: ENDPOINT, url: URL_, header: "pay" }, okHandler);
    const retry = await guard().run({ endpoint: ENDPOINT, url: URL_, header: "pay" }, okHandler);
    expect(retry.status).toBe(200);
  });

  it.each([409, 422, 502])("does not settle when the handler answers %i", async (status) => {
    const result = await guard().run({ endpoint: ENDPOINT, url: URL_, header: "pay" }, async () => ({
      status,
      body: { error: "nope" },
    }));
    expect(result.status).toBe(status);
    expect(result.body).toEqual({ error: "nope" });
    expect(gateway.settle).not.toHaveBeenCalled();
  });

  it("lets the same payment be reused after an unsettled failure", async () => {
    await guard().run({ endpoint: ENDPOINT, url: URL_, header: "pay" }, async () => ({ status: 502, body: {} }));
    const retry = await guard().run({ endpoint: ENDPOINT, url: URL_, header: "pay" }, okHandler);
    expect(retry.status).toBe(200);
  });

  it("does not settle when the handler throws, and frees the claim", async () => {
    const result = await guard().run({ endpoint: ENDPOINT, url: URL_, header: "pay" }, async () => {
      throw new Error("venue exploded");
    });
    expect(result.status).toBe(502);
    expect(JSON.stringify(result.body)).not.toContain("exploded");
    expect(gateway.settle).not.toHaveBeenCalled();
    const retry = await guard().run({ endpoint: ENDPOINT, url: URL_, header: "pay" }, okHandler);
    expect(retry.status).toBe(200);
  });

  it("rejects a payment that was already spent", async () => {
    await guard().run({ endpoint: ENDPOINT, url: URL_, header: "pay" }, okHandler);
    const replay = await guard().run({ endpoint: ENDPOINT, url: URL_, header: "pay" }, okHandler);
    expect(replay.status).toBe(402);
    expect(replay.body).toMatchObject({ error: "payment_already_used" });
    expect(gateway.settle).toHaveBeenCalledTimes(1);
  });

  it("rejects a concurrent replay while the first request is in flight", async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const first = guard().run({ endpoint: ENDPOINT, url: URL_, header: "pay" }, async () => {
      await slow;
      return okHandler();
    });
    await vi.waitFor(() => expect(gateway.verify).toHaveBeenCalled());
    const second = await guard().run({ endpoint: ENDPOINT, url: URL_, header: "pay" }, okHandler);
    expect(second.status).toBe(402);
    release();
    expect((await first).status).toBe(200);
  });

  it("withholds the response when settlement fails", async () => {
    gateway.settle!.mockResolvedValue({ success: false, reason: "transaction_failed" });
    const result = await guard().run({ endpoint: ENDPOINT, url: URL_, header: "pay" }, okHandler);
    expect(result.status).toBe(402);
    expect(result.body).toEqual({ error: "settlement_failed" });
  });

  it("rejects a Hedera transaction that already paid for another request", async () => {
    await guard().run({ endpoint: ENDPOINT, url: URL_, header: "first" }, okHandler);
    const result = await guard().run({ endpoint: ENDPOINT, url: URL_, header: "second" }, okHandler);
    expect(result.status).toBe(402);
    expect(result.body).toEqual({ error: "payment_already_used" });
  });

  it("records the payment in the private store and the audit log", async () => {
    await guard().run({ endpoint: ENDPOINT, url: URL_, header: "pay" }, okHandler);
    expect(audit.log).toHaveBeenCalledWith({
      payer: "0.0.51234",
      endpoint: "POST /v1/quote",
      amount: "0.01",
      usedBy: "r_1",
      transactionId: "0.0.1@1.1",
    });
  });

  it("still answers when the audit log fails, because the caller has paid", async () => {
    audit.log.mockRejectedValue(new Error("HCS down"));
    const result = await guard().run({ endpoint: ENDPOINT, url: URL_, header: "pay" }, okHandler);
    expect(result.status).toBe(200);
  });
});
