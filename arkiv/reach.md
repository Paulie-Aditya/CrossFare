# Reach

## Who is it for, and would they use it?

Two groups:

- **CoinDrop's users.** CoinDrop is the developer's own product. Many of its users swap, and today those swaps go through a single liquidity provider. Crossfare gives them a choice of routes, and gives CoinDrop an extra revenue stream through swap fees. That real need is why this is being built.
- **Agent developers.** An agent can pay for a quote per call with no signup and no API key, then check that quote on Arkiv before it spends anything.

For both, the Arkiv record answers one question a swap API normally can't: was the quote honoured? Anyone can compare what was quoted with what was received, without trusting Crossfare's server.

We have no outside users yet, so this is intent rather than evidence of adoption.

## Can they try it today, and will you keep building it after Mumbai?

**Try it:** [crossfare.vercel.app](https://crossfare.vercel.app). The public quote record reads directly from Arkiv, and the swap form needs no account. To read the record without the UI, use the query in the [README](../README.md).

**After Mumbai:** yes. CoinDrop's integration is the next step, including its own swap fees. Before any public launch, we'll talk to SwapKit about the terms for reselling access.
