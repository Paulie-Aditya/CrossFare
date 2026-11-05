# How Crossfare uses Arkiv

Every quote Crossfare sells becomes a public Arkiv entity.

**Write.** `POST /v1/quote` writes one entity per route, in [`apps/api/src/arkiv-publisher.ts`](../apps/api/src/arkiv-publisher.ts). A write gets a short wait. If it takes longer, the API answers with a pending flag and the write finishes in the background.

**Read, as a user-visible feature.** Before paying to execute, the reference agent reads its quotes back from Arkiv and drops any whose numbers differ from the API response or whose owner isn't Crossfare's wallet. See `verifyOnArkiv` in [`apps/agent/src/run.ts`](../apps/agent/src/run.ts).

**Update.** When a swap finishes, Crossfare patches the entity with its final status, the amount received and the transaction hashes.

**Expire.** Unused quotes disappear shortly after they lapse, because a dead quote has no value. Completed swaps stay for 7 days.

See [`schema.md`](schema.md) for the entity.
