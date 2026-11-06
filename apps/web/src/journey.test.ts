import { describe, expect, it } from "vitest";
import {
  arkivEntityUrl,
  bestRoute,
  buildQuoteRequest,
  canSignOn,
  defaultSlippage,
  errorMessage,
  explorerLinks,
  explorerAddressUrl,
  explorerTxUrl,
  formatAmount,
  formatCountdown,
  formatRate,
  formatUsd,
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
  statusLabel,
  orderStages,
  unitPrice,
  swapCost,
  formatEta,
  isPriceable,
  bestAdvantage,
  receivedAboveMinimum,
  walletOptions,
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

  it("treats an expired order as finished, so nobody sends to it", () => {
    const state = reduceJourney(onOrder, { type: "status", status: "expired" });
    expect(state).toMatchObject({ step: "finished", swapStatus: "expired" });
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

describe("price display", () => {
  it("shows the rate per unit sold, like a wallet does", () => {
    expect(formatRate("2", "0.000890709113796507", "USDC", "ETH")).toBe("1 USDC = 0.00044535 ETH");
    expect(formatRate("0.01", "22.3", "ETH", "USDC")).toBe("1 ETH = 2,230 USDC");
  });

  it("gives no rate for an empty amount", () => {
    expect(formatRate("0", "1", "USDC", "ETH")).toBeNull();
  });

  it("shows dollars to the cent, and small values clearly", () => {
    expect(formatUsd(1.987)).toBe("$1.99");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(undefined)).toBeNull();
  });

  it("trims long amounts without changing small ones", () => {
    expect(formatAmount("0.000863987840382612")).toBe("0.00086399");
    expect(formatAmount("1.997376")).toBe("1.9974");
    expect(formatAmount("2")).toBe("2");
  });
});

describe("buildQuoteRequest", () => {
  const form = { from: "eth:usdc", to: "base:eth", amount: "2", recipient: " 0xreceiver ", refundAddress: " 0xrefund ", slippage: "3" };

  it("lets the deposit come from anywhere when no wallet is connected", () => {
    expect(buildQuoteRequest(form, undefined)).toEqual({
      from: { asset: "eth:usdc", amount: "2", address: "0xrefund" },
      to: { asset: "base:eth", address: "0xreceiver" },
      mode: "exact_in",
      slippageBps: 300,
      refundAddress: "0xrefund",
      flexibleDeposit: true,
    });
  });

  it("does the same when the connected wallet isn't the refund address", () => {
    expect(buildQuoteRequest(form, "0xother").flexibleDeposit).toBe(true);
  });

  it("keeps the balance check when the connected wallet is the one sending", () => {
    expect(buildQuoteRequest(form, "0xREFUND").flexibleDeposit).toBeUndefined();
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

  it("skips a route's middle hash, which may be on neither chain", () => {
    const links = explorerLinks(["0xa", "Ae9aaNiP", "0xb"], "eth:usdc", "base:usdc");
    expect(links.map((link) => link.hash)).toEqual(["0xa", "0xb"]);
    expect(links.map((link) => link.label)).toEqual(["Etherscan", "Basescan"]);
  });

  it("links the first hash to the source chain and later ones to the destination", () => {
    expect(explorerLinks(["0xa", "0xb"], "eth:usdc", "base:eth")).toEqual([
      { hash: "0xa", kind: "deposit", label: "Etherscan", url: "https://etherscan.io/tx/0xa" },
      { hash: "0xb", kind: "delivery", label: "Basescan", url: "https://basescan.org/tx/0xb" },
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

describe("statusLabel", () => {
  it.each([
    ["completed", "Completed"],
    ["Completed", "Completed"],
    ["awaiting_deposit", "Awaiting deposit"],
    ["confirming", "Confirming"],
    ["exchanging", "Swapping"],
    ["executing", "In progress"],
    ["In progress", "In progress"],
    ["refunded", "Refunded"],
  ])("reads %s as %s", (status, label) => {
    expect(statusLabel(status)).toBe(label);
  });
});

describe("orderStages", () => {
  const order = (swapStatus: string, deposit = true) =>
    orderStages({
      ...initialJourney,
      step: ["completed", "refunded", "failed", "expired"].includes(swapStatus) ? "finished" : "tracking",
      swapStatus,
      deposit: deposit ? { asset: "eth:usdc", address: "0xd", amount: "5" } : null,
    });
  const states = (stages: ReturnType<typeof orderStages>) => stages.map((stage) => stage.state);

  it("waits on the deposit first", () => {
    expect(states(order("awaiting_deposit"))).toEqual(["current", "upcoming", "upcoming"]);
  });

  it("ticks the deposit as soon as it is seen", () => {
    expect(states(order("confirming"))).toEqual(["done", "current", "upcoming"]);
    expect(states(order("exchanging"))).toEqual(["done", "current", "upcoming"]);
  });

  it("finishes with everything ticked", () => {
    expect(states(order("completed"))).toEqual(["done", "done", "done"]);
  });

  it("marks a refund or failure on the swap stage", () => {
    expect(states(order("refunded"))).toEqual(["done", "failed", "upcoming"]);
    expect(states(order("failed"))).toEqual(["done", "failed", "upcoming"]);
  });

  it("names the first stage for how the funds were sent", () => {
    expect(order("confirming")[0]?.name).toBe("Deposit received");
    expect(order("confirming", false)[0]?.name).toBe("Transaction sent");
  });

  it("doesn't claim a deposit before one arrives", () => {
    expect(order("awaiting_deposit")[0]?.name).toBe("Send deposit");
  });
});

describe("a status that lags", () => {
  it("doesn't move a detected deposit back to awaiting", () => {
    const moving = { ...initialJourney, step: "tracking" as const, swapStatus: "exchanging" };
    expect(reduceJourney(moving, { type: "status", status: "awaiting_deposit" }).swapStatus).toBe("exchanging");
  });
});

describe("form_changed", () => {
  it("drops quotes that no longer match the form", () => {
    const quoted = { ...initialJourney, step: "quoted" as const, routes: [{ quoteId: "q1" } as PublicRoute], swapToken: "t" };
    const changed = reduceJourney(quoted, { type: "form_changed" });
    expect(changed.routes).toEqual([]);
    expect(changed.step).toBe("idle");
    expect(changed.swapToken).toBeNull();
  });

  it("leaves an order in progress alone", () => {
    const tracking = { ...initialJourney, step: "tracking" as const, swapId: "s1" };
    expect(reduceJourney(tracking, { type: "form_changed" })).toBe(tracking);
  });
});

describe("price helpers", () => {
  it("formats larger dollar amounts with separators", () => {
    expect(formatUsd(2240.671)).toBe("$2,240.67");
  });

  it("states the unit price of the asset bought", () => {
    expect(unitPrice("0.002", 4.5)).toBe("$2,250.00");
    expect(unitPrice("0", 4.5)).toBeNull();
    expect(unitPrice("0.002", undefined)).toBeNull();
  });

  it("states what the swap costs, in dollars and percent", () => {
    expect(swapCost({ in: 5, out: 4.9 })).toBe("$0.10 (2.00%)");
    expect(swapCost({ in: 5, out: 5.2 })).toBeNull();
    expect(swapCost(undefined)).toBeNull();
  });

  it("states the time in plain words", () => {
    expect(formatEta(49)).toBe("About 49 seconds");
    expect(formatEta(1)).toBe("A few seconds");
    expect(formatEta(150)).toBe("About 3 minutes");
    expect(formatEta(0)).toBeNull();
  });

  it("tells a usable amount from an unfinished one", () => {
    expect(isPriceable("5")).toBe(true);
    expect(isPriceable("0.5")).toBe(true);
    expect(isPriceable("")).toBe(false);
    expect(isPriceable("0")).toBe(false);
    expect(isPriceable("0.")).toBe(false);
    expect(isPriceable("abc")).toBe(false);
  });

  it("says how much better the best route is than the next", () => {
    const route = (quoteId: string, minAmountOut: string, out?: number) =>
      ({ quoteId, minAmountOut, amountOut: minAmountOut, usd: out === undefined ? undefined : { in: 5, out } }) as PublicRoute;
    expect(bestAdvantage([route("a", "2", 4.9), route("b", "1", 4.4)])).toBe("$0.50");
    expect(bestAdvantage([route("a", "2", 4.9)])).toBeNull();
    expect(bestAdvantage([route("a", "2"), route("b", "1")])).toBeNull();
  });

  it("compares what arrived with what was guaranteed", () => {
    expect(receivedAboveMinimum("0.00225", "0.00216")).toBe("4.17%");
    expect(receivedAboveMinimum("0.002", "0.002")).toBeNull();
    expect(receivedAboveMinimum(null, "0.002")).toBeNull();
  });
});

describe("explorer links for chains that don't match", () => {
  it("skips a hash that can't be on an EVM destination", () => {
    const links = explorerLinks(["0xaaa", "5i7QpCFZ"], "eth:usdc", "base:eth");
    expect(links.map((link) => link.hash)).toEqual(["0xaaa"]);
  });

  it("names the deposit and the delivery", () => {
    const links = explorerLinks(["0xaaa", "5i7QpCFZ", "0xbbb"], "eth:usdc", "base:eth");
    expect(links.map((link) => link.kind)).toEqual(["deposit", "delivery"]);
  });
});

describe("walletOptions", () => {
  const injected = { id: "injected", name: "Injected", type: "injected" };
  const metamask = { id: "io.metamask", name: "MetaMask", type: "injected", icon: "data:image/svg+xml,x" };
  const rabby = { id: "io.rabby", name: "Rabby Wallet", type: "injected", icon: "data:image/svg+xml,y" };

  it("lists each discovered wallet and hides the generic entry", () => {
    expect(walletOptions([injected, metamask, rabby]).map((option) => option.id)).toEqual(["io.metamask", "io.rabby"]);
  });

  it("names the generic entry plainly when it's all there is", () => {
    expect(walletOptions([injected])[0]?.name).toBe("Browser wallet");
  });

  it("can be empty", () => {
    expect(walletOptions([])).toEqual([]);
  });
});

describe("routes on chains this page can't sign on", () => {
  const needsSignature = { depositable: false } as PublicRoute;

  it("offers a deposit from any chain", () => {
    expect(routeAction({ depositable: true } as PublicRoute, false, "sol")).toBe("deposit");
  });

  it("asks for a wallet on Ethereum and Base", () => {
    expect(routeAction(needsSignature, false, "eth")).toBe("connect");
    expect(routeAction(needsSignature, true, "base")).toBe("wallet");
  });

  it("says so anywhere else, even with a wallet connected", () => {
    expect(routeAction(needsSignature, true, "sol")).toBe("unsupported");
    expect(routeAction(needsSignature, true, "arb")).toBe("unsupported");
  });
});

describe("explorers across chains", () => {
  it("links each chain to its own explorer", () => {
    expect(explorerLinks(["0xa"], "arb:eth", "sol:sol")[0]?.url).toBe("https://arbiscan.io/tx/0xa");
    expect(explorerLinks(["0xa"], "bsc:bnb", "sol:sol")[0]?.label).toBe("BscScan");
  });

  it("gives no link for a chain it has no explorer for, rather than a wrong one", () => {
    expect(explorerLinks(["0xa"], "hood:eth", "base:eth")).toEqual([]);
  });

  it("gives no address link for an unknown chain", () => {
    expect(explorerAddressUrl("hood", "0xa")).toBeNull();
    expect(explorerAddressUrl("arb", "0xa")).toBe("https://arbiscan.io/address/0xa");
  });
});

describe("sending with a connected wallet", () => {
  it("is only offered on chains this page can sign on", () => {
    expect(canSignOn("eth:usdc")).toBe(true);
    expect(canSignOn("base:eth")).toBe(true);
    expect(canSignOn("arb:eth")).toBe(false);
    expect(canSignOn("sol:sol")).toBe(false);
  });

  it("explains a sample address plainly", () => {
    expect(errorMessage({ error: "sample_address" }, 422)).toMatch(/real wallet address/);
  });
});

