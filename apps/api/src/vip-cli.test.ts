import { beforeEach, describe, expect, it } from "vitest";
import { createStore, type Store } from "./store.ts";
import { runVipCommand } from "./vip-cli.ts";
import { hashVipKey } from "./vip.ts";

const NOW = new Date("2026-11-08T10:00:00.000Z");
let store: Store;
let lines: string[];
const run = (...args: string[]) => runVipCommand(args, { store, now: () => NOW, print: (line) => lines.push(line), newId: () => "vk_test" });

beforeEach(() => {
  store = createStore(":memory:");
  lines = [];
});

describe("vip create", () => {
  it("prints the key once and stores only its hash, with the given limits", () => {
    expect(run("create", "partner", "--scopes", "quote", "--rate", "30", "--quota", "1000")).toBe(0);
    const key = lines.join("\n").match(/cf_live_[A-Za-z0-9_-]{43}/)?.[0];
    expect(key).toBeDefined();
    expect(store.getVipKeyByHash(hashVipKey(key!))).toMatchObject({
      id: "vk_test",
      label: "partner",
      scopes: ["quote"],
      ratePerMinute: 30,
      monthlyQuota: 1000,
    });
  });

  it("defaults to both scopes, 60 a minute and no quota", () => {
    run("create", "partner");
    expect(store.listVipKeys()[0]).toMatchObject({ scopes: ["quote", "swap"], ratePerMinute: 60, monthlyQuota: null });
  });

  it.each([
    [["create"], "label"],
    [["create", "Has Spaces"], "label"],
    [["create", "partner", "--scopes", "trade"], "scopes"],
    [["create", "partner", "--rate", "-1"], "rate"],
  ])("refuses %j", (args, word) => {
    expect(run(...args)).toBe(1);
    expect(lines.join(" ")).toContain(word);
    expect(store.listVipKeys()).toHaveLength(0);
  });
});

describe("vip list, revoke and usage", () => {
  beforeEach(() => {
    run("create", "partner");
    lines = [];
  });

  it("lists keys without any secret", () => {
    run("list");
    expect(lines.join("\n")).toContain("vk_test");
    expect(lines.join("\n")).toContain("partner");
    expect(lines.join("\n")).not.toMatch(/cf_live_|[0-9a-f]{64}/);
  });

  it("revokes a key", () => {
    expect(run("revoke", "vk_test")).toBe(0);
    expect(store.listVipKeys()[0]?.revokedAt).toBe(NOW.toISOString());
    expect(run("revoke", "vk_nope")).toBe(1);
  });

  it("exports a month's metered calls as CSV", () => {
    store.recordVipUsage({ keyId: "vk_test", endpoint: "POST /v1/quote", usedBy: "r_1", at: "2026-10-31T12:00:00.000Z" });
    store.recordVipUsage({ keyId: "vk_test", endpoint: "POST /v1/quote", usedBy: "r_2", at: "2026-11-03T12:00:00.000Z" });
    run("usage", "--month", "2026-11");
    expect(lines).toEqual(["label,key_id,endpoint,calls", "partner,vk_test,POST /v1/quote,1"]);
  });

  it("defaults usage to the current month", () => {
    store.recordVipUsage({ keyId: "vk_test", endpoint: "POST /v1/swap", usedBy: "s_1", at: "2026-11-08T09:00:00.000Z" });
    run("usage");
    expect(lines[1]).toBe("partner,vk_test,POST /v1/swap,1");
  });
});
