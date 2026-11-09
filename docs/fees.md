# Your fee on swaps

Crossfare takes no fee on swaps. A caller can add its own fee to each quote, and earns it on every swap it routes through Crossfare. This covers FR-34 to FR-36 in the [requirements](prd.md). Ledger mode, where Crossfare only computes the fee, isn't built.

## Setting it

Add `fee` to the `POST /v1/quote` body:

```json
"fee": {
  "bps": 100,
  "recipients": {
    "evm": "0xYourWallet…",
    "near": "yourname.near",
    "thorchain": "yn"
  }
}
```

- `bps` is a whole number of basis points from 1 to 500. 100 is 1%.
- Give at least one recipient. Each venue pays the one it can reach, and a venue with none charges no fee.
- The fee belongs to the quote. `POST /v1/swap` executes it as quoted.
- The response's routes show what the customer receives after the fee. `fees.integrator` shows what your wallet gets. That amount is also on the quote's Arkiv record; your wallets are not.

## Where each venue pays it

| Venue | Recipient | How you're paid | Measured on 9 November |
| --- | --- | --- | --- |
| Uniswap | `evm` | Taken from the output inside the swap, on that chain and in the token bought | The whole fee. Up to 500 bps |
| NEAR Intents, direct | `near`, or `evm` when `near` is absent | Credited to that account's balance inside NEAR Intents; withdraw it at near-intents.org | 1Click passes on half: 100 bps pays you 50, and the customer pays 100. Its own share is at least 20 bps, charged even with no fee |
| THORChain, direct | `thorchain`, a registered THORName | Paid by THORChain to the name's address, or its preferred asset | The whole fee. From Litecoin, Bitcoin and other UTXO chains, the name must be short for the memo to fit in 80 bytes |
| SwapKit | None needed | SwapKit pays the operator's wallets set in its dashboard. Crossfare records what you earned, and pays it out separately | SwapKit only charges a provider that has a wallet in the dashboard. It also takes its own service fee, 0.15% on the routes checked |

The direct venues run only where the operator turns them on. Otherwise those providers come through SwapKit.

## SwapKit earnings

SwapKit can't pay a wallet named in the request, so Crossfare keeps a ledger. When a SwapKit swap with your fee completes, Crossfare records the fee SwapKit quoted for it, in SwapKit's asset, against your payer ID and the recipients you gave. A refunded swap earns nothing. A flexible deposit can differ from the quote, so the ledger amount is an estimate for those.

The operator reads the ledger by month:

```sh
node --env-file=<env> src/vip-cli.ts earnings --month 2026-11
```

It prints one line per payer, asset and set of recipients, with the number of swaps and the total. Payouts aren't automated yet.
