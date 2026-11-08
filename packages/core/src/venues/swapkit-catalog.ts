import { catalogAsset, listBuiltInAssets, type Asset } from "../assets.ts";
import type { FetchLike } from "./types.ts";

const API_URL = "https://api.swapkit.dev";
const LISTS_HOST = "tokens.swapkit.dev";
const CHECK_SECONDS = 30_000;

export interface CatalogToken {
  chain: string;
  chainId: string;
  ticker: string;
  address?: string;
  identifier: string;
  name?: string;
  decimals: number;
  logoURI?: string;
}

/** Spaces and colons would break an asset ID, and only a few odd listings have them. */
const usableIdentifier = (identifier: string) => /^[A-Za-z0-9]+\.[^\s:]+$/.test(identifier);

/**
 * Merges every provider's list into one catalog. A token can appear several times, in
 * different letter case, so it is keyed in lower case and ranked by how many list it.
 */
export function parseCatalog(lists: readonly (readonly CatalogToken[])[]): Asset[] {
  const merged = new Map<string, { token: CatalogToken; listedBy: number }>();
  for (const list of lists) {
    for (const token of list) {
      if (!usableIdentifier(token.identifier)) continue;
      const key = token.identifier.toLowerCase();
      const known = merged.get(key);
      if (!known) {
        merged.set(key, { token, listedBy: 1 });
        continue;
      }
      known.listedBy += 1;
      // Some chains' addresses are case-sensitive, so a mixed-case spelling is the safer one to keep.
      if (known.token.identifier === known.token.identifier.toLowerCase()) known.token = token;
    }
  }
  const ranked = [...merged.values()].sort((left, right) => {
    const native = Number(!left.token.address) - Number(!right.token.address);
    return native !== 0 ? -native : right.listedBy - left.listedBy;
  });
  const builtIn = new Map(listBuiltInAssets().map((asset) => [(asset.swapkit ?? "").toLowerCase(), asset]));
  return ranked.map(({ token }) => catalogAsset(token, builtIn.get(token.identifier.toLowerCase())));
}

export interface CatalogOptions {
  apiKey: string;
  fetch?: FetchLike;
}

/** Every token SwapKit lists. A provider whose list is down is skipped, since others may carry its tokens. */
export async function fetchSwapKitCatalog(options: CatalogOptions): Promise<Asset[]> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(`${API_URL}/providers`, {
    headers: { accept: "application/json", "x-api-key": options.apiKey },
    signal: AbortSignal.timeout(CHECK_SECONDS),
  });
  if (!response.ok) throw new Error(`/providers returned ${response.status}`);
  const providers = (await response.json()) as { url?: string }[];
  const urls = providers.flatMap((provider) => {
    try {
      return provider.url && new URL(provider.url).hostname === LISTS_HOST ? [provider.url] : [];
    } catch {
      return [];
    }
  });
  const lists = await Promise.allSettled(
    urls.map(async (url) => {
      const list = await fetchImpl(url, { signal: AbortSignal.timeout(CHECK_SECONDS) });
      if (!list.ok) throw new Error(`${url} returned ${list.status}`);
      return ((await list.json()) as { tokens?: CatalogToken[] }).tokens ?? [];
    }),
  );
  return parseCatalog(lists.flatMap((list) => (list.status === "fulfilled" ? [list.value] : [])));
}
