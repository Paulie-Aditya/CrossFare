import { evmChainByCode, parseAssetId } from "@crossfare/core";

/**
 * A two-leg route can leave its hub as a chain's gas coin in the wallet, and the second leg's
 * transaction spends gas in that same coin. The agent keeps back what the gas needs.
 */

/** The chain and decimals of an asset that is a chain's gas coin, or null for a token. */
export function nativeHub(asset: string): { chainId: number; decimals: number } | null {
  const { chain, symbol } = parseAssetId(asset);
  const evm = evmChainByCode(chain);
  return evm?.native && evm.native.symbol === symbol ? { chainId: evm.chainId, decimals: evm.native.decimals } : null;
}

/**
 * How much of what arrived the second leg can spend. Gas comes first out of what the wallet held
 * before, then out of what arrived. Null when gas would take it all.
 */
export function spendableAfterGas(received: bigint, balance: bigint, gasCost: bigint): bigint | null {
  const spare = balance - received;
  if (spare >= gasCost) return received;
  const amount = received - (gasCost - (spare > 0n ? spare : 0n));
  return amount > 0n ? amount : null;
}
