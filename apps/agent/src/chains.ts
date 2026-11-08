import type { Chain } from "viem";
import { evmChainById } from "@crossfare/core";

/** RPC endpoints by chain ID. A chain without one uses its public RPC. */
export type RpcUrls = Record<number, string>;

/** The agent signs on the chains Crossfare quotes Uniswap on. Anything else is refused, not guessed at. */
export function chainFor(chainId: number, rpcUrls: RpcUrls): { chain: Chain; rpcUrl: string } {
  const evm = evmChainById(chainId);
  const rpcUrl = rpcUrls[chainId] ?? evm?.viem.rpcUrls.default.http[0];
  if (!evm || !rpcUrl) throw new Error(`Agent only signs on chains Uniswap trades on, not ${chainId}`);
  return { chain: evm.viem, rpcUrl };
}
