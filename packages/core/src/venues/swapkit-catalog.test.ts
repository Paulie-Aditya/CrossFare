import { describe, expect, it, vi } from "vitest";
import { getAsset, isValidAddress, listAssets, listChains, registerAssets } from "../assets.ts";
import { fetchSwapKitCatalog, parseCatalog } from "./swapkit-catalog.ts";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const token = (chain: string, chainId: string, ticker: string, address = "", extra: object = {}) => ({
  chain,
  chainId,
  ticker,
  address,
  identifier: `${chain}.${ticker}${address ? `-${address}` : ""}`,
  name: `${ticker} name`,
  decimals: 18,
  logoURI: `https://tokens.swapkit.dev/images/${chain}.${ticker}.png`.toLowerCase(),
  ...extra,
});

describe("parseCatalog", () => {
  it("keeps Crossfare's own ids for assets it already knows", () => {
    const [asset] = parseCatalog([[token("ETH", "1", "USDC", USDC, { decimals: 6, name: "USD Coin" })]]);
    expect(asset).toMatchObject({ id: "eth:usdc", name: "USD Coin", uniswap: { chainId: 1, address: USDC } });
    expect(asset?.logo).toContain("tokens.swapkit.dev");
  });

  it("gives a new token an id that holds its contract, because tickers repeat on a chain", () => {
    const address = "0x6314C31A7a1652cE482cffe247E9CB7c3f4BB9aF";
    const [asset] = parseCatalog([[token("ARB", "42161", "1INCH", address)]]);
    expect(asset).toMatchObject({
      id: `arb:1inch-${address.toLowerCase()}`,
      chain: "arb",
      symbol: "1INCH",
      swapkit: `ARB.1INCH-${address}`,
      swapkitChain: "42161",
      evmChainId: 42161,
      decimals: 18,
    });
  });

  it("offers Uniswap on every chain Uniswap trades on, and only there", () => {
    const address = "0x1111111111111111111111111111111111111111";
    const [onBase, onArbitrum, onGnosis] = parseCatalog([
      [token("BASE", "8453", "AERO", address), token("ARB", "42161", "AERO", address), token("GNO", "100", "AERO", address)],
    ]);
    expect(onBase?.uniswap).toEqual({ chainId: 8453, address });
    expect(onArbitrum?.uniswap).toEqual({ chainId: 42161, address });
    expect(onGnosis?.uniswap).toBeUndefined();
    expect(onGnosis?.evmChainId).toBe(100);
  });

  it("doesn't treat Tron's numeric chain id as EVM", () => {
    const [asset] = parseCatalog([[token("TRON", "728126428", "TRX")]]);
    expect(asset?.evmChainId).toBeUndefined();
  });

  it("merges one token listed by several providers, in any letter case", () => {
    const mixed = "0xAbCdEf0000000000000000000000000000000000";
    const assets = parseCatalog([[token("BSC", "56", "CAKE", mixed)], [token("BSC", "56", "CAKE", mixed.toLowerCase())]]);
    expect(assets).toHaveLength(1);
    expect(assets[0]?.swapkit).toContain(mixed);
  });

  it("ranks native coins first, then what the most providers carry", () => {
    const assets = parseCatalog([
      [token("ETH", "1", "RARE", "0x2222222222222222222222222222222222222222"), token("ETH", "1", "POPULAR", "0x3333333333333333333333333333333333333333")],
      [token("ETH", "1", "POPULAR", "0x3333333333333333333333333333333333333333"), token("BTC", "bitcoin", "BTC")],
    ]);
    expect(assets.map((asset) => asset.symbol.toUpperCase())).toEqual(["BTC", "POPULAR", "RARE"]);
  });

  it("skips identifiers that can't be an asset id", () => {
    expect(parseCatalog([[token("ETH", "1", "RK:ETH", "0x1"), token("BASE", "8453", "WLFI ", "0x2")]])).toEqual([]);
  });
});

describe("registerAssets", () => {
  it("adds tokens beside the built-in assets, and knows their address format", () => {
    const address = "0x6314C31A7a1652cE482cffe247E9CB7c3f4BB9aF";
    registerAssets(parseCatalog([[token("ARB", "42161", "1INCH", address), token("DOGE", "dogecoin", "DOGE")]]));
    expect(getAsset(`arb:1inch-${address.toLowerCase()}`).decimals).toBe(18);
    expect(getAsset("base:usdc").decimals).toBe(6);
    expect(listAssets().some((asset) => asset.id === "doge:doge")).toBe(true);
    expect(isValidAddress(`arb:1inch-${address.toLowerCase()}`, address)).toBe(true);
    expect(isValidAddress(`arb:1inch-${address.toLowerCase()}`, "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")).toBe(false);
    expect(isValidAddress("doge:doge", "DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L")).toBe(true);
    expect(isValidAddress("doge:doge", USDC)).toBe(false);
  });

  it("names each chain, and gives gas-in-ETH chains their own logo rather than ETH's", () => {
    registerAssets(parseCatalog([[token("ARB", "42161", "ETH"), token("DOGE", "dogecoin", "DOGE"), token("XYZ", "999", "XYZ")]]));
    const chains = listChains();
    expect(chains.find((chain) => chain.id === "arb")).toMatchObject({ name: "Arbitrum" });
    expect(chains.find((chain) => chain.id === "arb")?.logo).not.toContain("arb.eth");
    expect(chains.find((chain) => chain.id === "doge")).toMatchObject({ name: "Dogecoin", logo: expect.stringContaining("doge.doge") });
    expect(chains.find((chain) => chain.id === "xyz")?.name).toBe("XYZ");
  });
});

describe("fetchSwapKitCatalog", () => {
  const providers = [
    { name: "NEAR", url: "https://tokens.swapkit.dev/near.json" },
    { name: "DOWN", url: "https://tokens.swapkit.dev/down.json" },
    { name: "ELSEWHERE", url: "https://evil.example/list.json" },
  ];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("reads the static lists, which don't count against the API's rate limit", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/providers")) return json(providers);
      if (url.endsWith("near.json")) return json({ tokens: [token("BTC", "bitcoin", "BTC")] });
      return json({}, 500);
    });
    const assets = await fetchSwapKitCatalog({ apiKey: "k", fetch: fetch as never });
    expect(assets.map((asset) => asset.id)).toEqual(["btc:btc"]);
    expect(fetch).not.toHaveBeenCalledWith("https://evil.example/list.json", expect.anything());
  });

  it("fails loudly when the provider list is unavailable", async () => {
    await expect(fetchSwapKitCatalog({ apiKey: "k", fetch: (async () => json({}, 503)) as never })).rejects.toThrow(/providers/);
  });
});
