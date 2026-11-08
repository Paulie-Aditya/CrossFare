import type { Chain } from "viem";
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

/** Every chain the API quotes Uniswap on, by the code in Crossfare asset IDs. A test keeps it matching the API. */
export const WALLET_CHAINS = [
  { code: "eth", chain: mainnet },
  { code: "base", chain: base },
  { code: "arb", chain: arbitrum },
  { code: "op", chain: optimism },
  { code: "pol", chain: polygon },
  { code: "bsc", chain: bsc },
  { code: "avax", chain: avalanche },
  { code: "unichain", chain: unichain },
  { code: "monad", chain: monad },
  { code: "xlayer", chain: xLayer },
  { code: "zksync", chain: zksync },
  { code: "world", chain: worldchain },
  { code: "soneium", chain: soneium },
  { code: "tempo", chain: tempo },
  { code: "megaeth", chain: megaeth },
  { code: "hood", chain: robinhood },
  { code: "arc", chain: arc },
  { code: "celo", chain: celo },
  { code: "ink", chain: ink },
  { code: "linea", chain: linea },
  { code: "zora", chain: zora },
] as const satisfies readonly { code: string; chain: Chain }[];

const byCode = new Map<string, Chain>(WALLET_CHAINS.map((entry) => [entry.code, entry.chain]));

export const walletChain = (code: string): Chain | undefined => byCode.get(code);
