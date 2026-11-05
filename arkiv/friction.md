# Arkiv friction

Written as issues come up. Writes have not yet run against the live testnet, so this will grow.

## Concurrent writes from one wallet

**What happened.** One quote request yields several routes, and our first design wrote them in parallel. Writes are transactions from one wallet, so parallel calls risk a nonce collision. We haven't reproduced a failure yet, and the risk comes from how nonces work.

**What we did.** We queue writes one at a time. `executeBatch` and the batch requirement on our list are the better fix when time allows.

## Entity key arrives only after the block

**What happened.** `createEntity` resolves once the transaction is in a block, so a caller waits for a block before it has the key. Our API wants to answer quickly.

**What we did.** We wait up to 8 seconds, then answer with a pending flag and finish in the background. We later noticed `predictEntityKeys` in the SDK's read actions, which may remove the need for this. We haven't tried it.

## The two chain names

The prize page gives a chain ID and RPC, while the SDK exports the same network as `rabdi`. We had to search the package's source to confirm they were the same network. A line on the prize page naming the export would have saved that step.
