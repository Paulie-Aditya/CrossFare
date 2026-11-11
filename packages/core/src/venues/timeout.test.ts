import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withQuoteTimeout } from "./timeout.ts";
import type { QuoteRequest, Venue } from "./types.ts";

const request = { from: { asset: "base:usdc", amount: "1", address: "" }, to: { asset: "base:eth", address: "" }, mode: "exact_in", slippageBps: 50 } as QuoteRequest;

function venue(quote: Venue["quote"]): Venue {
  return { name: "slow", replaces: ["x"], serves: () => true, quote, prepare: vi.fn(), track: vi.fn() };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("withQuoteTimeout", () => {
  it("passes on a quote that answers in time", async () => {
    const limited = withQuoteTimeout(venue(async () => []), 1_000);
    await expect(limited.quote(request)).resolves.toEqual([]);
  });

  it("gives up on a quote that takes too long, as a venue error", async () => {
    const limited = withQuoteTimeout(venue(() => new Promise(() => {})), 1_000);
    const answer = limited.quote(request);
    vi.advanceTimersByTime(1_000);
    await expect(answer).rejects.toMatchObject({ venue: "slow", status: 504 });
  });

  it("keeps everything else about the venue", () => {
    const original = venue(async () => []);
    const limited = withQuoteTimeout(original, 1_000);
    expect(limited).toMatchObject({ name: "slow", replaces: ["x"], prepare: original.prepare, track: original.track });
    expect(limited.serves).toBe(original.serves);
  });
});
