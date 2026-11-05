// Read-only check of the venue adapters against the live APIs. Spends nothing.
// Prints raw SwapKit amounts because its docs conflict on units: compare by eye.
import { createSwapKitVenue, createUniswapVenue, type QuoteRequest } from "@crossfare/core";

const { UNISWAP_API_KEY, SWAPKIT_API_KEY } = process.env;
if (!UNISWAP_API_KEY || !SWAPKIT_API_KEY) throw new Error("Set UNISWAP_API_KEY and SWAPKIT_API_KEY in .env");

// A well-known public address, used only so the APIs can build a quote.
const ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const BTC_ADDRESS = "357a3So9CbsNfBBgFYACGvxxS6tMaDoa1P";

const pairs: QuoteRequest[] = [
  {
    from: { asset: "eth:usdc", amount: "5", address: ADDRESS },
    to: { asset: "base:eth", address: ADDRESS },
    mode: "exact_in",
    slippageBps: 300,
    refundAddress: ADDRESS,
  },
  {
    from: { asset: "base:usdc", amount: "5", address: ADDRESS },
    to: { asset: "base:eth", address: ADDRESS },
    mode: "exact_in",
    slippageBps: 50,
  },
  {
    from: { asset: "base:eth", amount: "0.01", address: ADDRESS },
    to: { asset: "btc:btc", address: BTC_ADDRESS },
    mode: "exact_in",
    slippageBps: 300,
    refundAddress: ADDRESS,
  },
];

const venues = [
  createUniswapVenue({ apiKey: UNISWAP_API_KEY }),
  createSwapKitVenue({ apiKey: SWAPKIT_API_KEY }),
];

for (const pair of pairs) {
  console.log(`\n${pair.from.amount} ${pair.from.asset} -> ${pair.to.asset}`);
  for (const venue of venues) {
    try {
      const routes = await venue.quote(pair);
      if (routes.length === 0) console.log(`  ${venue.name}: no routes`);
      for (const { provider, amountOut, minAmountOut, etaSeconds, fees } of routes) {
        console.log(`  ${venue.name}${provider ? `/${provider}` : ""}:`, { amountOut, minAmountOut, etaSeconds, fees });
      }
    } catch (error) {
      console.log(`  ${venue.name}: FAILED: ${(error as Error).message}`);
    }
  }
}
