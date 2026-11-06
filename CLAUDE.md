# Crossfare

Open-source cross-chain swap API that AI agents pay for per call: x402 payment on Hedera, quotes published on Arkiv, execution through the SwapKit API or Uniswap. Built for ETHGlobal Mumbai (Classic track).

- **Source of truth:** the [Crossfare PRD](https://claude.ai/artifact/F6egMmxjGd4pvKKd3pAWoZ). Requirement IDs (`FR-n`) refer to it. If the code needs to differ from the PRD, say so instead of drifting silently.
- **Public PRD copy:** [`docs/prd.md`](docs/prd.md) is a copy of the PRD without the SwapKit terms analysis and CoinDrop plans, and it states what was removed. Keep those two out of the repo. When a decision changes the PRD, update both.
- **Team:** solo. AI writes the code, directed by the developer, who steps in manually to fix issues. The developer records the demo video.
- **Pushing:** push to `origin` after each commit. The public history is evidence of steady progress.
- **Deployment:** the developer deploys the API to AWS EC2 and the web app to Vercel.
- **Scope gate:** P0 requirements only until the reference agent completes the whole loop once. P1 work starts after that. P2 waits until after the hackathon.

## Working rules

### No AI attribution
Never add AI attribution to commits, PRs, code or comments. That means no `Co-Authored-By` trailers for AI tools and no "Generated with" lines. A commit may still name AI when it describes the disclosure work itself.

This does not cover `AI_USAGE.md`. ETHGlobal requires that disclosure (see below), so keep it accurate and never understate AI involvement.

### Test-driven development
1. Write a failing test for one behaviour, and run it to confirm it fails for the expected reason.
2. Write the least code that makes it pass.
3. Refactor with the tests still passing.

- No production code without a test that needed it. Bug fixes start with a test that reproduces the bug.
- Unit tests never touch the network. Use recorded fixtures for Uniswap, SwapKit, Arkiv, Hedera and the x402 facilitator.
- Live-service tests are opt-in behind an environment flag and never run by default.
- Report test results as they are. Never skip, weaken or delete a test to get a pass.

### Commits
Commit small and often: one logical change per commit, as soon as its tests pass. Every commit on `main` passes the test suite. A test and the code it drives go in the same commit.

Every commit is documented using this format:

```
type(scope): imperative summary, 72 characters or fewer

Why: the problem or requirement this addresses (FR-n when there is one).
What: the behaviour that changed and any decision worth remembering.
Tested: the command run and its result, or why no test applies.
```

- Types: `feat`, `fix`, `test`, `refactor`, `docs`, `chore`.
- Scopes: `core`, `api`, `web`, `agent`, `mcp`, `arkiv`, `repo`.
- When a commit changes setup, API behaviour or a sponsor integration, update the matching docs in the same commit.
- Before each commit, check the staged diff for secrets.
- Never squash or rewrite history. The commit history is hackathon evidence.

## ETHGlobal Mumbai rules

Sources: [event details](https://ethglobal.com/events/mumbai/info/details), [general rules](https://ethglobal.com/rules), [prizes](https://ethglobal.com/events/mumbai/prizes). Read on 2026-11-05; re-check before submitting.

**Deadline: Saturday 7 November 2026, 09:00 IST. Late submissions are not accepted.**

- **Fresh code (Classic track):** all project work must begin after the hackathon officially starts. Public libraries and starter kits are allowed, but say which ones and keep new work clearly separate from reused work. Using earlier project-specific code, designs or assets makes the project ineligible for partner prizes and the Finalist category. Planning documents are fine.
- **Do not write project code until the official start is confirmed.** The pages read do not state the start time.
- **Version control:** large single commits or missing history may lead to disqualification.
- **AI use:** allowed, as an assistant rather than the creator of the entire project. Projects that rely entirely on AI, without meaningful team contribution, may lose partner prize and Finalist eligibility. So the team directs the design and reviews the work, and `AI_USAGE.md` must show this honestly.
- **AI disclosure:** the submission must document where and how AI tools were used, including the specific code, files and assets they generated or assisted with.
- **Spec-driven work:** all spec files, prompts and planning artifacts must be in the submission repo, so judges can see how the AI was directed.
- **Misrepresentation:** undisclosed pre-existing work, or materially misstating what was built during the event, can bring disqualification, revoked prizes and a ban from future events.
- **Partner prizes:** at most 3 on the submission form. Ours are Uniswap, Hedera and Arkiv.
- **Demo video:** must be 2-4 minutes (the upload is rejected otherwise) and at least 720p. No speed-up, phone recording, text-to-speech or AI voiceover, or music with on-screen text in place of narration. Slides have at most 4 bullets, and the intro runs about 20 seconds. Hedera's limit of 5 minutes is looser, so 2-4 minutes satisfies both.
- **Finalist judging:** 7 minutes (4 demo, 3 Q&A), scored on technicality, originality, practicality, usability and wow factor.

## Required repo files

| File | Required by | Contents |
| --- | --- | --- |
| `LICENSE` | Arkiv, Uniswap, PRD | MIT |
| `README.md` | All | See the checklist below |
| `AI_USAGE.md` | ETHGlobal, Arkiv | Where and how AI was used, by file or area, and what the team directed and reviewed |
| `docs/` specs, prompts and plans | ETHGlobal | Every spec file, prompt and planning artifact that directed the AI, including `docs/prd.md` |
| `FEEDBACK.md` | Uniswap | Honest feedback on building with Uniswap. The name is exact and upper-case |
| `arkiv/schema.md` | Arkiv | Entities, queried fields, owner and expiry |
| `arkiv/friction.md` | Arkiv | What got in the way, with reproduction steps |
| `arkiv/reach.md` | Arkiv | Answers to the track's judging questions |
| `arkiv/why-arkiv.md` | Arkiv | Answers to the track's judging questions |
| `arkiv/how-you-use-arkiv.md` | Arkiv | Answers to the track's judging questions |
| `.env.example` | PRD | Variable names only |

Write `FEEDBACK.md` and `arkiv/friction.md` as things happen, not at the end. Add an entry whenever an integration causes trouble.

**The README must include:**
- setup steps, an architecture diagram and the payment flow
- the Hedera transaction ID of a settled payment, with a HashScan link
- the exact files and lines that call the Uniswap API
- the wallet address that wrote Arkiv entities, and one query judges can run
- a note on AI use that links to `AI_USAGE.md`
- which public libraries and starter kits were used

**Outside the repo:** submit the [Uniswap feedback form](https://developers.uniswap.org/hackathon-feedback) with a link to `FEEDBACK.md`. On the submission form, explain how each partner's tools were used.

**Sponsor constraint:** no Solidity anywhere (Hedera "No Solidity Allowed"). Use HTS and HCS through the SDK.

## Project layout and stack

pnpm monorepo on Node.js 22 and TypeScript:

- `packages/core`: route engine, venue adapters, asset registry. It is the only code that knows about venues.
- `apps/api`: Hono service with the x402 middleware
- `apps/agent`: reference agent (viem)
- `apps/web`: demo UI (React, Vite, wagmi)
- `packages/mcp`: MCP server (P1)

Key dependencies: `@x402/hedera`, `@hiero-ledger/sdk`, `@arkiv-network/sdk`, `node:sqlite`. Uniswap and SwapKit are called over HTTPS.

## Commands

- `pnpm test`: run all tests
- `pnpm typecheck`: type-check every package
- `pnpm check:venues`: real quotes from the live venues, spends nothing
- `pnpm setup:topic`: create the HCS audit topic
- `pnpm setup:usdc`: associate testnet USDC with the fee and agent accounts
- `pnpm --filter @crossfare/api start`: run the API
- `pnpm --filter @crossfare/agent start --from eth:usdc --to base:eth --amount 5`: run the agent, which asks for the receiving address unless given `--recipient`; swaps stay off unless `AGENT_ALLOW_LIVE_SWAPS=true`

Keep `AI_USAGE.md` and `docs/prompts.md` current: add each new developer prompt, and record any manual code change.

## Invariants

Each of these needs a test where it can be tested.

- **Non-custodial:** swapped funds go from the caller's wallet to the venue, never through Crossfare.
- **Payment order:** verify payment before any upstream call, and settle only when the request succeeds. A `409`, `422` or `502` costs the caller nothing.
- **No replays:** each Hedera transaction ID pays for one request, enforced by a unique key in the `payments` table.
- **Secrets:** Uniswap, SwapKit, Arkiv and Hedera keys stay in environment variables, and are never returned to callers or committed.
- **Arkiv writes:** never write API keys, refund addresses or anything that identifies a person beyond the paying account. The writer wallet holds testnet funds only.
- **Agent safety:** the reference agent enforces a per-call cap, a total budget and a `payTo` allowlist, and stops gracefully when funds run low.
- **Separation:** no CoinDrop code or data in this repo.
- **Real money:** swaps run on mainnet, so use the smallest viable amounts. Never send a live transaction without explicit approval from the user.
