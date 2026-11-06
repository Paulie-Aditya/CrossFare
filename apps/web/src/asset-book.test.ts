import { beforeEach, describe, expect, it } from "vitest";
import { chainNameOf, displaySymbol, filterAssets, isEvmAsset, logoOf, setBook, symbolOf, type AssetOption } from "./asset-book.ts";

const asset = (id: string, symbol: string, name: string, chain = id.split(":")[0]!): AssetOption => ({ id, chain, symbol, name, decimals: 18, evm: chain !== "btc", venues: [] });
const assets = [
  asset("btc:btc", "btc", "Bitcoin"),
  asset("eth:usdc", "usdc", "USD Coin"),
  asset("base:usdc", "usdc", "USD Coin"),
  asset("arb:usdc-0xabc123", "USDC", "USD Coin"),
  asset("eth:usdt-0xdac17f", "USDT", "Tether"),
  asset("eth:weth-0xc02a", "WETH", "Wrapped Ether"),
  asset("eth:eth", "eth", "Ether"),
];

beforeEach(() => setBook(assets, [{ id: "eth", name: "Ethereum" }, { id: "arb", name: "Arbitrum" }]));

describe("filterAssets", () => {
  const ids = (found: { shown: AssetOption[] }) => found.shown.map((option) => option.id);

  it("keeps the given order with no search", () => {
    expect(ids(filterAssets(assets, "", null))[0]).toBe("btc:btc");
  });

  it("finds by symbol, name or contract, exact matches first", () => {
    expect(ids(filterAssets(assets, "eth", null))[0]).toBe("eth:eth");
    expect(ids(filterAssets(assets, "tether", null))).toEqual(["eth:usdt-0xdac17f"]);
    expect(ids(filterAssets(assets, "0xabc123", null))).toEqual(["arb:usdc-0xabc123"]);
  });

  it("narrows to one chain", () => {
    expect(ids(filterAssets(assets, "usdc", "arb"))).toEqual(["arb:usdc-0xabc123"]);
  });

  it("caps what it draws but counts everything it found", () => {
    const found = filterAssets(assets, "", null, 2);
    expect(found.shown).toHaveLength(2);
    expect(found.total).toBe(assets.length);
  });
});

describe("reading the book", () => {
  it("names assets it knows", () => {
    expect(symbolOf("arb:usdc-0xabc123")).toBe("USDC");
    expect(chainNameOf("arb:usdc-0xabc123")).toBe("Arbitrum");
    expect(isEvmAsset("btc:btc")).toBe(false);
  });

  it("still reads an id it doesn't know, such as an old record", () => {
    expect(symbolOf("avax:joe-0x123")).toBe("JOE");
    expect(chainNameOf("avax:joe-0x123")).toBe("AVAX");
    expect(logoOf("avax:joe-0x123")).toBeUndefined();
  });

  it("keeps a ticker's own casing", () => {
    expect(displaySymbol("cbBTC")).toBe("cbBTC");
    expect(displaySymbol("eth")).toBe("ETH");
  });
});
