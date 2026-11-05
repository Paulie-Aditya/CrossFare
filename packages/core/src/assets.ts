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
  },
  {
    id: "base:usdc",
    chain: "base",
    symbol: "usdc",
    decimals: 6,
    uniswap: { chainId: BASE_CHAIN_ID, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    swapkit: "BASE.USDC-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  },
  {
    id: "eth:eth",
    chain: "eth",
    symbol: "eth",
    decimals: 18,
    uniswap: { chainId: ETHEREUM_CHAIN_ID, address: NATIVE_TOKEN },
    swapkit: "ETH.ETH",
  },
  {
    id: "eth:usdc",
    chain: "eth",
    symbol: "usdc",
    decimals: 6,
    uniswap: { chainId: ETHEREUM_CHAIN_ID, address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
    swapkit: "ETH.USDC-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  },
  { id: "btc:btc", chain: "btc", symbol: "btc", decimals: 8, swapkit: "BTC.BTC" },
  { id: "sol:sol", chain: "sol", symbol: "sol", decimals: 9, swapkit: "SOL.SOL" },
  { id: "xrp:xrp", chain: "xrp", symbol: "xrp", decimals: 6, swapkit: "XRP.XRP" },
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
