import { describe, expect, it, vi } from "vitest";
import { createArkivPublisher, type ArkivClients } from "./arkiv-publisher.ts";
import type { PublicQuote } from "./publisher.ts";

const NOW = new Date("2026-11-06T10:00:00.000Z");
const WRITER = "0x00000000000000000000000000000000000000aa";

const quote: PublicQuote = {
  quoteId: "q_1",
  requestId: "r_1",
  venue: "uniswap",
  fromAsset: "base:usdc",
  toAsset: "base:eth",
  payer: "0.0.51234",
  status: "quoted",
  createdAt: Math.floor(NOW.getTime() / 1000),
  validUntil: Math.floor(NOW.getTime() / 1000) + 60,
  payload: { quoteId: "q_1", minAmountOut: "0.002" },
};

function clients(overrides: Partial<ArkivClients> = {}) {
  const fetchRows = vi.fn(async () => [{ quoteId: "q_1" }]);
  const base: ArkivClients = {
    create: vi.fn(async () => "0xkey"),
    patch: vi.fn(async () => {}),
    extend: vi.fn(async () => {}),
    queryByPayer: fetchRows,
    queryRecent: vi.fn(async () => [{ quoteId: "q_recent" }]),
    ...overrides,
  };
  return base as ArkivClients & { [K in keyof ArkivClients]: ReturnType<typeof vi.fn> };
}

const publisher = (c: ArkivClients) => createArkivPublisher({ clients: c, now: () => NOW, writer: WRITER });

describe("arkiv publisher", () => {
  it("writes every PRD attribute and scopes it to the project", async () => {
    const c = clients();
    await publisher(c).publishQuote(quote);
    const [attributes] = c.create.mock.calls[0]!;
    expect(attributes).toMatchObject({
      project: "crossfare",
      type: "quote",
      quoteId: "q_1",
      requestId: "r_1",
      venue: "uniswap",
      fromAsset: "base:usdc",
      toAsset: "base:eth",
      payer: "0.0.51234",
      status: "quoted",
    });
    expect(attributes.createdAt).toBe(BigInt(quote.createdAt));
    expect(attributes.validUntil).toBe(BigInt(quote.validUntil));
    expect(JSON.parse(new TextDecoder().decode(attributes.payload))).toEqual(quote.payload);
  });

  it("expires 120 seconds after the quote's validity", async () => {
    const c = clients();
    await publisher(c).publishQuote(quote);
    expect(c.create.mock.calls[0]![1]).toBe(60 + 120);
  });

  it("returns the entity key", async () => {
    expect(await publisher(clients()).publishQuote(quote)).toBe("0xkey");
  });

  it("sends writes one at a time so the wallet's nonces don't collide", async () => {
    let active = 0;
    let peak = 0;
    const c = clients({
      create: vi.fn(async () => {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return "0xkey";
      }),
    });
    const p = publisher(c);
    await Promise.all([p.publishQuote(quote), p.publishQuote(quote), p.publishQuote(quote)]);
    expect(peak).toBe(1);
  });

  it("keeps writing after a failed write", async () => {
    const c = clients();
    c.create.mockRejectedValueOnce(new Error("nonce"));
    const p = publisher(c);
    await expect(p.publishQuote(quote)).rejects.toThrow("nonce");
    await expect(p.publishQuote(quote)).resolves.toBe("0xkey");
  });

  it("records status and outcome, then extends a completed swap to 7 days", async () => {
    const c = clients();
    await publisher(c).updateQuote("0xkey", { status: "completed", amountReceived: "0.5", txHashes: ["0x1", "0x2"] });
    expect(c.patch).toHaveBeenCalledWith("0xkey", {
      status: "completed",
      amountReceived: "0.5",
      txHashes: new TextEncoder().encode("0x1,0x2"),
    });
    expect(c.extend).toHaveBeenCalledWith("0xkey", 7 * 24 * 3600);
  });

  it("does not extend a record that isn't completed", async () => {
    const c = clients();
    await publisher(c).updateQuote("0xkey", { status: "executing" });
    expect(c.patch).toHaveBeenCalledWith("0xkey", { status: "executing" });
    expect(c.extend).not.toHaveBeenCalled();
  });

  it("reads recent quotes from Crossfare's own wallet only", async () => {
    const c = clients();
    expect(await publisher(c).recentQuotes()).toEqual([{ quoteId: "q_recent" }]);
    expect(c.queryRecent).toHaveBeenCalledWith(WRITER);
  });

  it("reads a payer's quotes", async () => {
    const c = clients();
    expect(await publisher(c).quotesByPayer("0.0.51234")).toEqual([{ quoteId: "q_1" }]);
    expect(c.queryByPayer).toHaveBeenCalledWith("0.0.51234", WRITER);
  });

  it.each([0, 1])("always asks for a lifetime Arkiv accepts, a multiple of its 2-second block time (offset %i)", async (offset) => {
    const fake = clients();
    await publisher(fake).publishQuote({ ...quote, validUntil: quote.validUntil + offset });
    const seconds = vi.mocked(fake.create).mock.calls[0]![1];
    expect(seconds % 2).toBe(0);
    expect(seconds).toBeGreaterThanOrEqual(60 + offset + 120);
  });
});
