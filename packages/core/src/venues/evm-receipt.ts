import type { UniswapToken } from "../assets.ts";
import { evmChainById } from "../evm-chains.ts";

const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";

/** Reading what an EVM swap delivered from its receipt, shared by the venues whose swaps are contract calls. */

export interface ChainLog {
  address: string;
  topics: readonly string[];
  data: string;
}

export interface ChainReceipt {
  status: "success" | "reverted";
  from: string;
  to: string | null;
  logs: readonly ChainLog[];
}

export type GetReceipt = (chainId: number, hash: string) => Promise<ChainReceipt | null>;

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const WETH_WITHDRAWAL_TOPIC = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";

export const sameAddress = (a: string | null | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
const topicAddress = (topic: string | undefined) => `0x${(topic ?? "").slice(-40)}`;

/**
 * Native output arrives through an internal call, which leaves no log of its own,
 * so the wrapped coin's unwrap stands in for the amount delivered, less the share the router
 * then pays an integrator fee. Null where that coin isn't known.
 */
export function deliveredAmount(receipt: ChainReceipt, token: UniswapToken, recipient: string, feeBps: number): bigint | null {
  const native = token.address === NATIVE_TOKEN;
  const wrapped = evmChainById(token.chainId)?.wrappedNative ?? "";
  if (native && !wrapped) return null;
  const total = receipt.logs.reduce((sum, log) => {
    if (native) {
      const isUnwrap = sameAddress(log.address, wrapped) && log.topics[0] === WETH_WITHDRAWAL_TOPIC;
      return isUnwrap ? sum + BigInt(log.data) : sum;
    }
    const isTransfer =
      sameAddress(log.address, token.address) &&
      log.topics[0] === TRANSFER_TOPIC &&
      sameAddress(topicAddress(log.topics[2]), recipient);
    return isTransfer ? sum + BigInt(log.data) : sum;
  }, 0n);
  return native ? total - (total * BigInt(feeBps)) / 10_000n : total;
}
