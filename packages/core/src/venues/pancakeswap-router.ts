import { createRequire } from "node:module";
import type { PublicClient } from "viem";
import type { PancakeQuote, PancakeQuoteInput, PancakeRouter, PancakeToken } from "./pancakeswap.ts";

/**
 * The PancakeSwap SDK, behind the PancakeRouter interface. It reads pools and quotes over the
 * chain's RPC, so it needs no key, and builds the Universal Router call. Server-only: it is its
 * own package entry so the web app never bundles it.
 */

// The SDK's ES module build imports files without extensions, which Node rejects; its CommonJS build loads.
const require = createRequire(import.meta.url);
const { SmartRouter } = require("@pancakeswap/smart-router") as typeof import("@pancakeswap/smart-router");
const { PancakeSwapUniversalRouter, getUniversalRouterAddress } = require("@pancakeswap/universal-router-sdk") as typeof import("@pancakeswap/universal-router-sdk");
const { CurrencyAmount, ERC20Token, Native, Percent, TradeType } = require("@pancakeswap/sdk") as typeof import("@pancakeswap/sdk");

const NATIVE_EVM = "0x0000000000000000000000000000000000000000";
/** How long the signed call stays valid on chain. */
const DEADLINE_S = 20 * 60;

export interface PancakeRouterOptions {
  /** A reader per chain. Batch its multicalls: the SDK reads many pools at once. */
  clientFor: (chainId: number) => PublicClient | undefined;
  now?: () => Date;
}

function currency(chainId: number, token: PancakeToken) {
  return token.address.toLowerCase() === NATIVE_EVM
    ? Native.onChain(chainId)
    : new ERC20Token(chainId, token.address as `0x${string}`, token.decimals, token.symbol);
}

export function createPancakeRouter(options: PancakeRouterOptions): PancakeRouter {
  const now = options.now ?? (() => new Date());

  return {
    async quote(input: PancakeQuoteInput): Promise<PancakeQuote | null> {
      const client = options.clientFor(input.chainId);
      if (!client) throw new Error(`no RPC for chain ${input.chainId}`);
      // The SDK pins its own viem; the client's shape is the same.
      const onChainProvider = (() => client) as never;
      const currencyIn = currency(input.chainId, input.tokenIn);
      const currencyOut = currency(input.chainId, input.tokenOut);

      // A pool type that fails to load narrows the search; it doesn't end it.
      const found = await Promise.allSettled([
        SmartRouter.getV2CandidatePools({ onChainProvider, currencyA: currencyIn, currencyB: currencyOut }),
        SmartRouter.getV3CandidatePools({ onChainProvider, subgraphProvider: (() => undefined) as never, currencyA: currencyIn, currencyB: currencyOut }),
        SmartRouter.getStableCandidatePools({ onChainProvider, currencyA: currencyIn, currencyB: currencyOut }),
      ]);
      const pools: unknown[] = found.flatMap((result): unknown[] => (result.status === "fulfilled" ? result.value : []));
      if (pools.length === 0) {
        const failure = found.find((result) => result.status === "rejected");
        if (failure) throw failure.reason;
        return null;
      }

      const trade = await SmartRouter.getBestTrade(CurrencyAmount.fromRawAmount(currencyIn, input.amountIn), currencyOut, TradeType.EXACT_INPUT, {
        gasPriceWei: () => client.getGasPrice(),
        maxHops: 3,
        maxSplits: 2,
        poolProvider: SmartRouter.createStaticPoolProvider(pools as never),
        quoteProvider: SmartRouter.createQuoteProvider({ onChainProvider }),
        quoterOptimization: true,
      });
      if (!trade) return null;

      const slippage = new Percent(input.slippageBps, 10_000);
      const quote: PancakeQuote = {
        amountOut: BigInt(trade.outputAmount.quotient.toString()),
        minAmountOut: BigInt(SmartRouter.minimumAmountOut(trade, slippage).quotient.toString()),
      };
      if (!input.recipient) return quote;

      const call = PancakeSwapUniversalRouter.swapERC20CallParameters(trade, {
        slippageTolerance: slippage,
        recipient: input.recipient as `0x${string}`,
        deadlineOrPreviousBlockhash: BigInt(Math.floor(now().getTime() / 1000) + DEADLINE_S),
        ...(input.fee ? { fee: { fee: new Percent(input.fee.bps, 10_000), recipient: input.fee.recipient as `0x${string}` } } : {}),
      });
      return {
        ...quote,
        transaction: { to: getUniversalRouterAddress(input.chainId), data: call.calldata, value: call.value },
      };
    },
  };
}

/** The commands a Universal Router call runs, by name, for checks. */
export function decodeRouterCommands(calldata: string): string[] {
  return PancakeSwapUniversalRouter.decodeCallData(calldata as `0x${string}`).map((command) => String((command as { command?: unknown }).command));
}
