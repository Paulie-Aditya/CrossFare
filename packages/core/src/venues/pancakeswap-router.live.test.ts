import { createPublicClient, http, type PublicClient } from "viem";
import { bsc } from "viem/chains";
import { describe, expect, it } from "vitest";
import { createPancakeRouter, decodeRouterCommands } from "./pancakeswap-router.ts";

// Reads BNB Chain's public RPC and spends nothing. Opt in with CROSSFARE_LIVE_TESTS=true.
const live = process.env.CROSSFARE_LIVE_TESTS === "true";

const AGENT = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const FEE_WALLET = "0x1111111111111111111111111111111111111111";
const BNB = { address: "0x0000000000000000000000000000000000000000", decimals: 18, symbol: "BNB" };
const USDT = { address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, symbol: "USDT" };

describe.runIf(live)("PancakeSwap router on BNB Chain (live)", () => {
  const client = createPublicClient({
    chain: bsc,
    transport: http(process.env.RPC_URL_56 ?? "https://bsc-dataseed.bnbchain.org"),
    batch: { multicall: { batchSize: 200_000 } },
  }) as PublicClient;
  const router = createPancakeRouter({ clientFor: (chainId) => (chainId === 56 ? client : undefined) });

  it("quotes BNB to USDT and builds a call that pays the caller's fee before sweeping the rest", async () => {
    const quote = await router.quote({
      chainId: 56,
      tokenIn: BNB,
      tokenOut: USDT,
      amountIn: 10n ** 17n,
      slippageBps: 100,
      recipient: AGENT,
      fee: { bps: 50, recipient: FEE_WALLET },
    });
    expect(quote).not.toBeNull();
    expect(quote!.amountOut).toBeGreaterThan(quote!.minAmountOut);
    expect(quote!.transaction?.to).toBe("0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB");
    expect(BigInt(quote!.transaction!.value)).toBe(10n ** 17n);
    const commands = decodeRouterCommands(quote!.transaction!.data);
    expect(commands.slice(-2)).toEqual(["PAY_PORTION", "SWEEP"]);
  }, 60_000);

  it("prices without building a call when there's no recipient", async () => {
    const quote = await router.quote({ chainId: 56, tokenIn: USDT, tokenOut: BNB, amountIn: 10n ** 19n, slippageBps: 50 });
    expect(quote?.amountOut).toBeGreaterThan(0n);
    expect(quote?.transaction).toBeUndefined();
  }, 60_000);
});
