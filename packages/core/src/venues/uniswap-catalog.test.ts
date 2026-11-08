import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogAsset, getAsset, listChains, registerAssets } from "../assets.ts";
import type { FetchLike } from "./types.ts";
import { fetchUniswapTokenList, mergeCatalogs, nativeAssets, parseUniswapTokenList } from "./uniswap-catalog.ts";

const NATIVE = "0x0000000000000000000000000000000000000000";
const entry = (chainId: number, symbol: string, address: string, extra: object = {}) => ({
  chainId,
  address,
  symbol,
  name: `${symbol} token`,
  decimals: 18,
  ...extra,
});

describe("parseUniswapTokenList", () => {
  it("builds an asset Uniswap can trade, with an ID that holds its contract", () => {
    const address = "0x078D782b760474a361dDA0AF3839290b0EF57AD6";
    const [asset] = parseUniswapTokenList({ tokens: [entry(130, "USDC", address, { decimals: 6, logoURI: "https://logo.example/usdc.png" })] });
    expect(asset).toEqual({
      id: `unichain:usdc-${address.toLowerCase()}`,
      chain: "unichain",
      symbol: "USDC",
      name: "USDC token",
      decimals: 6,
      logo: "https://logo.example/usdc.png",
      evmChainId: 130,
      uniswap: { chainId: 130, address },
      swapkitChain: "130",
    });
    expect(asset).not.toHaveProperty("swapkit");
  });

  it("skips chains Uniswap doesn't trade on, testnets and malformed entries", () => {
    const assets = parseUniswapTokenList({
      tokens: [
        entry(11155111, "USDC", "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"),
        entry(501000101, "SOL", "So11111111111111111111111111111111111111112"),
        entry(1, "BAD", "0x123"),
        entry(1, "NODEC", "0x1111111111111111111111111111111111111111", { decimals: 99 }),
      ],
    });
    expect(assets).toEqual([]);
  });

  it("makes a usable ID from a ticker with spaces, colons or odd capitals", () => {
    const address = "0x2222222222222222222222222222222222222222";
    const [spaced, empty] = parseUniswapTokenList({
      tokens: [entry(8453, "Wrapped A:B", address), entry(8453, " ", "0x3333333333333333333333333333333333333333")],
    });
    expect(spaced?.id).toBe(`base:wrappedab-${address}`);
    expect(spaced?.symbol).toBe("Wrapped A:B");
    expect(empty?.id).toBe("base:token-0x3333333333333333333333333333333333333333");
  });

  it("serves an IPFS logo through a gateway, since browsers can't load ipfs://", () => {
    const [asset] = parseUniswapTokenList({ tokens: [entry(1, "X", "0x4444444444444444444444444444444444444444", { logoURI: "ipfs://QmHash" })] });
    expect(asset?.logo).toBe("https://ipfs.io/ipfs/QmHash");
  });
});

describe("nativeAssets", () => {
  it("gives every Uniswap chain with a gas coin its native asset", () => {
    const natives = nativeAssets();
    expect(natives.find((asset) => asset.id === "unichain:eth")).toMatchObject({
      chain: "unichain",
      symbol: "eth",
      name: "Ethereum",
      decimals: 18,
      evmChainId: 130,
      uniswap: { chainId: 130, address: NATIVE },
    });
    expect(natives.find((asset) => asset.chain === "tempo")).toBeUndefined();
  });
});

describe("mergeCatalogs", () => {
  const swapkitUsdc = catalogAsset({
    chain: "ARB",
    chainId: "42161",
    ticker: "USDC",
    address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    identifier: "ARB.USDC-0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    decimals: 6,
  });

  it("keeps SwapKit's entry when both lists carry a token, so SwapKit can still route it", () => {
    const uniswapCopy = parseUniswapTokenList({ tokens: [entry(42161, "USDC", "0xaf88d065e77c8cc2239327c5edb3a432268e5831", { decimals: 6 })] })[0];
    const merged = mergeCatalogs([swapkitUsdc], [uniswapCopy!]);
    expect(merged).toEqual([swapkitUsdc]);
  });

  it("adds what only Uniswap lists, and native coins SwapKit lacks, natives first", () => {
    const [extra] = parseUniswapTokenList({ tokens: [entry(130, "UNI", "0x8f187aA05619a017077f5308904739877ce9eA21")] });
    const merged = mergeCatalogs([swapkitUsdc], [extra!], nativeAssets());
    const ids = merged.map((asset) => asset.id);
    expect(ids).toContain("unichain:eth");
    expect(ids).toContain("unichain:uni-0x8f187aa05619a017077f5308904739877ce9ea21");
    expect(ids.indexOf("unichain:eth")).toBeLessThan(ids.indexOf(swapkitUsdc.id));
  });
});

describe("a catalog with Uniswap-only tokens", () => {
  afterEach(() => registerAssets([]));

  it("names and lists a chain only Uniswap knows", () => {
    registerAssets(mergeCatalogs([], nativeAssets()));
    expect(getAsset("zora:eth").uniswap?.chainId).toBe(7777777);
    expect(listChains().find((chain) => chain.id === "zora")?.name).toBe("Zora");
  });
});

describe("fetchUniswapTokenList", () => {
  it("reads Uniswap's default list", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ tokens: [entry(10, "OP", "0x4200000000000000000000000000000000000042")] })));
    const assets = await fetchUniswapTokenList({ fetch });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://tokens.uniswap.org");
    expect(assets.map((asset) => asset.id)).toEqual(["op:op-0x4200000000000000000000000000000000000042"]);
  });

  it("fails loudly on an error, so the caller keeps the last list", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response("down", { status: 503 }));
    await expect(fetchUniswapTokenList({ fetch })).rejects.toThrow(/503/);
  });
});
