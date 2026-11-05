import { describe, expect, it } from "vitest";
import { createSpendPolicy } from "./policy.ts";

const options = { perCallCap: 100_000n, totalBudget: 150_000n, allowedPayTo: ["0.0.999"], asset: "0.0.429274" };
const charge = (overrides = {}) => ({ payTo: "0.0.999", amount: "60000", asset: "0.0.429274", ...overrides });

describe("spend policy", () => {
  it("allows a payment within limits", () => {
    expect(createSpendPolicy(options).check(charge())).toEqual({ allowed: true });
  });

  it("refuses an account outside the allowlist", () => {
    const result = createSpendPolicy(options).check(charge({ payTo: "0.0.666" }));
    expect(result).toEqual({ allowed: false, reason: expect.stringContaining("0.0.666") });
  });

  it("refuses a charge over the per-call cap", () => {
    const result = createSpendPolicy(options).check(charge({ amount: "100001" }));
    expect(result.allowed).toBe(false);
  });

  it("refuses an unexpected asset", () => {
    expect(createSpendPolicy(options).check(charge({ asset: "0.0.0" })).allowed).toBe(false);
  });

  it("stops once the total budget would be exceeded", () => {
    const policy = createSpendPolicy(options);
    policy.record(charge());
    policy.record(charge());
    expect(policy.spent()).toBe(120_000n);
    expect(policy.check(charge()).allowed).toBe(false);
    expect(policy.check(charge({ amount: "30000" })).allowed).toBe(true);
  });

  it("doesn't count a charge that was only checked", () => {
    const policy = createSpendPolicy(options);
    policy.check(charge());
    expect(policy.spent()).toBe(0n);
  });
});
