import { beforeEach, describe, expect, it } from "vitest";
import { createStore, type Store } from "./store.ts";
import { createVipGate, generateVipKey, hashVipKey, isValidVipLabel, signVipRequest, type VipRequest } from "./vip.ts";

const NOW = new Date("2026-11-08T10:00:00.000Z");
const seconds = (date: Date) => String(Math.floor(date.getTime() / 1000));

let store: Store;
let currentTime: Date;
let apiKey: string;

beforeEach(() => {
  store = createStore(":memory:");
  currentTime = NOW;
  apiKey = generateVipKey();
  store.saveVipKey({
    id: "vk_1",
    label: "partner",
    keyHash: hashVipKey(apiKey),
    scopes: ["quote"],
    ratePerMinute: 3,
    monthlyQuota: null,
    createdAt: NOW.toISOString(),
  });
});

const gate = () => createVipGate({ store, now: () => currentTime });

function signed(overrides: Partial<VipRequest> = {}, key = apiKey): VipRequest {
  const base = { method: "POST", path: "/v1/quote", body: '{"amount":"5"}', timestamp: seconds(currentTime), ...overrides };
  return {
    authorization: `Bearer ${key}`,
    signature: signVipRequest(key, base),
    ...base,
    ...overrides,
  };
}

describe("VIP keys", () => {
  it("are long random secrets with a recognisable prefix", () => {
    const [a, b] = [generateVipKey(), generateVipKey()];
    expect(a).toMatch(/^cf_live_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(hashVipKey(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("take labels that are safe to publish on Arkiv", () => {
    expect(isValidVipLabel("partner-1")).toBe(true);
    expect(isValidVipLabel("Partner")).toBe(false);
    expect(isValidVipLabel("a b")).toBe(false);
    expect(isValidVipLabel("x".repeat(33))).toBe(false);
  });
});

describe("the VIP gate", () => {
  it("stays out of the way when no VIP credential is sent", () => {
    expect(gate().check({ method: "POST", path: "/v1/quote", body: "{}" }, "quote")).toEqual({ kind: "none" });
    expect(gate().check({ method: "POST", path: "/v1/quote", body: "{}", authorization: "Bearer other" }, "quote")).toEqual({ kind: "none" });
  });

  it("allows a signed request from a live key, naming the payer by label", () => {
    expect(gate().check(signed(), "quote")).toMatchObject({ kind: "allowed", payer: "vip:partner", key: { id: "vk_1" } });
  });

  it.each([
    ["an unknown key", () => signed({}, generateVipKey()), "invalid_vip_key"],
    ["no signature", () => ({ ...signed(), signature: undefined }), "vip_signature_missing"],
    ["no timestamp", () => ({ ...signed(), timestamp: undefined }), "vip_signature_missing"],
    ["a changed body", () => ({ ...signed(), body: '{"amount":"500"}' }), "vip_signature_invalid"],
    ["another path", () => ({ ...signed(), path: "/v1/swap" }), "vip_signature_invalid"],
    ["a stale timestamp", () => signed({ timestamp: seconds(new Date(NOW.getTime() - 61_000)) }), "vip_timestamp_out_of_window"],
    ["a future timestamp", () => signed({ timestamp: seconds(new Date(NOW.getTime() + 61_000)) }), "vip_timestamp_out_of_window"],
  ])("refuses %s with a 402", (_name, request, error) => {
    expect(gate().check(request(), "quote")).toEqual({ kind: "denied", status: 402, error });
  });

  it("refuses a revoked key at once", () => {
    store.revokeVipKey("vk_1", NOW.toISOString());
    expect(gate().check(signed(), "quote")).toEqual({ kind: "denied", status: 402, error: "invalid_vip_key" });
  });

  it("refuses an endpoint outside the key's scopes with a 403", () => {
    expect(gate().check(signed({ path: "/v1/swap" }), "swap")).toEqual({ kind: "denied", status: 403, error: "vip_scope_missing" });
  });

  it("limits each key's requests per minute", () => {
    const vip = gate();
    for (let i = 0; i < 3; i++) expect(vip.check(signed(), "quote").kind).toBe("allowed");
    expect(vip.check(signed(), "quote")).toEqual({ kind: "denied", status: 429, error: "vip_rate_limited" });
    currentTime = new Date(NOW.getTime() + 60_001);
    expect(vip.check(signed(), "quote").kind).toBe("allowed");
  });

  it("stops a key at its monthly quota of metered calls", () => {
    store.saveVipKey({ id: "vk_2", label: "small", keyHash: hashVipKey("cf_live_small"), scopes: ["quote"], ratePerMinute: null, monthlyQuota: 1, createdAt: NOW.toISOString() });
    const vip = gate();
    const request = signed({}, "cf_live_small");
    const allowed = vip.check(request, "quote");
    expect(allowed.kind).toBe("allowed");
    if (allowed.kind === "allowed") vip.record(allowed.key, "POST /v1/quote", "r_1");
    expect(vip.check(signed({}, "cf_live_small"), "quote")).toEqual({ kind: "denied", status: 429, error: "vip_quota_exceeded" });
    currentTime = new Date("2026-12-01T00:00:00.000Z");
    expect(vip.check(signed({}, "cf_live_small"), "quote").kind).toBe("allowed");
  });
});
