import { describe, expect, it } from "vitest";
import { fromBaseUnits, rankRoutes, type Route, describeSwap, withUsdValues } from "./routes.ts";

const route = (venue: string, minAmountOut: string, amountOut = minAmountOut): Route => ({
  venue,
  from: "base:usdc",
  to: "base:eth",
  amountIn: "1000000",
  amountOut,
  minAmountOut,
  fees: {},
  etaSeconds: 30,
  validUntil: "2026-11-07T00:00:00.000Z",
  venueData: null,
});

describe("rankRoutes", () => {
  it("sorts by minimum received, highest first", () => {
    const ranked = rankRoutes([route("a", "100"), route("b", "300"), route("c", "200")]);
    expect(ranked.map((r) => r.venue)).toEqual(["b", "c", "a"]);
  });

  it("compares amounts numerically, beyond the safe integer range", () => {
    const ranked = rankRoutes([
      route("small", "9"),
      route("big", "100000000000000000000000"),
      route("bigger", "100000000000000000000001"),
    ]);
    expect(ranked.map((r) => r.venue)).toEqual(["bigger", "big", "small"]);
  });

  it("ignores the headline amount when the guaranteed amount is lower", () => {
    const ranked = rankRoutes([route("flashy", "100", "999"), route("solid", "200", "200")]);
    expect(ranked[0]?.venue).toBe("solid");
  });

  it("does not mutate its input", () => {
    const input = [route("a", "1"), route("b", "2")];
    rankRoutes(input);
    expect(input[0]?.venue).toBe("a");
  });
});

describe("fromBaseUnits", () => {
  it("formats base units as a decimal string without trailing zeros", () => {
    expect(fromBaseUnits("1500000", 6)).toBe("1.5");
    expect(fromBaseUnits("1", 8)).toBe("0.00000001");
    expect(fromBaseUnits("25000000", 6)).toBe("25");
    expect(fromBaseUnits("0", 18)).toBe("0");
  });
});

describe("withUsdValues", () => {
  const base = { venue: "x", from: "base:usdc", to: "base:eth", amountIn: "2000000", fees: {}, etaSeconds: 1, validUntil: "", venueData: null };
  const priced = { ...base, venue: "swapkit", amountOut: "1000", minAmountOut: "1000", usd: { in: 2, out: 1.9 } };
  const bare = { ...base, venue: "uniswap", amountOut: "1100", minAmountOut: "1100" };

  it("prices a bare route from a priced route on the same pair", () => {
    const [, filled] = withUsdValues([priced, bare]);
    expect(filled?.usd?.in).toBe(2);
    expect(filled?.usd?.out).toBeCloseTo(2.09);
  });

  it("leaves a priced route alone", () => {
    expect(withUsdValues([priced, bare])[0]?.usd).toEqual({ in: 2, out: 1.9 });
  });

  it("falls back on the stablecoin side when nothing is priced", () => {
    expect(withUsdValues([bare])[0]?.usd).toEqual({ in: 2, out: 2 });
    const toStable = { ...bare, from: "base:eth", to: "base:usdc", amountIn: "1000000000000000000", amountOut: "2240000000", minAmountOut: "2240000000" };
    expect(withUsdValues([toStable])[0]?.usd).toEqual({ in: 2240, out: 2240 });
  });

  it("leaves a pair with no price and no stablecoin unpriced", () => {
    const noStable = { ...bare, from: "eth:eth", to: "base:eth" };
    expect(withUsdValues([noStable])[0]?.usd).toBeUndefined();
  });
});

describe("describeSwap", () => {
  it("reads like a line of transaction history", () => {
    expect(describeSwap({ from: "eth:usdc", to: "base:eth", amountIn: "5000000", amountOut: "2225665081008325", outcome: "completed" })).toBe(
      "Swapped 5 USDC on Ethereum for 0.0022257 ETH on Base",
    );
    expect(describeSwap({ from: "eth:usdc", to: "base:eth", amountIn: "5000000", amountOut: "2225665081008325", outcome: "quoted" })).toBe(
      "5 USDC on Ethereum for about 0.0022257 ETH on Base",
    );
    expect(describeSwap({ from: "eth:usdc", to: "base:eth", amountIn: "5000000", amountOut: "2225665081008325", outcome: "refunded" })).toBe(
      "Refunded: 5 USDC on Ethereum to ETH on Base",
    );
  });

  it("fits Arkiv's 128-byte limit for a string", () => {
    const line = describeSwap({ from: "base:eth", to: "xrp:xrp", amountIn: "123456789123456789123456", amountOut: "98765432123456789", outcome: "completed" });
    expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(128);
  });
});
