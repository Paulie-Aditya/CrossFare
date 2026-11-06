# Arkiv schema

Crossfare stores one entity per quoted route, on Arkiv's Rabdi testnet. The schema lives in [`packages/core/src/arkiv-schema.ts`](../packages/core/src/arkiv-schema.ts).

## Entity: `crossfare-quote`

| Attribute | Type | Indexed | Example | Used for |
| --- | --- | --- | --- | --- |
| `project` | string | Yes | `crossfare` | Scoping queries to Crossfare |
| `type` | string | Yes | `quote` | Separating entity types |
| `quoteId` | string | Yes | `q_7f3a…` | Lookup from an API response |
| `requestId` | string | Yes | `r_19c2…` | Grouping competing routes from one request |
| `venue` | string | Yes | `uniswap` | Comparing venues |
| `fromAsset` | string | Yes | `base:usdc` | Pair queries |
| `toAsset` | string | Yes | `base:eth` | Pair queries |
| `payer` | string | Yes | `0.0.51234` | Finding the quotes one account paid for |
| `status` | string | Yes | `Quoted` | `Quoted`, `In progress`, `Completed`, `Refunded`, `Failed`, `Expired`. Entities written before 6 November 2026 hold the same words in lower case, with `executing` for `In progress` |
| `createdAt` | u64 | Yes | `1762339200` | Newest-first ordering |
| `validUntil` | u64 | Yes | `1762339290` | Finding live quotes |
| `payload` | bytes | No | JSON | The route in human units |
| `summary` | string | No | `Swapped 5 USDC on Ethereum for 0.0022 ETH on Base` | One readable line, so a record reads as history. Holds no addresses |
| `amountReceived` | string | No | `0.0031` | What was delivered, next to what was quoted |
| `txHashes` | bytes | No | `0x…,0x…` as UTF-8 | Comma-separated execution transactions |

## Queried fields

`GET /v1/quotes?payer=` filters on `project` and `payer`, sorts by `createdAt` descending and restricts results to Crossfare's writer wallet. The agent also reads each route directly with `getEntity`, by key.

## Owner

Crossfare's service wallet owns every entity, so only it can change one. Anyone can create an entity that looks like ours, so every reader checks the owner. Discovery publishes the writer's address at `GET /.well-known/x402`.

## Expiry

| State | Lifetime |
| --- | --- |
| Quoted | Quote validity plus 120 seconds |
| Completed | Extended to 7 days, so quoted and received amounts can be compared |

## Never written

API keys, sender and recipient addresses, refund addresses, and venue state.
