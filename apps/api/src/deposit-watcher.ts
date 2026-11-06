import { getAsset, toBaseUnits, type Deposit } from "@crossfare/core";

export interface ChainBalances {
  tokenBalance(token: string, holder: string): Promise<bigint>;
  nativeBalance(holder: string): Promise<bigint>;
}

const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";

/**
 * Reads the deposit address directly, because a provider's tracker can take most of a
 * swap to report a deposit. An exchange's fee trims what arrives, and leftover dust
 * must not look like a deposit, so half the amount is the line.
 */
export function createDepositWatcher(readers: Record<number, ChainBalances>) {
  return async (deposit: Pick<Deposit, "asset" | "address" | "amount">): Promise<boolean> => {
    const asset = getAsset(deposit.asset);
    const reader = asset.uniswap && readers[asset.uniswap.chainId];
    if (!asset.uniswap || !reader) return false;
    const balance =
      asset.uniswap.address === NATIVE_TOKEN
        ? await reader.nativeBalance(deposit.address)
        : await reader.tokenBalance(asset.uniswap.address, deposit.address);
    return balance > 0n && balance * 2n >= toBaseUnits(deposit.amount, asset.decimals);
  };
}
