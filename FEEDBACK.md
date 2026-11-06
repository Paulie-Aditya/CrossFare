# Feedback: building with the Uniswap API

Written as issues come up. Everything here happened while building Crossfare's Uniswap adapter. Quotes have run live, including on the deployed site. No swap has run on chain through Uniswap yet, so `/check_approval` and `/swap` haven't been tested live.

## What worked

- `https://trade-api.gateway.uniswap.org/v1/api.json` is a public OpenAPI spec. It became the most reliable reference we had.
- `llms-full.txt` makes the docs easy to read with tools.
- Same-chain quotes were competitive. Uniswap gave the best price in our live same-chain checks, including 5 USDC to ETH on Base.
- `x-permit2-disabled` suits an API like ours, which hands unsigned transactions to its caller and can't collect typed-data signatures.

## Where we got stuck

**The API reference pages return errors.** The getting-started page links to the reference for full schemas, but these all redirected to a 404 when we fetched them:

- `https://developers.uniswap.org/docs/api-reference/aggregator_quote`
- `https://developers.uniswap.org/docs/api-reference/check_approval`
- `https://developers.uniswap.org/docs/api-reference/create_swap_transaction`

To reproduce, fetch one with an HTTP client. It answers 303 to an `llms.mdx` path, which answers 404. Old `api-docs.uniswap.org` links all redirect to the getting-started page, which has no schemas.

**Two error formats are documented.** The spec uses `errorCode` and `detail`. The integration guide describes `{error, message, details?}`. We couldn't tell which to code against, so the adapter relies on status codes only.

**Quotes have no documented expiry.** We found no expiry field in what we read of the spec. The guide says to refresh quotes older than 30 seconds, and swap calldata has a 30-minute deadline. An API that publishes quote validity has to pick its own number, and we chose 60 seconds.

**The minimum output is hard to find.** It sits in `quote.aggregatedOutputs[i].minAmount`, and we found it only in spec examples. `quote.output` has no minimum, and integrator fee entries share the array, so a caller has to filter them out.

**A reserved swapper address looks like a missing route.** We show a price while someone types, before any wallet is known, so we send a placeholder `swapper`. With `0x0000000000000000000000000000000000000001`, `/quote` answers `404 NoRouteFoundError`, "No route with sufficient liquidity was found for this pair", for USDC to ETH on Base. The same request with `0x000000000000000000000000000000000000dEaD` returns a classic route. The message sent us looking at liquidity, and we only found it because an adapter that reads 404 as "no route" had silently dropped Uniswap from live prices. An error naming the swapper would have saved that.

**Cross-chain availability isn't obvious up front.** On 6 November, USDC on Ethereum to USDC on Base returned `BRIDGE` routing, while USDC on Ethereum to ETH on Base returned `404 No quotes available`. We couldn't tell from the response which pairs to expect, so Crossfare asks Uniswap for same-chain pairs only.

## What was missing

- A complete `/quote` response example for a classic route on the page that documents `/quote`.
- A stated `x-permit2-disabled` scope. We couldn't tell from what we read whether `/check_approval` honours it, so we send it on every call. This still needs a live check.
- A way to ask for classic routing by name. The answer is to set `protocols` to `["V2","V3","V4"]`, which took some digging to find.
