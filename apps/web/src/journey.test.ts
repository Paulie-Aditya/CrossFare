import { describe, expect, it } from "vitest";
import {
  arkivEntityUrl,
  bestRoute,
  defaultSlippage,
  errorMessage,
  explorerLinks,
  explorerTxUrl,
  formatCountdown,
  formatDeadline,
  hashscanUrl,
  initialJourney,
  journeyStations,
  reduceJourney,
  routeAction,
  shorten,
  walletMatches,
  type JourneyState,
  type PublicRoute,
} from "./journey.ts";

const route = (quoteId: string, minAmountOut: string) => ({
  quoteId,
  venue: "uniswap",
  amountOut: minAmountOut,
  minAmountOut,
  fees: {},
  etaSeconds: 30,
  validUntil: "2026-11-06T10:01:00.000Z",
  arkiv: { entityKey: `0x${quoteId}`, pending: false },
});

const quoted = reduceJourney(initialJourney, {
  type: "quoted",
  swapToken: "tok",
  requestId: "r_1",
  routes: [route("a", "1"), route("b", "2")],
  quotePayment: "0.0.1@1.1",
});

const stationStates = (state: JourneyState) =>
  Object.fromEntries(journeyStations(state).map((station) => [station.id, station.state]));

describe("reduceJourney", () => {
  it("moves through quoting to quoted", () => {
    const quoting = reduceJourney(initialJourney, { type: "quote_requested" });
    expect(quoting.step).toBe("quoting");
    expect(quoted).toMatchObject({ step: "quoted", quotePayment: "0.0.1@1.1" });
    expect(quoted.routes).toHaveLength(2);
  });

  it("clears an old error on a new request", () => {
    const failed = reduceJourney(initialJourney, { type: "failed", message: "x" });
    expect(reduceJourney(failed, { type: "quote_requested" }).error).toBeNull();
  });

  it("swaps in the fresh quote on a 409 and stays quoted", () => {
    const fresh = route("c", "3");
    const state = reduceJourney(quoted, { type: "quote_replaced", oldQuoteId: "a", fresh, reason: "price_moved" });
    expect(state.step).toBe("quoted");
    expect(state.routes.map((r) => r.quoteId)).toEqual(["c", "b"]);
    expect(state.notice).toMatch(/price moved/i);
  });

  it("tracks signing, sending and status", () => {
    let state = reduceJourney(quoted, { type: "swap_requested", quoteId: "b" });
    expect(state).toMatchObject({ step: "preparing", chosenQuoteId: "b" });
    state = reduceJourney(state, {
      type: "swap_prepared",
      swapId: "s_1",
      swapPayment: "0.0.1@2.2",
      transactions: [{ kind: "swap", chainId: 8453, to: "0x", data: "0x", value: "0x0" }],
    });
    expect(state).toMatchObject({ step: "signing", swapId: "s_1" });
    state = reduceJourney(state, { type: "tx_sent", hash: "0xh" });
    expect(state.txHashes).toEqual(["0xh"]);
    state = reduceJourney(state, { type: "status", status: "exchanging" });
    expect(state).toMatchObject({ step: "tracking", swapStatus: "exchanging" });
    state = reduceJourney(state, { type: "status", status: "completed", amountReceived: "2.1" });
    expect(state).toMatchObject({ step: "finished", amountReceived: "2.1" });
  });

  it("goes back to the quotes when a wallet rejects signing", () => {
    const state = reduceJourney(
      { ...quoted, step: "signing", swapId: "s_1" },
      { type: "failed", message: "You rejected the transaction in your wallet." },
    );
    expect(state.step).toBe("quoted");
    expect(state.error).toMatch(/rejected/);
  });

  it("resets for a new swap", () => {
    expect(reduceJourney(quoted, { type: "reset" })).toEqual(initialJourney);
  });
});

describe("journeyStations", () => {
  it("starts with the first station waiting", () => {
    expect(stationStates(initialJourney)).toMatchObject({ quote: "upcoming", deliver: "upcoming" });
  });

  it("marks the quote stations done once quoted", () => {
    expect(stationStates(quoted)).toMatchObject({ quote: "done", publish: "done", choose: "current", sign: "upcoming" });
  });

  it("shows confirming as current during tracking", () => {
    const state: JourneyState = { ...quoted, step: "tracking", swapStatus: "confirming", swapId: "s" };
    expect(stationStates(state)).toMatchObject({ choose: "done", sign: "done", confirm: "current", deliver: "upcoming" });
  });

  it("completes the line on delivery", () => {
    const state: JourneyState = { ...quoted, step: "finished", swapStatus: "completed", swapId: "s" };
    expect(Object.values(stationStates(state)).every((value) => value === "done")).toBe(true);
  });

  it("marks the final station failed on a refund", () => {
    const state: JourneyState = { ...quoted, step: "finished", swapStatus: "refunded", swapId: "s" };
    expect(stationStates(state).deliver).toBe("failed");
  });
});

describe("helpers", () => {
  it("picks the highest guaranteed output by value, not string order", () => {
    expect(bestRoute([route("a", "9.5"), route("b", "10.25"), route("c", "10.3")])?.quoteId).toBe("c");
    expect(bestRoute([])).toBeNull();
  });

  it("formats a countdown", () => {
    const now = new Date("2026-11-06T10:00:00Z");
    expect(formatCountdown("2026-11-06T10:01:05Z", now)).toBe("1:05");
    expect(formatCountdown("2026-11-06T10:00:09Z", now)).toBe("0:09");
    expect(formatCountdown("2026-11-06T09:00:00Z", now)).toBe("Expired");
  });

  it("builds explorer links", () => {
    expect(hashscanUrl("0.0.1@1.1")).toBe("https://hashscan.io/testnet/transaction/0.0.1@1.1");
    expect(arkivEntityUrl("0xabc")).toBe("https://rabdi.explorer.arkiv.network/entity/0xabc");
    expect(explorerTxUrl("base", "0xh")).toBe("https://basescan.org/tx/0xh");
    expect(explorerTxUrl("eth", "0xh")).toBe("https://etherscan.io/tx/0xh");
    expect(explorerTxUrl("btc", "abc")).toBe("https://mempool.space/tx/abc");
  });

  it("shortens long identifiers only", () => {
    expect(shorten("0x1234567890abcdef1234")).toBe("0x1234…1234");
    expect(shorten("0x12")).toBe("0x12");
  });

  it.each([
    [{ error: "no_route" }, 422, /no route/i],
    [{ error: "demo_limit_reached" }, 429, /limit/i],
    [{ error: "address_flagged" }, 403, /flagged/i],
    [{ error: "venues_unavailable" }, 502, /try again/i],
    [{ error: "invalid receiving address" }, 400, /doesn't fit the chain/],
    [{ error: "insufficient_balance" }, 422, /doesn't hold this amount/],
    [{ error: "brand_new" }, 500, /brand_new/],
  ])("explains %j", (body, status, expected) => {
    expect(errorMessage(body, status)).toMatch(expected);
  });
});

describe("order page", () => {
  const transfer = { kind: "swap" as const, chainId: 1, to: "0xusdc", data: "0x", value: "0x0" };
  const deposit = { asset: "eth:usdc", address: "0xvault", amount: "5", expiresAt: "2026-11-07T10:00:00.000Z" };
  const onOrder = reduceJourney(quoted, {
    type: "swap_prepared",
    swapId: "s_1",
    swapPayment: null,
    transactions: [transfer],
    deposit,
  });

  it("waits for the deposit, keeping the transaction for a wallet that wants to send it", () => {
    expect(onOrder).toMatchObject({ step: "tracking", swapStatus: "awaiting_deposit", deposit, transactions: [transfer] });
  });

  it("goes straight to signing when a route has no deposit address", () => {
    const state = reduceJourney(quoted, { type: "swap_prepared", swapId: "s_1", swapPayment: null, transactions: [transfer] });
    expect(state.step).toBe("signing");
  });

  it("marks the wallet step while a wallet sends the deposit", () => {
    expect(reduceJourney(onOrder, { type: "wallet_send_requested" }).step).toBe("signing");
  });

  it("stays on the order page when the wallet send fails, so the deposit can still be sent", () => {
    const signing = reduceJourney(onOrder, { type: "wallet_send_requested" });
    const state = reduceJourney(signing, { type: "failed", message: "Rejected" });
    expect(state).toMatchObject({ step: "tracking", error: "Rejected", deposit });
  });

  it("doesn't go back to awaiting the deposit once a transaction was sent", () => {
    const sent = reduceJourney(onOrder, { type: "tx_sent", hash: "0xh" });
    expect(reduceJourney(sent, { type: "status", status: "awaiting_deposit" }).swapStatus).toBe("confirming");
  });

  it("names the deposit in the transit line", () => {
    const sign = journeyStations(onOrder).find((station) => station.id === "sign")!;
    expect(sign.name).toBe("Send your deposit");
  });

  it("explains the current stage of a swap under way", () => {
    const confirm = (status: string) =>
      journeyStations({ ...onOrder, swapStatus: status }).find((station) => station.id === "confirm")!;
    expect(confirm("exchanging").detail).toMatch(/exchang/i);
    expect(confirm("confirming").detail).toMatch(/confirm|track/i);
  });
});

describe("form helpers", () => {
  const stub = (depositable: boolean) => ({ depositable }) as PublicRoute;

  it("offers a deposit when a plain transfer pays for the route", () => {
    expect(routeAction(stub(true), false)).toBe("deposit");
    expect(routeAction(stub(true), true)).toBe("deposit");
  });

  it("needs a connected wallet for a route that takes a signature", () => {
    expect(routeAction(stub(false), true)).toBe("wallet");
    expect(routeAction(stub(false), false)).toBe("connect");
  });

  it("uses wider slippage across chains", () => {
    expect(defaultSlippage("eth:usdc", "base:eth")).toBe("3");
    expect(defaultSlippage("base:usdc", "base:eth")).toBe("0.5");
  });

  it("compares wallet addresses without regard to case", () => {
    expect(walletMatches("0xABC", "0xabc")).toBe(true);
    expect(walletMatches("0xABC", "0xdef")).toBe(false);
    expect(walletMatches(undefined, "0xabc")).toBe(false);
  });

  it("shows a long deadline in hours and a short one on a clock", () => {
    const now = new Date("2026-11-06T10:00:00Z");
    expect(formatDeadline("2026-11-07T09:59:00Z", now)).toBe("23h 59m");
    expect(formatDeadline("2026-11-06T10:04:09Z", now)).toBe("4:09");
    expect(formatDeadline("2026-11-06T09:00:00Z", now)).toBe("Expired");
  });

  it("links the first hash to the source chain and later ones to the destination", () => {
    expect(explorerLinks(["0xa", "0xb"], "eth:usdc", "base:eth")).toEqual([
      { hash: "0xa", label: "Etherscan", url: "https://etherscan.io/tx/0xa" },
      { hash: "0xb", label: "Basescan", url: "https://basescan.org/tx/0xb" },
    ]);
  });
});

describe("swap token and route changes", () => {
  it("keeps the token from the quote response for the swap call", () => {
    const state = reduceJourney(initialJourney, { type: "quoted", requestId: "r_1", swapToken: "tok", routes: [], quotePayment: "t" });
    expect(state.swapToken).toBe("tok");
  });

  it("explains a provider change without suggesting a charge", () => {
    const fresh = { quoteId: "q_2" } as PublicRoute;
    const state = reduceJourney(initialJourney, { type: "quote_replaced", oldQuoteId: "q_1", fresh, reason: "route_changed" });
    expect(state.notice).toMatch(/no longer available.*not charged/);
  });
});

describe("late Arkiv keys", () => {
  it("fills in keys for routes that were pending", () => {
    const pending = { ...route("a", "1"), arkiv: { entityKey: null, pending: true } };
    const state = reduceJourney({ ...initialJourney, step: "quoted", routes: [pending, route("b", "2")] }, {
      type: "arkiv_keys",
      keys: { a: "0xlate" },
    });
    expect(state.routes[0]?.arkiv).toEqual({ entityKey: "0xlate", pending: false });
    expect(state.routes[1]?.arkiv.entityKey).toBe("0xb");
  });
});
