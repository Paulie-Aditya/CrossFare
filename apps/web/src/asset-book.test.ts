import { beforeEach, describe, expect, it } from "vitest";
import { addAssets, chainNameOf, contractOf, contractQuery, solanaMintQuery, displaySymbol, filterAssets, isEvmAsset, isUnverified, logoOf, pickerMessage, setBook, symbolOf, type AssetOption } from "./asset-book.ts";

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

describe("pickerMessage", () => {
  it("doesn't blame the search when the list hasn't loaded", () => {
    expect(pickerMessage("failed", "")).toMatch(/isn't answering/);
    expect(pickerMessage("failed", "usdc")).toMatch(/isn't answering/);
    expect(pickerMessage("loading", "")).toMatch(/Loading/);
  });

  it("points at the search once the list is there", () => {
    expect(pickerMessage("ready", "zzz")).toMatch(/No token matches/);
  });
});

describe("tokens found by contract", () => {
  it("join the book so they read by symbol, flagged when on no list", () => {
    addAssets([{ ...asset("base:kntq-0xb801", "KNTQ", "Kntq"), verified: false }]);
    expect(symbolOf("base:kntq-0xb801")).toBe("KNTQ");
    expect(isUnverified("base:kntq-0xb801")).toBe(true);
    expect(isUnverified("eth:usdc")).toBe(false);
  });

  it("are looked up when the search is a whole contract address", () => {
    expect(contractQuery(" 0xb80194e3868511b8f43e1d5d6e255cd9e7c3e7dd ")).toBe("0xb80194e3868511b8f43e1d5d6e255cd9e7c3e7dd");
    expect(contractQuery("0xb801")).toBeNull();
    expect(contractQuery("usdc")).toBeNull();
  });
});

describe("contractOf", () => {
  it("reads the contract even when the ticker has a hyphen", () => {
    expect(contractOf("base:usd-x-0xb80194e3868511b8f43e1d5d6e255cd9e7c3e7dd")).toBe("0xb80194e3868511b8f43e1d5d6e255cd9e7c3e7dd");
    expect(contractOf("eth:eth")).toBe("");
  });
});

describe("search by contract address", () => {
  const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const listed: AssetOption[] = [
    { ...asset("eth:usdc", "usdc", "USD Coin"), contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
    { ...asset("sol:usdc-epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v", "USDC", "USD Coin", "sol"), evm: false, contract: USDC_MINT },
    asset("eth:eth", "eth", "Ether"),
  ];
  const ids = (found: { shown: AssetOption[] }) => found.shown.map((option) => option.id);

  it("finds a token whose ID doesn't carry its contract, in any letter case", () => {
    expect(ids(filterAssets(listed, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", null))).toEqual(["eth:usdc"]);
    expect(ids(filterAssets(listed, " 0xA0B86991 ", null))).toEqual(["eth:usdc"]);
  });

  it("finds a Solana token by its mint", () => {
    expect(ids(filterAssets(listed, USDC_MINT, null))).toEqual(["sol:usdc-epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v"]);
  });

  it("puts a whole-address match first", () => {
    const lookalike = { ...asset("eth:a0b8-0x1", "A0B86991C6218B36C1D19D4A2E9EB0CE3606EB48X", "Lookalike"), contract: "0x1" };
    expect(ids(filterAssets([lookalike, ...listed], "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", null))[0]).toBe("eth:usdc");
  });

  it("says plainly when a pasted Solana mint isn't on the lists", () => {
    expect(solanaMintQuery(` ${USDC_MINT} `)).toBe(USDC_MINT);
    expect(solanaMintQuery("usdc")).toBeNull();
    expect(solanaMintQuery("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")).toBeNull();
    expect(pickerMessage("ready", USDC_MINT)).toBe("No Solana token on Crossfare's lists has that mint address.");
  });
});
