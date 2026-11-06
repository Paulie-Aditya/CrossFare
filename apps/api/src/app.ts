import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import {
  fromBaseUnits,
  getAsset,
  isValidAddress,
  listAssets,
  rankRoutes,
  toBaseUnits,
  VenueError,
  type PreparedSwap,
  type QuoteRequest,
  type Route,
  type ScreenAddresses,
  type SwapStatus,
  type Venue,
} from "@crossfare/core";
import {
  PAYMENT_NETWORK,
  createPaymentGuard,
  type AuditLog,
  type GuardedResult,
  type HandlerResult,
  type PaymentGateway,
  type PricedEndpoint,
} from "./payment.ts";
import type { PublicQuote, QuotePublisher } from "./publisher.ts";
import type { Store } from "./store.ts";

export const QUOTE_ENDPOINT: PricedEndpoint = {
  key: "POST /v1/quote",
  priceUsd: "0.01",
  description: "Cross-chain swap quotes from every supported venue",
};

export const SWAP_ENDPOINT: PricedEndpoint = {
  key: "POST /v1/swap",
  priceUsd: "0",
  description: "Prepare execution of one quote. Needs the swapToken from its quote response",
};

export interface AppDeps {
  venues: Venue[];
  store: Store;
  gateway: PaymentGateway;
  audit: AuditLog;
  publisher: QuotePublisher;
  payTo: string;
  /** Turns on x402 for POST /v1/swap at this USD price. Unset or zero means free. */
  swapPriceUsd?: string;
  /** The wallet that owns Crossfare's Arkiv records, so readers can check authorship. */
  arkivWriter?: string;
  /** Sanctions screening. Runs before a swap is prepared; a failure blocks the swap. */
  screen?: ScreenAddresses;
  now?: () => Date;
  newId?: (prefix: string) => string;
  /** The least time between status calls to a venue for one swap. */
  trackIntervalMs?: number;
  /** How long a quote response waits for Arkiv before flagging the write as pending. */
  publishTimeoutMs?: number;
  onError?: (context: string, error: unknown) => void;
}

/** Bounds what one paid quote can make Crossfare write to Arkiv through re-quotes. */
const MAX_QUOTES_PER_REQUEST = 20;

const UNISWAP_VENUE = "uniswap";
const SWAPKIT_VENUE = "swapkit";

function parseQuoteRequest(input: unknown): { request: QuoteRequest } | { status: 400 | 422; error: string } {
  const body = input as Partial<QuoteRequest> | null;
  const from = body?.from;
  const to = body?.to;
  if (!from?.asset || !from.amount || !from.address || !to?.asset || !to.address) {
    return { status: 400, error: "from.asset, from.amount, from.address, to.asset and to.address are required" };
  }
  const mode = body?.mode ?? "exact_in";
  if (mode !== "exact_in" && mode !== "exact_out") return { status: 400, error: "invalid mode" };
  const slippageBps = body?.slippageBps ?? 50;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    return { status: 400, error: "slippageBps must be an integer from 0 to 10000" };
  }
  try {
    const decimals = getAsset(mode === "exact_in" ? from.asset : to.asset).decimals;
    getAsset(from.asset);
    getAsset(to.asset);
    if (toBaseUnits(from.amount, decimals) <= 0n) return { status: 400, error: "amount must be positive" };
    if (!isValidAddress(from.asset, from.address)) return { status: 400, error: "invalid sending address" };
    if (!isValidAddress(to.asset, to.address)) return { status: 400, error: "invalid receiving address" };
    if (body?.refundAddress && !isValidAddress(from.asset, body.refundAddress)) {
      return { status: 400, error: "invalid refund address" };
    }
  } catch (error) {
    return { status: 422, error: (error as Error).message };
  }
  return {
    request: {
      from: { asset: from.asset, amount: from.amount, address: from.address },
      to: { asset: to.asset, address: to.address },
      mode,
      slippageBps,
      ...(body?.refundAddress ? { refundAddress: body.refundAddress } : {}),
      ...(body?.flexibleDeposit === true ? { flexibleDeposit: true } : {}),
    },
  };
}

function humanRoute(route: Route) {
  const decimals = getAsset(route.to).decimals;
  return {
    venue: route.venue,
    ...(route.provider ? { provider: route.provider } : {}),
    amountOut: fromBaseUnits(route.amountOut, decimals),
    minAmountOut: fromBaseUnits(route.minAmountOut, decimals),
    fees: route.fees,
    etaSeconds: route.etaSeconds,
    validUntil: route.validUntil,
    depositable: route.depositable ?? false,
  };
}

const TERMINAL: readonly SwapStatus[] = ["completed", "refunded", "failed", "expired"];

const toSeconds = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

const digest = (value: string) => createHash("sha256").update(value).digest();

function tokenMatches(expected: string | null | undefined, given: unknown): boolean {
  return typeof given === "string" && !!expected && timingSafeEqual(digest(expected), digest(given));
}

export function createApp(deps: AppDeps): Hono {
  const { venues, store, publisher } = deps;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? ((prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`);
  const publishTimeoutMs = deps.publishTimeoutMs ?? 8_000;
  // SwapKit gives a new key 10 requests a minute per service, however often callers poll.
  const trackIntervalMs = deps.trackIntervalMs ?? 15_000;
  const lastTracked = new Map<string, number>();
  const onError = deps.onError ?? ((context, error) => console.error(context, error));
  const guard = createPaymentGuard({ gateway: deps.gateway, store, audit: deps.audit, onError });
  const swapEndpoint: PricedEndpoint = { ...SWAP_ENDPOINT, priceUsd: deps.swapPriceUsd || SWAP_ENDPOINT.priceUsd };
  const swapIsFree = !(Number(swapEndpoint.priceUsd) > 0);
  const app = new Hono();

  const paymentHeader = (headers: { header(name: string): string | undefined }) =>
    headers.header("payment-signature") ?? headers.header("x-payment");

  const respond = (result: GuardedResult) =>
    new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json", ...result.headers },
    });

  /** Waits briefly for the Arkiv write. A slower write finishes in the background. */
  async function publish(quoteId: string, quote: PublicQuote) {
    const write = publisher.publishQuote(quote).then((entityKey) => {
      store.setQuoteEntityKey(quoteId, entityKey);
      return entityKey;
    });
    write.catch((error: unknown) => onError(`arkiv write failed for ${quoteId}`, error));
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), publishTimeoutMs));
    const entityKey = await Promise.race([write, timeout]).catch(() => null);
    return { entityKey, pending: entityKey === null };
  }

  /** Stores a route privately, publishes it and returns its public form. */
  async function recordRoute(route: Route, request: QuoteRequest, requestId: string, payer: string, swapToken: string) {
    const quoteId = newId("q");
    store.saveQuote({ id: quoteId, requestId, route, request, payer, validUntil: route.validUntil, swapToken });
    const publicRoute = { quoteId, ...humanRoute(route) };
    const arkiv = await publish(quoteId, {
      quoteId,
      requestId,
      venue: route.venue,
      fromAsset: route.from,
      toAsset: route.to,
      payer,
      status: "quoted",
      createdAt: Math.floor(now().getTime() / 1000),
      validUntil: toSeconds(route.validUntil),
      payload: { requestId, from: route.from, to: route.to, ...publicRoute },
    });
    return { ...publicRoute, arkiv };
  }

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/.well-known/x402", (c) =>
    c.json({
      network: PAYMENT_NETWORK,
      asset: "USDC",
      payTo: deps.payTo,
      ...(deps.arkivWriter ? { arkiv: { writer: deps.arkivWriter } } : {}),
      endpoints: [QUOTE_ENDPOINT, swapEndpoint].map((endpoint) => {
        const [method, path] = endpoint.key.split(" ");
        return { method, path, price: endpoint.priceUsd, description: endpoint.description };
      }),
      chains: [...new Set(listAssets().map((asset) => asset.chain))],
    }),
  );

  app.get("/v1/assets", (c) =>
    c.json({
      assets: listAssets().map((asset) => ({
        id: asset.id,
        chain: asset.chain,
        symbol: asset.symbol,
        decimals: asset.decimals,
        venues: [...(asset.uniswap ? [UNISWAP_VENUE] : []), SWAPKIT_VENUE],
      })),
    }),
  );

  app.post("/v1/quote", async (c) => {
    const parsed = parseQuoteRequest(await c.req.json().catch(() => null));
    if (!("request" in parsed)) return c.json({ error: parsed.error }, parsed.status);
    const { request } = parsed;

    const result = await guard.run(
      { endpoint: QUOTE_ENDPOINT, url: c.req.url, header: paymentHeader(c.req) },
      async (payer) => {
        const answers = await Promise.allSettled(venues.map((venue) => venue.quote(request)));
        const routes = answers.flatMap((answer) => (answer.status === "fulfilled" ? answer.value : []));
        for (const answer of answers) {
          if (answer.status === "rejected") onError("venue quote failed", answer.reason);
        }
        if (routes.length === 0) {
          const allFailed = answers.length > 0 && answers.every((answer) => answer.status === "rejected");
          return allFailed
            ? { status: 502, body: { error: "venues_unavailable" } }
            : { status: 422, body: { error: "no_route" } };
        }

        const requestId = newId("r");
        const swapToken = randomBytes(24).toString("base64url");
        const recorded = await Promise.all(
          rankRoutes(routes).map((route) => recordRoute(route, request, requestId, payer, swapToken)),
        );
        return { status: 200, body: { requestId, swapToken, routes: recorded }, usedBy: requestId };
      },
    );
    return respond(result);
  });

  app.get("/v1/quotes", async (c) => {
    const payer = c.req.query("payer");
    try {
      const quotes = payer ? await publisher.quotesByPayer(payer) : await publisher.recentQuotes();
      return c.json({ quotes });
    } catch (error) {
      onError("arkiv read failed", error);
      return c.json({ error: "arkiv_unavailable" }, 502);
    }
  });

  const swapBody = (swapId: string, venue: string, provider: string | undefined, prepared: PreparedSwap) => ({
    swapId,
    venue,
    ...(provider ? { provider } : {}),
    transactions: prepared.transactions,
    ...(prepared.deposit ? { deposit: prepared.deposit } : {}),
  });

  /** Runs the handler with no payment. Failures answer as they do on the paid path. */
  async function runFree(handler: (payer: string) => Promise<HandlerResult>, payer: string): Promise<GuardedResult> {
    try {
      const { status, body } = await handler(payer);
      return { status, body };
    } catch (error) {
      onError(`${swapEndpoint.key} handler failed`, error);
      return { status: 502, body: { error: "upstream_failed" } };
    }
  }

  app.post("/v1/swap", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { quoteId?: unknown; swapToken?: unknown } | null;
    if (typeof body?.quoteId !== "string") return c.json({ error: "quoteId is required" }, 400);
    const quote = store.getQuote(body.quoteId);
    if (!quote) return c.json({ error: "unknown_quote" }, 404);
    // Quote IDs are public on Arkiv, so holding one proves nothing.
    if (!tokenMatches(quote.swapToken, body.swapToken)) return c.json({ error: "invalid_swap_token" }, 403);

    const original = quote.route as Route;
    const request = quote.request as QuoteRequest;
    const existing = store.getSwapByQuote(quote.id);
    if (existing) {
      return c.json(swapBody(existing.id, existing.venue, original.provider, existing.prepared as PreparedSwap));
    }
    const venue = venues.find((candidate) => candidate.name === original.venue);
    if (!venue) return c.json({ error: "venue_unavailable" }, 502);

    const requote = async (error: string, route: Route): Promise<HandlerResult> => {
      if (store.countQuotes(quote.requestId) >= MAX_QUOTES_PER_REQUEST) {
        return { status: 429, body: { error: "too_many_requotes" } };
      }
      return {
        status: 409,
        body: { error, freshQuote: await recordRoute(route, request, quote.requestId, quote.payer, quote.swapToken!) },
      };
    };

    const handler = async (): Promise<HandlerResult> => {
      const routes = await venue.quote(request);
      const fresh = routes.find((route) => route.provider === original.provider);
      if (!fresh) {
        // Providers come and go between calls, so offer what's available now.
        const best = rankRoutes(routes)[0];
        return best ? requote("route_changed", best) : { status: 502, body: { error: "route_unavailable" } };
      }

      const expired = now().getTime() > new Date(quote.validUntil).getTime();
      const moved = BigInt(fresh.amountOut) < BigInt(original.minAmountOut);
      if (expired || moved) return requote(expired ? "quote_expired" : "price_moved", fresh);

      const flagged = await deps.screen?.([
        { address: request.from.address, asset: request.from.asset },
        { address: request.to.address, asset: request.to.asset },
      ]);
      if (flagged) return { status: 403, body: { error: "address_flagged" } };

      let prepared: PreparedSwap;
      try {
        prepared = await venue.prepare(fresh, request);
      } catch (error) {
        if (error instanceof VenueError && error.code) return { status: 422, body: { error: error.code } };
        throw error;
      }
      const swapId = newId("s");
      store.saveSwap({
        id: swapId,
        quoteId: quote.id,
        venue: venue.name,
        status: "awaiting_deposit",
        prepared,
        venueSwapId: prepared.venueSwapId ?? null,
      });
      // Tracking needs the route that was actually executed.
      store.setQuoteRoute(quote.id, fresh);
      if (quote.entityKey) {
        publisher
          .updateQuote(quote.entityKey, { status: "executing" })
          .catch((error: unknown) => onError(`arkiv update failed for ${quote.id}`, error));
      }
      return { status: 200, body: swapBody(swapId, venue.name, fresh.provider, prepared), usedBy: swapId };
    };

    const result = swapIsFree
      ? await runFree(handler, quote.payer)
      : await guard.run({ endpoint: swapEndpoint, url: c.req.url, header: paymentHeader(c.req) }, handler);
    return respond(result);
  });

  app.post("/v1/swaps/:id/tx", async (c) => {
    const swap = store.getSwap(c.req.param("id"));
    if (!swap) return c.json({ error: "unknown_swap" }, 404);
    const body = (await c.req.json().catch(() => null)) as { hash?: unknown } | null;
    if (typeof body?.hash !== "string" || !body.hash) return c.json({ error: "hash is required" }, 400);
    const known = swap.txHashes ?? [];
    if (!known.includes(body.hash)) {
      store.updateSwap(swap.id, { txHashes: [...known, body.hash] });
      lastTracked.delete(swap.id);
    }
    return c.json({ swapId: swap.id, txHashes: store.getSwap(swap.id)?.txHashes });
  });

  app.get("/v1/swaps/:id", async (c) => {
    const swap = store.getSwap(c.req.param("id"));
    if (!swap) return c.json({ error: "unknown_swap" }, 404);
    const quote = store.getQuote(swap.quoteId);
    if (!quote) return c.json({ error: "unknown_quote" }, 404);

    const due = now().getTime() - (lastTracked.get(swap.id) ?? -Infinity) >= trackIntervalMs;
    if (!TERMINAL.includes(swap.status) && due) {
      lastTracked.set(swap.id, now().getTime());
      await refreshSwap(swap.id, quote);
    }

    const current = store.getSwap(swap.id)!;
    return c.json({
      swapId: current.id,
      quoteId: current.quoteId,
      status: current.status,
      txHashes: current.txHashes,
      amountReceived: current.amountReceived,
      arkiv: { entityKey: quote.entityKey ?? null },
    });
  });

  /** Advances a swap from the venue. A tracking failure leaves the last known status. */
  async function refreshSwap(swapId: string, quote: NonNullable<ReturnType<Store["getQuote"]>>) {
    const swap = store.getSwap(swapId)!;
    const venue = venues.find((candidate) => candidate.name === swap.venue);
    if (!venue) return;

    try {
      const prepared = swap.prepared as PreparedSwap;
      const tracked = await venue.track({
        route: quote.route as Route,
        request: quote.request as QuoteRequest,
        prepared,
        txHashes: swap.txHashes ?? [],
        venueSwapId: swap.venueSwapId ?? null,
      });

      const deadline = prepared.deposit?.expiresAt;
      const lapsed =
        tracked.status === "awaiting_deposit" && deadline && now().getTime() > new Date(deadline).getTime();
      const status: SwapStatus = lapsed ? "expired" : tracked.status;

      store.updateSwap(swap.id, {
        status,
        ...(tracked.txHashes ? { txHashes: tracked.txHashes } : {}),
        ...(tracked.amountReceived ? { amountReceived: tracked.amountReceived } : {}),
      });

      if (TERMINAL.includes(status) && quote.entityKey) {
        await publisher
          .updateQuote(quote.entityKey, {
            status,
            ...(tracked.amountReceived ? { amountReceived: tracked.amountReceived } : {}),
            ...(tracked.txHashes ? { txHashes: tracked.txHashes } : {}),
          })
          .catch((error: unknown) => onError(`arkiv update failed for ${quote.id}`, error));
      }
    } catch (error) {
      onError(`tracking failed for ${swap.id}`, error);
    }
  }

  return app;
}
