# Crossfare

An open-source cross-chain swap API that AI agents pay for per call. An agent pays for its quotes with x402 on Hedera, checks them on Arkiv, and executes through the SwapKit API, or Uniswap for same-chain swaps. It needs no signup or API key, and Crossfare never holds the swapped funds.

For example: you tell your agent to swap 5 USDC on Ethereum to ETH on Base. It asks for the receiving address, pays 0.01 testnet USDC on Hedera for a quote, publishes it on Arkiv, and sends the deposit that SwapKit routes.

Built at ETHGlobal Mumbai, Classic track.

**Try it:** [crossfare.vercel.app](https://crossfare.vercel.app). There's no account to create and no wallet to connect, though swaps use real funds on mainnet, so keep them small.

**Demo video (2 minutes 43 seconds):** a real 10 USDC swap on the deployed site, from quote to delivery, with the payment on HashScan and the quote on Arkiv. Click the image to download it (14 MB, MP4): GitHub can't play a video this size from the repo.

[![Crossfare demo video](docs/media/demo-cover.png)](https://github.com/Paulie-Aditya/CrossFare/raw/main/docs/media/crossfare-demo.mp4)

> **Status:** live, with the UI on Vercel and the API on EC2. Five real swaps have completed: two from a local server before deployment, and three on the deployed site on 7 November. See the [full test report](docs/live-test-2026-11-06.md), which also lists what hasn't been tested.

## Live evidence

**Swap on the deployed site, shown in the demo video:** 10 USDC on Ethereum delivered 0.0044597 ETH on Base, through NEAR. No wallet was connected; the deposit came from the developer's own wallet app.

- **Settled x402 payment on Hedera:** [`0.0.9185802@1794012817.780315545`](https://hashscan.io/testnet/transaction/0.0.9185802@1794012817.780315545)
- **Quote on Arkiv:** [`0x83a7e0…f7bc`](https://rabdi.explorer.arkiv.network/entity/0x83a7e022d8108fcdeffda0aff22e4c7a28ddbe96e0c573bc4ac70d0fa441f7bc)
- **Deposit on Ethereum:** [`0x95354f…6c58`](https://etherscan.io/tx/0x95354fe5dbd1ecf12205712f9b4d5b69c7e53a126b79e6aab73a8dcd13f46c58)
- **Delivery on Base:** [`0xfb4f27…dddf`](https://basescan.org/tx/0xfb4f27671495fa924b11c04ac3943e0cc9dd56d9bc07604fa3377cbcb2aadddf)

**Swap through the agent:** 2 USDC on Ethereum delivered 1.997376 USDC on Base.

- **Settled x402 payment on Hedera:** [`0.0.9185802@1793955744.682983872`](https://hashscan.io/testnet/transaction/0.0.9185802@1793955744.682983872)
- **Audit log:** [HCS topic `0.0.11336749`](https://hashscan.io/testnet/topic/0.0.11336749)
- **Quote on Arkiv, quoted against received:** [`0x268005…54c5`](https://rabdi.explorer.arkiv.network/entity/0x26800551ca60a7f504a84f0e02cd068b62c98b4eb597a69262f5138a399c54c5), kept until about 13 November 2026
- **Deposit on Ethereum:** [`0xe42c95…c2ea`](https://etherscan.io/tx/0xe42c9597f79765a406baab374fae2c1e35d2813d1b7a2881ad301fbdc404c2ea)
- **Delivery on Base:** [`0x3dcbb7…a6bc`](https://basescan.org/tx/0x3dcbb74c8b5e5724063049977e195f71a85d826ef3c8346657c5d7aec8f7a6bc)

**Swap through the UI, with no wallet connected:** 5 USDC on Ethereum delivered 0.0022257 ETH on Base.

- **Quote on Arkiv:** [`0x6e560d…5aa0`](https://rabdi.explorer.arkiv.network/entity/0x6e560d372a560dfd29418ab5a076d86f833cadb20b4f3f3074096abe198a5aa0), kept until about 13 November 2026
- **Deposit on Ethereum:** [`0x360be9…dac0`](https://etherscan.io/tx/0x360be9f057f35a6eb11946a996c3c471c311b43184a3466f8a8313543079dac0)
- **Delivery on Base:** [`0xeccf95…2e50d`](https://basescan.org/tx/0xeccf951a2e396be57c402585e0b5e65f65d03f4329227d5989ae42af9bb2e50d)

**Arkiv writer wallet:** `0xCA3994F906e54FB8707f529a506EEE755b636B52`. To list Crossfare's quotes with `@arkiv-network/sdk`:

```ts
const client = createPublicClient({ chain: rabdi({ accessKey }), transport: http() });
const page = await client
  .select({ $key: true, quoteId: true, venue: true, status: true, summary: true, amountReceived: true, createdAt: true })
  .where(eq("project", "crossfare"))
  .ownedBy("0xCA3994F906e54FB8707f529a506EEE755b636B52")
  .orderBy(desc("createdAt"))
  .limit(50)
  .fetch();
```

## How it works

```mermaid
flowchart TB
    agent["Reference agent"] --> api
    browser["Browser"] --> vercel["Web UI on Vercel"]
    vercel -->|"forwards /v1 and /demo"| api
    subgraph ec2["AWS EC2, behind nginx"]
        api["Crossfare API"] --> db[("SQLite: payments, quotes, swaps")]
    end
    api --> hedera["Hedera testnet: x402 payments, HCS audit log"]
    api --> arkiv["Arkiv testnet: public quote records"]
    api --> uniswap["Uniswap API: same-chain routes"]
    api --> swapkit["SwapKit API: cross-chain routes, status, screening"]
```

Swapped funds never pass through Crossfare. They go from the caller's wallet to the venue.

One swap, from an agent's point of view:

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
| `GET /v1/assets` | Free | Every token SwapKit lists, with logos and chains, loaded from its public lists at startup and refreshed daily |
| `POST /v1/quote` | 0.01 USDC | Ranked routes from every venue that supports the pair |
| `POST /v1/swap` | Free for now | Prepare one quote for execution. Needs the `swapToken` from its quote response |
| `POST /v1/swaps/:id/tx` | Free | Report the broadcast transaction hash |
| `GET /v1/price?from=&to=&amount=` | Free | An indicative price for the UI while someone types. It isn't published, can't be executed and shares a rate limit between callers. |
| `GET /v1/swaps/:id` | Free | Swap status. It reads the deposit address on chain as well as asking the provider, so a deposit shows within seconds. It also reports what was really deposited, and any shortfall below the provider's minimum. |
| `GET /v1/quotes` | Free | Recent quotes, or one payer's with `?payer=`, read from Arkiv |
| `POST /demo/quote`, `POST /demo/swap` | Free, capped | The same calls, with any fee paid by a testnet account so visitors to the UI need no Hedera wallet |

Prices are placeholders, settled in testnet USDC. Set `SWAP_PRICE_USDC` to charge for `POST /v1/swap` as well. Quote IDs are public on Arkiv, so the swap call requires a private token that only the quote's caller receives. Payments and Arkiv use testnets. Swaps run on mainnet because Uniswap and SwapKit need real liquidity. Sender and receiving addresses are checked for their chain, screened through SwapKit when a swap is requested, and never published on Arkiv. Without the sending wallet connected, quotes use SwapKit's flexible deposit mode and skip its balance check, so the deposit can come from any wallet or exchange. The address given is then only where refunds go.

## Repository

| Path | Contents |
| --- | --- |
| `packages/core` | Asset registry, route ranking, venue adapters |
| `apps/api` | Hono service, payment guard, x402 gateway, Arkiv publisher, HCS audit log |
| `apps/agent` | Reference agent and spending controls |
| `apps/web` | Swap form, token picker, order page, swap history. Deploys to Vercel |
| `scripts` | Setup and read-only checks |
| `deploy` | Service, nginx and Caddy configuration for EC2 |
| `arkiv/` | Arkiv prize documents |
| `docs/` | [Requirements](docs/prd.md), [developer prompts](docs/prompts.md), [test report](docs/live-test-2026-11-06.md) and deployment guides |

**Where the Uniswap API is called:** [`packages/core/src/venues/uniswap.ts`](packages/core/src/venues/uniswap.ts): `/quote` at [line 158](packages/core/src/venues/uniswap.ts#L158), `/check_approval` at [line 204](packages/core/src/venues/uniswap.ts#L204) and `/swap` at [line 214](packages/core/src/venues/uniswap.ts#L214).

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

To work on the UI without any keys, run a fake API that spends nothing, then the dev server. In the fake API, typing 7 as the amount sends too little and typing 8 sends too much, so those screens can be seen:

```sh
node apps/api/src/dev-mock.ts
pnpm --filter @crossfare/web dev
```

To work on the UI against the live API instead, with real tokens and prices, run:

```sh
CROSSFARE_API_URL=https://crossfare.vercel.app pnpm --filter @crossfare/web dev
```

Each quote there pays a real testnet fee and writes to Arkiv, and counts against the demo's limits.

## Deploy

The live site runs the API on [EC2](docs/deploy-ec2.md) and the UI on [Vercel](docs/deploy-vercel.md), which redeploys when `main` changes. A change to the API needs the update steps in the EC2 guide.

## Built with

Open-source libraries, used as published: [Hono](https://hono.dev), [`@x402/core`, `@x402/hedera`, `@x402/fetch`](https://github.com/x402-foundation/x402), [`@hiero-ledger/sdk`](https://github.com/hiero-ledger/hiero-sdk-js), [`@arkiv-network/sdk`](https://hub.arkiv.network), [viem](https://viem.sh), [React](https://react.dev), [Vite](https://vite.dev), [wagmi](https://wagmi.sh), [qrcode.react](https://github.com/zpao/qrcode.react) and [Vitest](https://vitest.dev). No starter kit was used. All project code was written during the hackathon.

## AI use

AI wrote most of this code under the developer's direction. [`AI_USAGE.md`](AI_USAGE.md) says where and how, [`docs/prompts.md`](docs/prompts.md) records the prompts, and [`docs/prd.md`](docs/prd.md) is the requirements document that directed the work.

## License

[MIT](LICENSE)
