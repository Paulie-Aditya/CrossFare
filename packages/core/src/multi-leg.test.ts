import { beforeAll, describe, expect, it, vi } from "vitest";
import { getAsset, registerAssets, toBaseUnits, type Asset } from "./assets.ts";
import { composeRoute, findTwoLegRoutes, hubAssets, intermediates, legRequest } from "./multi-leg.ts";
import type { Route } from "./routes.ts";
import type { QuoteRequest, Venue } from "./venues/types.ts";

const AGENT = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const OTHER = "0x1111111111111111111111111111111111111111";
const BTC_ADDRESS = "357a3So9CbsNfBBgFYACGvxxS6tMaDoa1P";

const evm = (id: string, chainId: number, address: string, decimals = 18, swapkit?: string): Asset => {
  const [chain, symbol] = id.split(":") as [string, string];
  return { id, chain, symbol, decimals, uniswap: { chainId, address }, swapkitChain: String(chainId), ...(swapkit ? { swapkit } : {}) };
};
const ZERO = "0x0000000000000000000000000000000000000000";
const PEPE = evm("eth:pepe", 1, "0x6982508145454Ce325dDbE47a25d4ec3d2311933");
const USDT = evm("eth:usdt-0xdac17f958d2ee523a2206206994597c13d831ec7", 1, "0xdAC17F958D2ee523a2206206994597C13D831ec7", 6, "ETH.USDT-0xdac17f958d2ee523a2206206994597c13d831ec7");
const BNB = evm("bsc:bnb", 56, ZERO, 18, "BSC.BNB");
const BSC_USDC = evm("bsc:usdc-0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", 56, "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", 18, "BSC.USDC-0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d");
// A look-alike: same symbol, wrong contract. It must never be picked as a hub.
const FAKE_USDC = evm("eth:usdc-0xbad", 1, "0x00000000000000000000000000000000000000ba", 6, "ETH.USDC-0x00000000000000000000000000000000000000ba");
const THOR_RUNE: Asset = { id: "thor:rune", chain: "thor", symbol: "RUNE", decimals: 8, swapkit: "THOR.RUNE", swapkitChain: "thorchain" };
const THOR_TCY: Asset = { id: "thor:tcy", chain: "thor", symbol: "TCY", decimals: 8, swapkit: "THOR.TCY", swapkitChain: "thorchain" };

beforeAll(() => registerAssets([PEPE, USDT, BNB, BSC_USDC, FAKE_USDC, THOR_RUNE, THOR_TCY]));

const request = (from: string, amount: string, to: string, overrides: Partial<QuoteRequest> = {}): QuoteRequest => ({
  from: { asset: from, amount, address: AGENT },
  to: { asset: to, address: AGENT },
  mode: "exact_in",
  slippageBps: 100,
  refundAddress: AGENT,
  ...overrides,
});

const VALID = "2026-11-11T10:01:00.000Z";

/** A venue that serves pairs it's told about, at a fixed rate per pair, keeping 1% back for slippage. */
function fakeVenue(name: string, rates: Record<string, number>, extra: Partial<Route> = {}) {
  const key = (from: string, to: string) => `${from}>${to}`;
  const quote = vi.fn(async (req: QuoteRequest): Promise<Route[]> => {
    const rate = rates[key(req.from.asset, req.to.asset)];
    if (rate === undefined) return [];
    const from = getAsset(req.from.asset);
    const to = getAsset(req.to.asset);
    const amountIn = toBaseUnits(req.from.amount, from.decimals);
    // The rate in millionths keeps the arithmetic exact.
    const amountOut = (amountIn * BigInt(Math.round(rate * 1e6)) * 10n ** BigInt(to.decimals)) / (10n ** 6n * 10n ** BigInt(from.decimals));
    return [{
      venue: name,
      from: from.id,
      to: to.id,
      amountIn: amountIn.toString(),
      amountOut: amountOut.toString(),
      minAmountOut: ((amountOut * 99n) / 100n).toString(),
      fees: { networkUsd: "0.5" },
      etaSeconds: 60,
      validUntil: VALID,
      venueData: { name },
      ...extra,
    }];
  });
  const venue: Venue = {
    name,
    serves: (from, to) => Object.keys(rates).some((pair) => pair.startsWith(`${from.id}>`)) && Object.keys(rates).some((pair) => pair.endsWith(`>${to.id}`)),
    quote,
    prepare: vi.fn(),
    track: vi.fn(),
  };
  return Object.assign(venue, { quote });
}

describe("hubAssets", () => {
  it("lists a chain's native coin, then its canonical USDC and USDT", () => {
    expect(hubAssets("eth")).toEqual(["eth:eth", "eth:usdc", USDT.id]);
    expect(hubAssets("bsc")).toEqual(["bsc:bnb", BSC_USDC.id]);
  });

  it("never takes a look-alike token by its symbol", () => {
    expect(hubAssets("eth")).not.toContain(FAKE_USDC.id);
  });

  it("skips a native coin it can't tell apart from the chain's other coins", () => {
    expect(hubAssets("thor")).toEqual([]);
  });
});

describe("intermediates", () => {
  const bridge = fakeVenue("swapkit", { "bsc:bnb>eth:eth": 1, "bsc:bnb>eth:usdc": 1, "bsc:bnb>eth:pepe": 1 });
  const dex = fakeVenue("uniswap", { "eth:eth>eth:pepe": 1, "eth:usdc>eth:pepe": 1, [`${USDT.id}>eth:pepe`]: 1 });

  it("keeps hubs some venue serves into and some venue serves out of, destination chain first", () => {
    expect(intermediates([bridge, dex], request("bsc:bnb", "1", "eth:pepe"), 5)).toEqual(["eth:eth", "eth:usdc"]);
  });

  it("stops at the limit", () => {
    expect(intermediates([bridge, dex], request("bsc:bnb", "1", "eth:pepe"), 1)).toEqual(["eth:eth"]);
  });

  it("never uses either end of the swap as its own hub", () => {
    const hubs = intermediates([bridge, dex], request("bsc:bnb", "1", "eth:pepe"), 10);
    expect(hubs).not.toContain("bsc:bnb");
    expect(hubs).not.toContain("eth:pepe");
  });
});

describe("findTwoLegRoutes", () => {
  // 1 BNB buys 0.2 ETH; 1 ETH buys 1,000,000 PEPE.
  const bridge = () => fakeVenue("swapkit", { "bsc:bnb>eth:eth": 0.2 }, { provider: "chainflip", usd: { in: 600, out: 598 } });
  const dex = () => fakeVenue("uniswap", { "eth:eth>eth:pepe": 1_000_000 }, { usd: { in: 597, out: 595 } });

  it("bridges into a hub, then swaps the hub into the token", async () => {
    const [route, ...rest] = await findTwoLegRoutes([bridge(), dex()], request("bsc:bnb", "1", "eth:pepe"));
    expect(rest).toEqual([]);
    expect(route).toMatchObject({
      venue: "swapkit+uniswap",
      from: "bsc:bnb",
      to: "eth:pepe",
      amountIn: "1000000000000000000",
      amountOut: "200000000000000000000000",
      etaSeconds: 120,
      validUntil: VALID,
      depositable: false,
      usd: { in: 600, out: 595 },
    });
    expect(route!.legs?.map((leg) => [leg.venue, leg.from, leg.to])).toEqual([
      ["swapkit", "bsc:bnb", "eth:eth"],
      ["uniswap", "eth:eth", "eth:pepe"],
    ]);
  });

  it("quotes the second leg at what the first is expected to deliver", async () => {
    const swap = dex();
    await findTwoLegRoutes([bridge(), swap], request("bsc:bnb", "1", "eth:pepe"));
    expect(swap.quote.mock.calls[0]![0].from).toEqual({ asset: "eth:eth", amount: "0.2", address: AGENT });
  });

  it("guarantees the second leg's minimum on the first leg's minimum, not its expected amount", async () => {
    const [route] = await findTwoLegRoutes([bridge(), dex()], request("bsc:bnb", "1", "eth:pepe"));
    // 0.99 of 0.99 of 200,000 PEPE.
    expect(route!.minAmountOut).toBe("196020000000000000000000");
  });

  it("holds the hub at the receiving address when it sits on the destination chain", async () => {
    const first = bridge();
    const second = dex();
    await findTwoLegRoutes([first, second], request("bsc:bnb", "1", "eth:pepe", { to: { asset: "eth:pepe", address: OTHER } }));
    expect(first.quote.mock.calls[0]![0].to).toEqual({ asset: "eth:eth", address: OTHER });
    expect(second.quote.mock.calls[0]![0].from.address).toBe(OTHER);
    expect(second.quote.mock.calls[0]![0].refundAddress).toBe(OTHER);
  });

  it("holds the hub at the sender when it sits on the source chain", async () => {
    const swap = fakeVenue("uniswap", { "eth:pepe>eth:eth": 0.000001 });
    const out = fakeVenue("swapkit", { "eth:eth>btc:btc": 0.03 });
    const routes = await findTwoLegRoutes([swap, out], request("eth:pepe", "1000000", "btc:btc", { to: { asset: "btc:btc", address: BTC_ADDRESS } }));
    expect(routes[0]?.venue).toBe("uniswap+swapkit");
    expect(swap.quote.mock.calls[0]![0].to).toEqual({ asset: "eth:eth", address: AGENT });
    expect(out.quote.mock.calls[0]![0]).toMatchObject({ from: { asset: "eth:eth", address: AGENT }, to: { address: BTC_ADDRESS }, refundAddress: AGENT });
  });

  it("charges the caller's fee once, on the last leg", async () => {
    const first = bridge();
    const second = dex();
    const fee = { bps: 50, recipients: { evm: OTHER } };
    await findTwoLegRoutes([first, second], request("bsc:bnb", "1", "eth:pepe", { fee }));
    expect(first.quote.mock.calls[0]![0].fee).toBeUndefined();
    expect(second.quote.mock.calls[0]![0].fee).toEqual(fee);
  });

  it("asks no venue about a leg it doesn't serve", async () => {
    const first = bridge();
    const second = dex();
    await findTwoLegRoutes([first, second], request("bsc:bnb", "1", "eth:pepe"));
    expect(first.quote).toHaveBeenCalledTimes(1);
    expect(second.quote).toHaveBeenCalledTimes(1);
  });

  it("offers each second-leg venue's route on the first leg's best route", async () => {
    const cheap = fakeVenue("near-intents", { "bsc:bnb>eth:eth": 0.1 });
    const other = fakeVenue("thorchain", { "eth:eth>eth:pepe": 900_000 });
    const routes = await findTwoLegRoutes([bridge(), cheap, dex(), other], request("bsc:bnb", "1", "eth:pepe"));
    expect(routes.map((route) => route.venue)).toEqual(["swapkit+uniswap", "swapkit+thorchain"]);
  });

  it("reports a venue that fails and carries on with the others", async () => {
    const broken = fakeVenue("near-intents", { "bsc:bnb>eth:eth": 1 });
    broken.quote.mockRejectedValueOnce(new Error("down"));
    const onError = vi.fn();
    const routes = await findTwoLegRoutes([broken, bridge(), dex()], request("bsc:bnb", "1", "eth:pepe"), { onError });
    expect(routes).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "down" }));
  });

  it("finds nothing when no hub has a first leg", async () => {
    expect(await findTwoLegRoutes([dex()], request("bsc:bnb", "1", "eth:pepe"))).toEqual([]);
  });

  it("plans exact-input swaps only", async () => {
    expect(await findTwoLegRoutes([bridge(), dex()], request("bsc:bnb", "1", "eth:pepe", { mode: "exact_out" }))).toEqual([]);
  });
});

describe("composeRoute", () => {
  const leg = (overrides: Partial<Route>): Route => ({
    venue: "a",
    from: "bsc:bnb",
    to: "eth:eth",
    amountIn: "100",
    amountOut: "1000",
    minAmountOut: "900",
    fees: {},
    etaSeconds: 10,
    validUntil: "2026-11-11T10:05:00.000Z",
    venueData: null,
    ...overrides,
  });

  it("labels each leg's fees, takes the earlier deadline and leaves dollars out unless both legs have them", () => {
    const route = composeRoute(
      leg({ fees: { networkUsd: "1" }, usd: { in: 10, out: 9 } }),
      leg({ venue: "b", from: "eth:eth", to: "eth:pepe", amountIn: "1000", amountOut: "50", minAmountOut: "40", fees: { networkUsd: "2" }, validUntil: "2026-11-11T10:01:00.000Z" }),
    );
    expect(route.fees).toEqual({ "leg1.networkUsd": "1", "leg2.networkUsd": "2" });
    expect(route.validUntil).toBe("2026-11-11T10:01:00.000Z");
    expect(route.usd).toBeUndefined();
    expect(route.minAmountOut).toBe("36");
  });
});

describe("legRequest", () => {
  it("rebuilds each leg's request from a planned route, the second at its own input", async () => {
    const base = request("bsc:bnb", "1", "eth:pepe", { fee: { bps: 10, recipients: { evm: OTHER } } });
    const [route] = await findTwoLegRoutes(
      [fakeVenue("swapkit", { "bsc:bnb>eth:eth": 0.2 }), fakeVenue("uniswap", { "eth:eth>eth:pepe": 1_000_000 })],
      base,
    );
    expect(legRequest(base, route!, 0)).toMatchObject({ from: base.from, to: { asset: "eth:eth", address: AGENT }, refundAddress: AGENT });
    expect(legRequest(base, route!, 0).fee).toBeUndefined();
    expect(legRequest(base, route!, 1)).toMatchObject({ from: { asset: "eth:eth", amount: "0.2", address: AGENT }, to: base.to, fee: base.fee });
    expect(legRequest(base, route!, 1, "150000000000000000").from.amount).toBe("0.15");
  });
});
