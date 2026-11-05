# Crossfare

An open-source cross-chain swap API that AI agents pay for per call. An agent pays for its quotes with x402 on Hedera, checks them on Arkiv, and executes through the SwapKit API, or Uniswap for same-chain swaps. It needs no signup or API key, and Crossfare never holds the swapped funds.

For example: you tell your agent to swap 5 USDC on Ethereum to ETH on Base. It asks for the receiving address, pays 0.01 testnet USDC on Hedera for a quote, publishes it on Arkiv, and sends the deposit that SwapKit routes.

Built at ETHGlobal Mumbai, Classic track.

> **Status:** in active development. The API, agent and UI are covered by tests against mocked services. They have not yet completed a live run, so this README has no live URL or transaction links yet.

## How it works

```mermaid
sequenceDiagram
    participant A as Agent
    participant C as Crossfare API
    participant H as Hedera (x402)
    participant V as Uniswap / SwapKit
    participant K as Arkiv
    A->>C: GET /.well-known/x402
    A->>C: POST /v1/quote
    C-->>A: 402 + payment requirements
    A->>C: POST /v1/quote + signed payment
    C->>H: verify through facilitator
    C->>V: quote all venues
    C->>K: publish each route
    C->>H: settle payment, log to HCS
    C-->>A: routes, Arkiv keys, Hedera transaction ID
    A->>K: read quotes back and compare
    A->>C: POST /v1/swap + private swap token
    C-->>A: deposit address and unsigned transactions
    A->>V: sign and broadcast
    A->>C: POST /v1/swaps/:id/tx
    A->>C: GET /v1/swaps/:id until finished
    C->>K: record status and amount received
```

### Payment flow

1. A paid endpoint called without payment answers `402` with USDC on `hedera:testnet`, the `payTo` account and the facilitator's fee payer.
2. The caller signs a Hedera transfer and retries with it in the `PAYMENT-SIGNATURE` header.
3. Crossfare claims the payment, so a replay fails, then verifies it through the facilitator before any upstream call.
4. It settles only when the request succeeds. A `409`, `422` or `502` costs the caller nothing.
5. The response carries the Hedera transaction ID, and the payment is logged to a public HCS topic.

## API

| Endpoint | Price | Purpose |
| --- | --- | --- |
| `GET /.well-known/x402` | Free | Endpoints, prices, payment details, Arkiv writer |
| `GET /v1/assets` | Free | Supported assets per venue |
| `POST /v1/quote` | 0.01 USDC | Ranked routes from every venue that supports the pair |
| `POST /v1/swap` | Free for now | Prepare one quote for execution. Needs the `swapToken` from its quote response |
| `POST /v1/swaps/:id/tx` | Free | Report the broadcast transaction hash |
| `GET /v1/swaps/:id` | Free | Swap status |
| `GET /v1/quotes` | Free | Recent quotes, or one payer's with `?payer=`, read from Arkiv |
| `POST /demo/quote`, `POST /demo/swap` | Free, capped | The same calls, with any fee paid by a testnet account so visitors to the UI need no Hedera wallet |

Prices are placeholders, settled in testnet USDC. Set `SWAP_PRICE_USDC` to charge for `POST /v1/swap` as well. Quote IDs are public on Arkiv, so the swap call requires a private token that only the quote's caller receives. Payments and Arkiv use testnets. Swaps run on mainnet because Uniswap and SwapKit need real liquidity. Sender and receiving addresses are checked for their chain, screened through SwapKit when a swap is requested, and never published on Arkiv. SwapKit also checks that the sender holds the amount.

## Repository

| Path | Contents |
| --- | --- |
| `packages/core` | Asset registry, route ranking, venue adapters |
| `apps/api` | Hono service, payment guard, x402 gateway, Arkiv publisher, HCS audit log |
| `apps/agent` | Reference agent and spending controls |
| `apps/web` | Swap form, order page and public quote record |
| `scripts` | Setup and read-only checks |
| `deploy` | Service and HTTPS configuration for EC2 |
| `arkiv/` | Arkiv prize documents |

**Where the Uniswap API is called:** [`packages/core/src/venues/uniswap.ts`](packages/core/src/venues/uniswap.ts), through `/quote`, `/check_approval` and `/swap`.

## Setup

Requires Node.js 22.18 or newer and pnpm.

```sh
pnpm install
cp .env.example .env   # then fill it in
pnpm test
pnpm setup:topic       # creates the audit topic; copy the ID into .env
pnpm setup:usdc        # associates testnet USDC with the fee and agent accounts
pnpm check:venues      # read-only: real quotes, spends nothing
pnpm --filter @crossfare/api start
```

Run the agent in a second terminal. It asks for the receiving address unless you pass `--recipient`, and it stops before spending swap funds unless `AGENT_ALLOW_LIVE_SWAPS=true` is set:

```sh
pnpm --filter @crossfare/agent start --from eth:usdc --to base:eth --amount 5
```

You need:

- Uniswap and SwapKit API keys
- two Hedera testnet accounts, both associated with testnet USDC (`0.0.429274`) by `pnpm setup:usdc`, and the agent's funded with USDC
- an Arkiv access key and a wallet funded from the faucet
- for live swaps, a dedicated EVM wallet with small balances, including ETH for gas on the source chain

With `AGENT_HEDERA_ACCOUNT` set, the UI at `http://localhost:8787` works once the web app is built with `pnpm --filter @crossfare/web build`.

To work on the UI without any keys, run a fake API that spends nothing, then the dev server:

```sh
node apps/api/src/dev-mock.ts
pnpm --filter @crossfare/web dev
```

## Deploy

One EC2 instance serves the UI and API from a single URL. See [`docs/deploy-ec2.md`](docs/deploy-ec2.md).

## Built with

Open-source libraries, used as published: [Hono](https://hono.dev), [`@x402/core`, `@x402/hedera`, `@x402/fetch`](https://github.com/x402-foundation/x402), [`@hiero-ledger/sdk`](https://github.com/hiero-ledger/hiero-sdk-js), [`@arkiv-network/sdk`](https://hub.arkiv.network), [viem](https://viem.sh), [React](https://react.dev), [Vite](https://vite.dev), [wagmi](https://wagmi.sh), [qrcode.react](https://github.com/zpao/qrcode.react) and [Vitest](https://vitest.dev). No starter kit was used. All project code was written during the hackathon.

## AI use

AI wrote most of this code under the developer's direction. [`AI_USAGE.md`](AI_USAGE.md) says where and how, and [`docs/prompts.md`](docs/prompts.md) records the prompts.

## License

[MIT](LICENSE)
