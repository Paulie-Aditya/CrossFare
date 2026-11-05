/** Crossfare asset IDs have the form `chain:symbol`, for example `base:usdc`. */
export type AssetId = string;

export interface UniswapToken {
  chainId: number;
  address: string;
}

export interface Asset {
  id: AssetId;
  chain: string;
  symbol: string;
  decimals: number;
  /** Present only where Uniswap can trade the asset. */
  uniswap?: UniswapToken;
  /** SwapKit identifier: `CHAIN.ASSET` or `CHAIN.ASSET-contract`. */
  swapkit: string;
  /** The chain name SwapKit's screening endpoint expects. */
  swapkitChain: string;
}

const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";
const BASE_CHAIN_ID = 8453;
const ETHEREUM_CHAIN_ID = 1;

const ASSETS: readonly Asset[] = [
  {
    id: "base:eth",
    chain: "base",
    symbol: "eth",
    decimals: 18,
    uniswap: { chainId: BASE_CHAIN_ID, address: NATIVE_TOKEN },
    swapkit: "BASE.ETH",
    swapkitChain: "8453",
  },
  {
    id: "base:usdc",
    chain: "base",
    symbol: "usdc",
    decimals: 6,
    uniswap: { chainId: BASE_CHAIN_ID, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    swapkit: "BASE.USDC-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    swapkitChain: "8453",
  },
  {
    id: "eth:eth",
    chain: "eth",
    symbol: "eth",
    decimals: 18,
    uniswap: { chainId: ETHEREUM_CHAIN_ID, address: NATIVE_TOKEN },
    swapkit: "ETH.ETH",
    swapkitChain: "1",
  },
  {
    id: "eth:usdc",
    chain: "eth",
    symbol: "usdc",
    decimals: 6,
    uniswap: { chainId: ETHEREUM_CHAIN_ID, address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
    swapkit: "ETH.USDC-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    swapkitChain: "1",
  },
  { id: "btc:btc", chain: "btc", symbol: "btc", decimals: 8, swapkit: "BTC.BTC", swapkitChain: "bitcoin" },
  { id: "sol:sol", chain: "sol", symbol: "sol", decimals: 9, swapkit: "SOL.SOL", swapkitChain: "solana" },
  { id: "xrp:xrp", chain: "xrp", symbol: "xrp", decimals: 6, swapkit: "XRP.XRP", swapkitChain: "ripple" },
];

const BY_ID = new Map(ASSETS.map((asset) => [asset.id, asset]));

export function parseAssetId(id: string): { chain: string; symbol: string } {
  const match = /^([a-z0-9]+):([a-z0-9]+)$/.exec(id);
  if (!match) throw new Error(`Invalid asset id: ${id}`);
  return { chain: match[1]!, symbol: match[2]! };
}

export function getAsset(id: AssetId): Asset {
  parseAssetId(id);
  const asset = BY_ID.get(id);
  if (!asset) throw new Error(`Unsupported asset: ${id}`);
  return asset;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ADDRESS_FORMATS: Record<string, RegExp> = {
  base: EVM_ADDRESS,
  eth: EVM_ADDRESS,
  btc: /^(bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/,
  sol: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  xrp: /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/,
};

/** A format check only: it catches a wrong chain or a typo'd length, not every bad address. */
export function isValidAddress(assetId: AssetId, address: string): boolean {
  const format = ADDRESS_FORMATS[getAsset(assetId).chain];
  return format ? format.test(address) : address.length > 0;
}

export function listAssets(): readonly Asset[] {
  return ASSETS;
}

/** Converts a decimal string to base units, dropping precision the asset can't hold. */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!match) throw new Error(`Invalid amount: ${JSON.stringify(amount)}`);
  const whole = match[1]!;
  const fraction = (match[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(whole + fraction);
}
