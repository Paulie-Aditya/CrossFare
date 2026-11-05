import type { Chain } from "viem";
import { base, mainnet } from "viem/chains";

export interface RpcUrls {
  ethereum: string;
  base: string;
}

/** The chains this agent will sign on. Anything else is refused, not guessed at. */
export function chainFor(chainId: number, rpcUrls: RpcUrls): { chain: Chain; rpcUrl: string } {
  if (chainId === mainnet.id) return { chain: mainnet, rpcUrl: rpcUrls.ethereum };
  if (chainId === base.id) return { chain: base, rpcUrl: rpcUrls.base };
  throw new Error(`Agent only signs on Ethereum and Base, not ${chainId}`);
}
