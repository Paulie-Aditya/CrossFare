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

## Lifetimes must be a whole number of blocks

**What we expected.** `ExpirationTime.fromSeconds(n)` to accept any number of seconds, or to round to the nearest block. A quote's lifetime is computed from the clock, so it can be any number.

**What happened.** About half of our quote writes failed with `InvalidExpiryError: a lifetime must be a multiple of the 2s block time, got 419`. Our first live run passed by luck, and the second failed. Tests with a fake client didn't catch it, because the check is inside the SDK.

**How to reproduce.** Call `ExpirationTime.fromSeconds(419)` with `@arkiv-network/sdk` 1.0.1.

**What we did.** We round the lifetime up to the next even number.

**What would help.** Round inside `fromSeconds`, or offer an option that does. The error message itself is excellent: it names the cause and suggests values.

## A string field holds 128 bytes

**What we expected.** To store a swap's transaction hashes as one comma-separated string.

**What happened.** The first real swap had three legs, and the final update failed with `InvalidValueError: 178 UTF-8 bytes exceeds the 128-byte limit on a str`. Two 32-byte hashes in hex already exceed it. The record stayed at `executing` and was minutes from expiring, because the failed patch also skipped the extension that follows it.

**How to reproduce.** Patch a `str()` field with a value longer than 128 bytes.

**What we did.** We moved `txHashes` to a `bytes()` field, and repaired the record by hand while it still existed. The error message told us exactly what to do.

**What would help.** A note about the limit next to `str()` in the docs, since fake clients in unit tests never hit it.

