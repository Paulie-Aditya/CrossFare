import { fromBaseUnits, getAsset, type Deposit } from "@crossfare/core";

export interface ChainBalances {
  tokenBalance(token: string, holder: string): Promise<bigint>;
  nativeBalance(holder: string): Promise<bigint>;
}

const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";

/**
 * Reads the deposit address directly, because a provider's tracker can take most of a
 * swap to report a deposit. It answers with what's there, or null for nothing or a chain
 * it can't read, and leaves deciding whether that's enough to the caller.
 */
export function createDepositWatcher(readers: Record<number, ChainBalances>) {
  return async (deposit: Pick<Deposit, "asset" | "address">): Promise<string | null> => {
    const asset = getAsset(deposit.asset);
    const reader = asset.uniswap && readers[asset.uniswap.chainId];
    if (!asset.uniswap || !reader) return null;
    const balance =
      asset.uniswap.address === NATIVE_TOKEN
        ? await reader.nativeBalance(deposit.address)
        : await reader.tokenBalance(asset.uniswap.address, deposit.address);
    return balance > 0n ? fromBaseUnits(balance.toString(), asset.decimals) : null;
  };
}
