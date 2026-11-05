import { describe, expect, it } from "vitest";
import { fromBaseUnits, rankRoutes, type Route } from "./routes.ts";

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
