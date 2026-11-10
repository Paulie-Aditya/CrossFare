export interface Goal {
  from: { asset: string; amount: string; address: string };
  to: { asset: string; address: string };
  slippageBps: number;
  refundAddress?: string;
}

export interface QuotedRoute {
  quoteId: string;
  venue: string;
  provider?: string;
  /** Set on a two-leg route: the first leg's `to` is the hub token held between legs. */
  legs?: { venue: string; provider?: string; from: string; to: string; amountOut: string }[];
  amountOut: string;
  minAmountOut: string;
  validUntil: string;
  arkiv: { entityKey: string | null; pending: boolean };
}

export interface AgentTransaction {
  kind: string;
  chainId: number;
  to: string;
  data: string;
  value: string;
}

export interface Discovery {
  payTo: string;
  arkiv?: { writer: string };
}

export interface ApiResponse {
  status: number;
  body: any;
}

export interface SwapStatusResponse {
  status: string;
  amountReceived?: string | null;
  txHashes?: string[];
  /** A two-leg swap's legs so far, each with what it delivered. */
  legs?: { venue: string; status: string; amountReceived?: string }[];
}

export interface AgentDeps {
  discover(): Promise<Discovery>;
  requestQuote(request: Goal & { multiLeg?: boolean }): Promise<ApiResponse>;
  readQuote(entityKey: string): Promise<{ owner: string; payload: any }>;
  listQuotes(): Promise<{ quoteId: string; entityKey: string }[]>;
  requestSwap(quoteId: string, swapToken: string): Promise<ApiResponse>;
  /** Prepares the second leg of a two-leg route once the first has delivered. */
  requestNextLeg(swapId: string, swapToken: string): Promise<ApiResponse>;
  sendTransaction(transaction: AgentTransaction): Promise<string>;
  submitHash(swapId: string, hash: string): Promise<void>;
  getStatus(swapId: string): Promise<SwapStatusResponse>;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  /** Swaps spend real funds, so the owner must turn this on beforehand. */
  allowLiveSwaps: boolean;
  allowedPayTo: readonly string[];
  pollIntervalMs: number;
  maxPolls: number;
}

export interface AgentResult {
  outcome: "completed" | "refunded" | "failed" | "expired" | "pending" | "stopped" | "dry_run";
  reason?: string;
  swapId?: string;
  amountReceived?: string | null;
}

const MAX_SWAP_ATTEMPTS = 3;
const KEY_LOOKUPS = 5;
const FINISHED = ["completed", "refunded", "failed", "expired"] as const;

const hashscan = (transactionId: string) => `https://hashscan.io/testnet/transaction/${transactionId}`;
const stop = (deps: AgentDeps, reason: string): AgentResult => {
  deps.log(`Stopping: ${reason}`);
  return { outcome: "stopped", reason };
};

/** Compares decimal strings by value: the guaranteed amounts are all that decide. */
function compareAmounts(a: string, b: string): number {
  const [aWhole = "0", aFraction = ""] = a.split(".");
  const [bWhole = "0", bFraction = ""] = b.split(".");
  const width = Math.max(aFraction.length, bFraction.length);
  const left = BigInt(aWhole + aFraction.padEnd(width, "0"));
  const right = BigInt(bWhole + bFraction.padEnd(width, "0"));
  return left === right ? 0 : left > right ? 1 : -1;
}

/** Looks up the key of a write that was still pending when the quote came back. */
async function resolveEntityKey(deps: AgentDeps, route: QuotedRoute): Promise<string | null> {
  if (route.arkiv.entityKey) return route.arkiv.entityKey;
  for (let attempt = 0; attempt < KEY_LOOKUPS; attempt++) {
    const found = (await deps.listQuotes()).find((quote) => quote.quoteId === route.quoteId);
    if (found) return found.entityKey;
    await deps.sleep(deps.pollIntervalMs);
  }
  return null;
}

/** A route counts only if Arkiv holds the same numbers, written by Crossfare's own wallet. */
async function verifyOnArkiv(deps: AgentDeps, route: QuotedRoute, writer: string | undefined): Promise<boolean> {
  const entityKey = await resolveEntityKey(deps, route);
  if (!entityKey) {
    deps.log(`  ${route.quoteId}: no Arkiv record found`);
    return false;
  }
  const record = await deps.readQuote(entityKey).catch(() => null);
  if (!record) {
    deps.log(`  ${route.quoteId}: Arkiv read failed`);
    return false;
  }
  if (writer && record.owner.toLowerCase() !== writer.toLowerCase()) {
    deps.log(`  ${route.quoteId}: Arkiv record has the wrong owner`);
    return false;
  }
  const matches =
    record.payload?.quoteId === route.quoteId &&
    record.payload?.minAmountOut === route.minAmountOut &&
    record.payload?.amountOut === route.amountOut;
  deps.log(`  ${route.quoteId}: ${matches ? "matches" : "DIFFERS FROM"} Arkiv record ${entityKey}`);
  return matches;
}

/** Discover, pay, compare, verify, execute and confirm, with no human in the loop. */
export async function runAgent(deps: AgentDeps, goal: Goal): Promise<AgentResult> {
  deps.log(`Goal: ${goal.from.amount} ${goal.from.asset} to ${goal.to.asset}`);

  const service = await deps.discover();
  if (!deps.allowedPayTo.includes(service.payTo)) {
    return stop(deps, `service account ${service.payTo} is not on the allowlist`);
  }
  deps.log(`Discovered Crossfare, paying ${service.payTo}`);

  let quoted: ApiResponse;
  try {
    // Crossfare offers a two-leg route only when nothing direct exists, and this agent can sign both legs.
    quoted = await deps.requestQuote({ ...goal, multiLeg: true });
  } catch (error) {
    return stop(deps, (error as Error).message);
  }
  if (quoted.status !== 200) return stop(deps, `quote failed: ${JSON.stringify(quoted.body)}`);
  deps.log(`Paid for quotes: ${hashscan(quoted.body.payment.transactionId)}`);

  const routes = quoted.body.routes as QuotedRoute[];
  deps.log(`Got ${routes.length} route(s). Reading them back from Arkiv:`);
  const verified: QuotedRoute[] = [];
  for (const route of routes) {
    if (await verifyOnArkiv(deps, route, service.arkiv?.writer)) verified.push(route);
  }
  if (verified.length === 0) return stop(deps, "no quote could be verified on Arkiv");

  let chosen = verified.reduce((best, route) =>
    compareAmounts(route.minAmountOut, best.minAmountOut) > 0 ? route : best,
  );
  deps.log(
    `Chose ${chosen.quoteId} (${chosen.venue}${chosen.provider ? `/${chosen.provider}` : ""}): ` +
      `guarantees at least ${chosen.minAmountOut} ${goal.to.asset}, the best of ${verified.length} verified`,
  );

  if (!deps.allowLiveSwaps) {
    deps.log("Live swaps are off, so stopping before spending funds.");
    return { outcome: "dry_run", reason: "live swaps are off" };
  }

  let swap: ApiResponse | undefined;
  for (let attempt = 0; attempt < MAX_SWAP_ATTEMPTS; attempt++) {
    try {
      swap = await deps.requestSwap(chosen.quoteId, quoted.body.swapToken);
    } catch (error) {
      return stop(deps, (error as Error).message);
    }
    if (swap.status !== 409) break;
    deps.log(`Swap answered ${swap.body.error}; trying the fresh quote`);
    const fresh = swap.body.freshQuote as QuotedRoute;
    if (!(await verifyOnArkiv(deps, fresh, service.arkiv?.writer))) {
      return stop(deps, "fresh quote could not be verified on Arkiv");
    }
    chosen = fresh;
  }
  if (!swap || swap.status !== 200) {
    return stop(deps, `swap failed: ${swap ? JSON.stringify(swap.body) : "no response"}`);
  }

  const { swapId } = swap.body as { swapId: string };
  if (swap.body.payment) deps.log(`Paid for execution: ${hashscan(swap.body.payment.transactionId)}`);

  /** Signs and sends one leg's transactions in order. Returns why it couldn't, if it couldn't. */
  async function send(body: { transactions?: AgentTransaction[]; leg?: number; legCount?: number }): Promise<string | null> {
    const transactions = body.transactions ?? [];
    if (transactions.length === 0) return "route needs a deposit from a non-EVM wallet, which this agent lacks";
    if (body.leg) deps.log(`Leg ${body.leg} of ${body.legCount}:`);
    for (const transaction of transactions) {
      const hash = await deps.sendTransaction(transaction);
      deps.log(`Sent ${transaction.kind} transaction: ${hash}`);
      if (transaction.kind === "swap") await deps.submitHash(swapId, hash);
    }
    return null;
  }

  const unsent = await send(swap.body);
  if (unsent) return { ...stop(deps, unsent), swapId };

  for (let poll = 0; poll < deps.maxPolls; poll++) {
    const status = await deps.getStatus(swapId);
    deps.log(`Status: ${status.status}`);
    if (status.status === "awaiting_next_leg") {
      // The hub token is in this wallet now. If the second leg can't run, it stays there, safe.
      const held = `${status.legs?.at(-1)?.amountReceived ?? "the"} ${chosen.legs?.[0]?.to ?? "hub token"}`;
      const holding = (why: string) => ({ ...stop(deps, `${why}; holding ${held} in this wallet`), swapId });
      let next: ApiResponse;
      try {
        next = await deps.requestNextLeg(swapId, quoted.body.swapToken);
      } catch (error) {
        return holding((error as Error).message);
      }
      if (next.status !== 200) return holding(`second leg refused: ${JSON.stringify(next.body)}`);
      try {
        const reason = await send(next.body);
        if (reason) return holding(reason);
      } catch (error) {
        return holding(`second leg failed to send: ${(error as Error).message}`);
      }
      await deps.sleep(deps.pollIntervalMs);
      continue;
    }
    const finished = FINISHED.find((state) => state === status.status);
    if (finished) {
      if (status.amountReceived) deps.log(`Received ${status.amountReceived} ${goal.to.asset}`);
      return { outcome: finished, swapId, amountReceived: status.amountReceived ?? null };
    }
    await deps.sleep(deps.pollIntervalMs);
  }
  deps.log(`Still running. Check /v1/swaps/${swapId} later.`);
  return { outcome: "pending", swapId };
}
