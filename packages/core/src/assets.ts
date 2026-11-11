import { evmChainByCode, evmChainById } from "./evm-chains.ts";

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
  /** SwapKit identifier: `CHAIN.ASSET` or `CHAIN.ASSET-contract`. Absent for a token only Uniswap lists. */
  swapkit?: string;
  /** The chain name SwapKit's screening endpoint expects. */
  swapkitChain: string;
  /** Set for EVM chains, including those Uniswap isn't offered on. */
  evmChainId?: number;
  name?: string;
  logo?: string;
  /** Pasted by contract and on no token list, so callers should be warned. */
  unlisted?: true;
}

export interface Chain {
  id: string;
  name: string;
  logo?: string;
  /** Set for chains Uniswap trades on, which a wallet can sign on. */
  evmChainId?: number;
  explorer?: string;
}

const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";
const BASE_CHAIN_ID = 8453;
const ETHEREUM_CHAIN_ID = 1;

const BUILT_IN: readonly Asset[] = [
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

const LOGO_BASE = "https://tokens.swapkit.dev/images";
const logoFor = (identifier: string) => `${LOGO_BASE}/${identifier.toLowerCase()}.png`;

const withLogo = (asset: Asset): Asset => ({
  ...asset,
  ...(asset.swapkit ? { logo: logoFor(asset.swapkit) } : {}),
  ...(asset.uniswap ? { evmChainId: asset.uniswap.chainId } : {}),
});

let assets: readonly Asset[] = BUILT_IN.map(withLogo);
/** Tokens someone pasted by contract. They resolve, but aren't listed. */
let unlisted = new Map<AssetId, Asset>();
let byId = new Map<AssetId, Asset>();
let byContract = new Map<string, Asset>();

const contractKey = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`;

function index() {
  // Listed tokens go last, so they win a contract an unlisted one also names.
  const all = [...unlisted.values(), ...assets];
  byId = new Map(all.map((asset) => [asset.id, asset]));
  byContract = new Map(all.flatMap((asset) => (asset.uniswap ? [[contractKey(asset.uniswap.chainId, asset.uniswap.address), asset]] : [])));
}
index();

export function parseAssetId(id: string): { chain: string; symbol: string } {
  const match = /^([a-z0-9]+):([^\s:]+)$/.exec(id);
  if (!match) throw new Error(`Invalid asset id: ${id}`);
  return { chain: match[1]!, symbol: match[2]! };
}

export function getAsset(id: AssetId): Asset {
  parseAssetId(id);
  const asset = byId.get(id);
  if (!asset) throw new Error(`Unsupported asset: ${id}`);
  return asset;
}

export const listBuiltInAssets = (): readonly Asset[] => BUILT_IN;

/** A catalog can replace what's listed, but the built-in assets must always resolve: stored swaps name them. */
export function registerAssets(catalog: readonly Asset[]): void {
  const ids = new Set(catalog.map((asset) => asset.id));
  assets = [...catalog, ...BUILT_IN.filter((asset) => !ids.has(asset.id)).map(withLogo)];
  index();
}

export function addUnlistedAssets(list: readonly Asset[]): void {
  for (const asset of list) unlisted.set(asset.id, { ...asset, unlisted: true });
  index();
}

/** For tests. */
export function forgetUnlistedAssets(): void {
  unlisted = new Map();
  index();
}

const EVM_CONTRACT = /^0x[0-9a-fA-F]{40}$/;

/** `chain:0x…` names a token by contract, the way a DEX takes a pasted address. Only on Uniswap's chains. */
export function contractRef(id: string): { chainId: number; address: string } | null {
  const [chain, address] = id.split(":");
  const evm = chain ? evmChainByCode(chain) : undefined;
  return evm && address && EVM_CONTRACT.test(address) && id.split(":").length === 2 ? { chainId: evm.chainId, address } : null;
}

/**
 * A token's contract: its address on an EVM chain, or the rest of its SwapKit identifier
 * elsewhere, such as a Solana mint, with its case intact. Undefined for a native coin.
 */
export function assetContract(asset: Asset): string | undefined {
  if (asset.uniswap) return asset.uniswap.address.toLowerCase() === NATIVE_TOKEN ? undefined : asset.uniswap.address;
  const dash = asset.swapkit?.indexOf("-") ?? -1;
  return dash >= 0 ? asset.swapkit!.slice(dash + 1) : undefined;
}

export const findAssetByContract = (chainId: number, address: string): Asset | undefined => byContract.get(contractKey(chainId, address));

/** The ID of the token a `chain:0x…` reference names, if one is known. Any other ID comes back as given. */
export function resolveAssetId(id: string): AssetId {
  const ref = contractRef(id);
  return (ref && findAssetByContract(ref.chainId, ref.address)?.id) ?? id;
}

/** Numeric chain IDs that aren't EVM. */
const NON_EVM_CHAIN_IDS = ["728126428"];

/** Builds an asset from a SwapKit list entry. An asset Crossfare already knows keeps its own ID. */
export function catalogAsset(
  token: { chain: string; chainId: string; ticker: string; address?: string; identifier: string; name?: string; decimals: number; logoURI?: string },
  builtIn?: Asset,
): Asset {
  const evmChainId = /^\d+$/.test(token.chainId) && !NON_EVM_CHAIN_IDS.includes(token.chainId) ? Number(token.chainId) : undefined;
  const display = {
    ...(token.name ? { name: token.name } : {}),
    logo: token.logoURI ?? logoFor(token.identifier),
  };
  if (builtIn) return { ...withLogo(builtIn), ...display };
  const separator = token.identifier.indexOf(".");
  const chain = token.chain.toLowerCase();
  return {
    id: `${chain}:${token.identifier.slice(separator + 1).toLowerCase()}`,
    chain,
    symbol: token.ticker,
    decimals: token.decimals,
    swapkit: token.identifier,
    swapkitChain: token.chainId,
    ...(evmChainId === undefined ? {} : { evmChainId }),
    ...(evmChainId !== undefined && evmChainById(evmChainId)
      ? { uniswap: { chainId: evmChainId, address: token.address || NATIVE_TOKEN } }
      : {}),
    ...display,
  };
}

const CHAIN_NAMES: Record<string, string> = {
  adi: "ADI",
  ada: "Cardano",
  aleo: "Aleo",
  arb: "Arbitrum",
  arc: "Arc",
  avax: "Avalanche",
  base: "Base",
  bch: "Bitcoin Cash",
  bera: "Berachain",
  bsc: "BNB Chain",
  btc: "Bitcoin",
  dash: "Dash",
  doge: "Dogecoin",
  dot: "Polkadot",
  eth: "Ethereum",
  gaia: "Cosmos Hub",
  gno: "Gnosis",
  hype: "Hyperliquid",
  hyperevm: "HyperEVM",
  ltc: "Litecoin",
  maya: "Maya",
  monad: "Monad",
  near: "NEAR",
  op: "Optimism",
  pol: "Polygon",
  sol: "Solana",
  strk: "Starknet",
  sui: "Sui",
  thor: "THORChain",
  ton: "TON",
  tron: "Tron",
  xlayer: "X Layer",
  xlm: "Stellar",
  xrp: "XRP Ledger",
  zec: "Zcash",
};

export const chainName = (chain: string) => CHAIN_NAMES[chain] ?? evmChainByCode(chain)?.name ?? chain.toUpperCase();

/** Chains whose gas coin is ETH, so a native coin's logo would show ETH rather than the chain. */
const CHAIN_LOGOS: Record<string, string> = {
  base: "https://icons.llamao.fi/icons/chains/rsz_base.jpg",
  arb: "https://icons.llamao.fi/icons/chains/rsz_arbitrum.jpg",
  op: "https://icons.llamao.fi/icons/chains/rsz_optimism.jpg",
};

/** Chains that have assets, the busiest first. */
export function listChains(): Chain[] {
  const counts = new Map<string, number>();
  const natives = new Map<string, string>();
  for (const asset of assets) {
    counts.set(asset.chain, (counts.get(asset.chain) ?? 0) + 1);
    const native = asset.uniswap ? asset.uniswap.address === NATIVE_TOKEN : !asset.swapkit?.includes("-");
    if (asset.logo && native && !natives.has(asset.chain)) natives.set(asset.chain, asset.logo);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([id]) => {
      const logo = CHAIN_LOGOS[id] ?? natives.get(id);
      const evm = evmChainByCode(id);
      return {
        id,
        name: chainName(id),
        ...(logo ? { logo } : {}),
        ...(evm ? { evmChainId: evm.chainId, explorer: evm.explorer } : {}),
      };
    });
}

/** Tickers come in either form, and one with its own casing, such as cbBTC, should keep it. */
export const displaySymbol = (symbol: string) => (symbol === symbol.toLowerCase() ? symbol.toUpperCase() : symbol);

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ADDRESS_FORMATS: Record<string, RegExp> = {
  base: EVM_ADDRESS,
  eth: EVM_ADDRESS,
  btc: /^(bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/,
  sol: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  xrp: /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/,
  doge: /^[DA9][1-9A-HJ-NP-Za-km-z]{25,34}$/,
  ltc: /^(ltc1[a-z0-9]{25,62}|[LM3][1-9A-HJ-NP-Za-km-z]{25,34})$/,
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
};

/** A format check only: it catches a wrong chain or a typo'd length, not every bad address. */
export function isValidAddress(assetId: AssetId, address: string): boolean {
  const asset = getAsset(assetId);
  const format = asset.evmChainId === undefined ? ADDRESS_FORMATS[asset.chain] : EVM_ADDRESS;
  return format ? format.test(address) : address.length > 0;
}

export function listAssets(): readonly Asset[] {
  return assets;
}

/** Converts a decimal string to base units, dropping precision the asset can't hold. */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!match) throw new Error(`Invalid amount: ${JSON.stringify(amount)}`);
  const whole = match[1]!;
  const fraction = (match[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(whole + fraction);
}
