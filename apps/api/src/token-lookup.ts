import { addUnlistedAssets, evmChainById, findAssetByContract, uniswapTokenAsset, type Asset } from "@crossfare/core";
import type { Store } from "./store.ts";

export interface TokenMetadata {
  symbol: string;
  name: string;
  decimals: number;
}

/** Reads an ERC-20's details from the chain. Null when the address isn't a token; throws when the RPC fails. */
export type ReadToken = (chainId: number, address: string) => Promise<TokenMetadata | null>;

export interface TokenLookup {
  /** A token by contract on a Uniswap chain: from the catalog, or read from the chain and kept as unlisted. */
  find(chainId: number, address: string): Promise<Asset | null>;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Long enough to stop repeated lookups of a non-token, short enough that a new deployment shows up. */
const MISS_TTL_MS = 10 * 60_000;

/** A contract can name itself anything, including control characters or a paragraph. */
const tidy = (text: string, max: number) =>
  text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

export function createTokenLookup(options: { readToken: ReadToken; store: Store; now?: () => Date }): TokenLookup {
  const now = options.now ?? (() => new Date());
  const misses = new Map<string, number>();

  return {
    async find(chainId, address) {
      if (!evmChainById(chainId) || !EVM_ADDRESS.test(address)) return null;
      const known = findAssetByContract(chainId, address);
      if (known) return known;

      const key = `${chainId}:${address.toLowerCase()}`;
      const missedAt = misses.get(key);
      if (missedAt !== undefined && now().getTime() - missedAt < MISS_TTL_MS) return null;

      let metadata: TokenMetadata | null;
      try {
        metadata = await options.readToken(chainId, address);
      } catch {
        return null;
      }
      const symbol = metadata ? tidy(metadata.symbol, 32) || `${address.slice(0, 6)}…` : "";
      const asset = metadata && uniswapTokenAsset({ chainId, address, symbol, name: tidy(metadata.name, 64) || symbol, decimals: metadata.decimals });
      if (!asset) {
        misses.set(key, now().getTime());
        return null;
      }
      const token: Asset = { ...asset, unlisted: true };
      options.store.saveUnlistedAsset(token);
      addUnlistedAssets([token]);
      return token;
    },
  };
}
