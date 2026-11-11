export interface AssetOption {
  id: string;
  chain: string;
  symbol: string;
  name: string;
  decimals: number;
  evm: boolean;
  logo?: string;
  venues: string[];
  /** False for a token found by contract that's on no token list. */
  verified?: boolean;
  /** Its EVM address or Solana mint. Absent for a native coin. */
  contract?: string;
}

export interface ChainOption {
  id: string;
  name: string;
  logo?: string;
}

let assets = new Map<string, AssetOption>();
let chains = new Map<string, ChainOption>();

export function setBook(list: readonly AssetOption[], chainList: readonly ChainOption[]) {
  assets = new Map(list.map((asset) => [asset.id, asset]));
  chains = new Map(chainList.map((chain) => [chain.id, chain]));
}

/** Tickers come in either form, and one with its own casing, such as cbBTC, should keep it. */
export const displaySymbol = (symbol: string) => (symbol === symbol.toLowerCase() ? symbol.toUpperCase() : symbol);

/** A record can outlive a token's listing, so an unknown ID still reads as well as it can. */
export function symbolOf(id: string): string {
  const known = assets.get(id);
  if (known) return displaySymbol(known.symbol);
  return (id.split(":")[1]?.split("-")[0] ?? id).toUpperCase();
}

export function chainNameOf(id: string): string {
  const chain = id.split(":")[0] ?? "";
  return chains.get(chain)?.name ?? chain.toUpperCase();
}

export const chainLabel = (chain: string) => chains.get(chain)?.name ?? chain.toUpperCase();
export const logoOf = (id: string) => assets.get(id)?.logo;
export const chainLogoOf = (chain: string) => chains.get(chain)?.logo;
export const isEvmAsset = (id: string) => assets.get(id)?.evm ?? false;
export const isUnverified = (id: string) => assets.get(id)?.verified === false;

/** A token found by contract joins the book, so it reads by name everywhere once picked. */
export function addAssets(list: readonly AssetOption[]) {
  for (const asset of list) assets.set(asset.id, asset);
}

/** The contract at the end of a token's ID, for telling apart tokens that share a ticker. Empty for a native coin. */
export const contractOf = (id: string) => /0x[0-9a-fA-F]{40}$/.exec(id)?.[0] ?? id.split(":")[1]?.split("-").slice(1).join("-") ?? "";

/** A whole contract address, which the picker looks up when the list doesn't have it. */
export function contractQuery(query: string): string | null {
  const trimmed = query.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(trimmed) ? trimmed : null;
}

/** A whole Solana mint address. Tokens off Crossfare's lists can't be looked up there yet. */
export function solanaMintQuery(query: string): string | null {
  const trimmed = query.trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed) ? trimmed : null;
}

/** A long list draws slowly, and nobody scrolls thousands of tokens: they search. */
const SHOWN_AT_ONCE = 80;

export function filterAssets(list: readonly AssetOption[], query: string, chain: string | null, limit = SHOWN_AT_ONCE) {
  const words = query.trim().toLowerCase();
  const inChain = chain ? list.filter((asset) => asset.chain === chain) : list;
  if (!words) return { shown: inChain.slice(0, limit), total: inChain.length };
  const score = (asset: AssetOption) => {
    const symbol = asset.symbol.toLowerCase();
    const contract = asset.contract?.toLowerCase();
    // A pasted address names one token, so it goes ahead of anything that merely looks like it.
    if (contract && contract === words) return -1;
    if (symbol === words) return 0;
    if (symbol.startsWith(words)) return 1;
    if (asset.name.toLowerCase().includes(words)) return 2;
    return asset.id.includes(words) || (!!contract && words.length >= 4 && contract.includes(words)) ? 3 : 4;
  };
  const found = inChain
    .map((asset, index) => ({ asset, index, rank: score(asset) }))
    .filter((entry) => entry.rank < 4)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.asset);
  return { shown: found.slice(0, limit), total: found.length };
}

export type CatalogStatus = "loading" | "ready" | "failed";

/** An empty picker can mean the list never arrived, which a person can't fix by searching differently. */
export function pickerMessage(status: CatalogStatus, query: string): string {
  if (status === "loading") return "Loading tokens.";
  if (status === "failed") return "Tokens can't load because Crossfare's API isn't answering. This retries by itself.";
  if (solanaMintQuery(query)) return "No Solana token on Crossfare's lists has that mint address.";
  return "No token matches that. Check the spelling, or paste its contract address.";
}

