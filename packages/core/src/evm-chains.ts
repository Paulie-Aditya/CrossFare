import type { Chain as ViemChain } from "viem";
import {
  arbitrum,
  arc,
  avalanche,
  base,
  bsc,
  celo,
  ink,
  linea,
  mainnet,
  megaeth,
  monad,
  optimism,
  polygon,
  robinhood,
  soneium,
  tempo,
  unichain,
  worldchain,
  xLayer,
  zksync,
  zora,
} from "viem/chains";

/**
 * Every mainnet the Uniswap Trading API trades on (developers.uniswap.org, Supported Chains,
 * read 2026-11-09). The code is the chain part of a Crossfare asset ID. Where SwapKit lists
 * the chain, the code is SwapKit's, so a token keeps one ID whichever list it came from.
 */
export interface EvmChain {
  code: string;
  chainId: number;
  name: string;
  /** Absent where gas is paid in a token rather than a native coin. */
  native?: { symbol: string; name: string; decimals: number };
  /** Only where its address was read on chain; native output is measured by its unwrap. */
  wrappedNative?: string;
  explorer: string;
  viem: ViemChain;
}

const OP_STACK_WETH = "0x4200000000000000000000000000000000000006";
const ether = { symbol: "eth", name: "Ethereum", decimals: 18 };

const chain = (code: string, name: string, viem: ViemChain, native: EvmChain["native"], wrappedNative?: string): EvmChain => ({
  code,
  chainId: viem.id,
  name,
  ...(native ? { native } : {}),
  ...(wrappedNative ? { wrappedNative } : {}),
  explorer: viem.blockExplorers?.default.url ?? "",
  viem,
});

export const UNISWAP_CHAINS: readonly EvmChain[] = [
  chain("eth", "Ethereum", mainnet, ether, "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
  chain("base", "Base", base, ether, OP_STACK_WETH),
  chain("arb", "Arbitrum", arbitrum, ether, "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"),
  chain("op", "Optimism", optimism, ether, OP_STACK_WETH),
  chain("pol", "Polygon", polygon, { symbol: "pol", name: "Polygon", decimals: 18 }, "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"),
  chain("bsc", "BNB Chain", bsc, { symbol: "bnb", name: "BNB", decimals: 18 }, "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"),
  chain("avax", "Avalanche", avalanche, { symbol: "avax", name: "Avalanche", decimals: 18 }, "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7"),
  chain("unichain", "Unichain", unichain, ether, OP_STACK_WETH),
  chain("monad", "Monad", monad, { symbol: "mon", name: "Monad", decimals: 18 }, "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A"),
  chain("xlayer", "X Layer", xLayer, { symbol: "okb", name: "OKB", decimals: 18 }, "0xe538905cf8410324e03A5A23C1c177a474D59b2b"),
  chain("zksync", "ZKsync", zksync, ether, "0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91"),
  chain("world", "World Chain", worldchain, ether, OP_STACK_WETH),
  chain("soneium", "Soneium", soneium, ether, OP_STACK_WETH),
  chain("tempo", "Tempo", tempo, undefined),
  chain("megaeth", "MegaETH", megaeth, ether, OP_STACK_WETH),
  chain("hood", "Robinhood Chain", robinhood, ether),
  chain("arc", "Arc", arc, undefined),
  chain("celo", "Celo", celo, { symbol: "celo", name: "Celo", decimals: 18 }),
  chain("ink", "Ink", ink, ether, OP_STACK_WETH),
  chain("linea", "Linea", linea, ether, "0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f"),
  chain("zora", "Zora", zora, ether, OP_STACK_WETH),
];

const byId = new Map(UNISWAP_CHAINS.map((entry) => [entry.chainId, entry]));
const byCode = new Map(UNISWAP_CHAINS.map((entry) => [entry.code, entry]));

export const evmChainById = (chainId: number): EvmChain | undefined => byId.get(chainId);
export const evmChainByCode = (code: string): EvmChain | undefined => byCode.get(code);
