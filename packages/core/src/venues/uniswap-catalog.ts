import type { Asset } from "../assets.ts";
import { UNISWAP_CHAINS, evmChainById } from "../evm-chains.ts";
import type { FetchLike } from "./types.ts";

const LIST_URL = "https://tokens.uniswap.org";
const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const FETCH_TIMEOUT_MS = 30_000;

export interface TokenListEntry {
  chainId: number;
  address: string;
  symbol: string;
  name?: string;
  decimals: number;
  logoURI?: string;
}

/** An asset ID can't hold spaces or colons, and a ticker can be anything. */
const slug = (symbol: string) => symbol.toLowerCase().replace(/[\s:]+/g, "") || "token";

const browserLogo = (uri: string | undefined) => (uri?.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${uri.slice("ipfs://".length)}` : uri);

/** Builds an asset for any ERC-20 on a Uniswap chain. Its ID matches the form SwapKit's tokens get. */
export function uniswapTokenAsset(token: TokenListEntry): Asset | null {
  const chain = evmChainById(token.chainId);
  const decimalsOk = Number.isInteger(token.decimals) && token.decimals >= 0 && token.decimals <= 36;
  if (!chain || !EVM_ADDRESS.test(token.address) || !decimalsOk || typeof token.symbol !== "string") return null;
  const logo = browserLogo(token.logoURI);
  return {
    id: `${chain.code}:${slug(token.symbol)}-${token.address.toLowerCase()}`,
    chain: chain.code,
    symbol: token.symbol,
    ...(token.name ? { name: token.name } : {}),
    decimals: token.decimals,
    ...(logo ? { logo } : {}),
    evmChainId: chain.chainId,
    uniswap: { chainId: chain.chainId, address: token.address },
    swapkitChain: String(chain.chainId),
  };
}

export function parseUniswapTokenList(list: { tokens?: readonly TokenListEntry[] }): Asset[] {
  return (list.tokens ?? []).flatMap((token) => uniswapTokenAsset(token) ?? []);
}

/** The gas coin of every Uniswap chain, which no token list carries for the newer chains. */
export function nativeAssets(): Asset[] {
  return UNISWAP_CHAINS.flatMap((chain) =>
    chain.native
      ? [
          {
            id: `${chain.code}:${chain.native.symbol}`,
            chain: chain.code,
            symbol: chain.native.symbol,
            name: chain.native.name,
            decimals: chain.native.decimals,
            evmChainId: chain.chainId,
            uniswap: { chainId: chain.chainId, address: NATIVE_TOKEN },
            swapkitChain: String(chain.chainId),
          },
        ]
      : [],
  );
}

const contractKey = (asset: Asset) => (asset.uniswap ? `${asset.uniswap.chainId}:${asset.uniswap.address.toLowerCase()}` : null);
const isNative = (asset: Asset) => asset.uniswap?.address === NATIVE_TOKEN || (!asset.uniswap && !asset.swapkit?.includes("-"));

/**
 * The first list wins a token both carry, so SwapKit's entry, which both venues can route,
 * is kept. Native coins come first, as they do in each list.
 */
export function mergeCatalogs(...lists: readonly (readonly Asset[])[]): Asset[] {
  const ids = new Set<string>();
  const contracts = new Set<string>();
  const merged: Asset[] = [];
  for (const list of lists) {
    for (const asset of list) {
      const key = contractKey(asset);
      if (ids.has(asset.id) || (key && contracts.has(key))) continue;
      ids.add(asset.id);
      if (key) contracts.add(key);
      merged.push(asset);
    }
  }
  return [...merged.filter(isNative), ...merged.filter((asset) => !isNative(asset))];
}

export async function fetchUniswapTokenList(options: { fetch?: FetchLike } = {}): Promise<Asset[]> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(LIST_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${LIST_URL} returned ${response.status}`);
  return parseUniswapTokenList((await response.json()) as { tokens?: TokenListEntry[] });
}
