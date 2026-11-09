import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { compress } from "hono/compress";
import {
  fromBaseUnits,
  getAsset,
  isValidAddress,
  listAssets,
  listChains,
  displaySymbol,
  preferDirectRoutes,
  rankRoutes,
  toBaseUnits,
  VenueError,
  type PreparedSwap,
  type QuoteRequest,
  type Route,
  type ScreenAddresses,
  type SwapStatus,
  type Venue,
  describeSwap,
  withUsdValues,
  type Deposit,
  contractRef,
  evmChainByCode,
  findAssetByContract,
  UNISWAP_CHAINS,
  type Asset,
} from "@crossfare/core";
import type { TokenLookup } from "./token-lookup.ts";
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
import type { Store, VipScope } from "./store.ts";
import { createVipGate, type VipGate } from "./vip.ts";

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
  /** Reads what's in a deposit address, which is often visible before a venue reports it. */
  depositBalance?: (deposit: Deposit) => Promise<string | null>;
  /** The least time between chain reads for one swap. */
  depositWatchMs?: number;
  /** The least time between price checks to the venues, across all callers. */
  priceIntervalMs?: number;
  /** How long a quote response waits for Arkiv before flagging the write as pending. */
  publishTimeoutMs?: number;
  onError?: (context: string, error: unknown) => void;
  /** Callers with a key who skip x402. Defaults to the keys in the store. */
  vip?: VipGate;
  /** Finds tokens by contract, reading unlisted ones from the chain. Without it only listed tokens resolve. */
  tokens?: TokenLookup;
}

/** Bounds what one paid quote can make Crossfare write to Arkiv through re-quotes. */
const MAX_QUOTES_PER_REQUEST = 20;

/** Providers keep channels open for days, but a price shouldn't be promised that long. */
const ORDER_WINDOW_MS = 30 * 60_000;

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

function publicAsset(asset: Asset) {
  return {
    id: asset.id,
    chain: asset.chain,
    symbol: asset.symbol,
    name: asset.name ?? displaySymbol(asset.symbol),
    decimals: asset.decimals,
    evm: asset.evmChainId !== undefined,
    ...(asset.logo ? { logo: asset.logo } : {}),
    venues: [...(asset.uniswap ? [UNISWAP_VENUE] : []), ...(asset.swapkit ? [SWAPKIT_VENUE] : [])],
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
    ...(route.usd ? { usd: route.usd } : {}),
  };
}

interface PriceAnswer {
  amount: string;
  amountOut: string;
  venue: string;
  provider?: string;
  usd?: { in: number; out: number };
  etaSeconds: number;
  estimated: boolean;
}

const PRICE_CACHE_MS = 20_000;

/** A price check at another amount, using the last rate seen for the pair. */
function scalePrice(known: PriceAnswer, amount: string): PriceAnswer {
  const ratio = Number(amount) / Number(known.amount);
  return {
    ...known,
    amount,
    amountOut: String(Number(known.amountOut) * ratio),
    ...(known.usd ? { usd: { in: known.usd.in * ratio, out: known.usd.out * ratio } } : {}),
    estimated: true,
  };
}

const TERMINAL: readonly SwapStatus[] = ["completed", "refunded", "failed", "expired"];

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

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
  const trackIntervalMs = deps.trackIntervalMs ?? 10_000;
  const lastTracked = new Map<string, number>();
  const depositWatchMs = deps.depositWatchMs ?? 4_000;
  const lastWatched = new Map<string, number>();
  const priceIntervalMs = deps.priceIntervalMs ?? 7_000;
  const priceCache = new Map<string, { at: number; answer: PriceAnswer }>();
  const pairRates = new Map<string, PriceAnswer>();
  let lastPriceCall = -Infinity;
  const onError = deps.onError ?? ((context, error) => console.error(context, error));
  const guard = createPaymentGuard({ gateway: deps.gateway, store, audit: deps.audit, onError });
  const swapEndpoint: PricedEndpoint = { ...SWAP_ENDPOINT, priceUsd: deps.swapPriceUsd || SWAP_ENDPOINT.priceUsd };
  const swapIsFree = !(Number(swapEndpoint.priceUsd) > 0);
  const vip = deps.vip ?? createVipGate({ store, now });
  const app = new Hono();

  const paymentHeader = (headers: { header(name: string): string | undefined }) =>
    headers.header("payment-signature") ?? headers.header("x-payment");

  const respond = (result: GuardedResult) =>
    new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json", ...result.headers },
    });

  /** Runs the handler with no payment. Failures answer as they do on the paid path. */
  async function runUnpaid(endpoint: PricedEndpoint, handler: (payer: string) => Promise<HandlerResult>, payer: string): Promise<HandlerResult> {
    try {
      return await handler(payer);
    } catch (error) {
      onError(`${endpoint.key} handler failed`, error);
      return { status: 502, body: { error: "upstream_failed" } };
    }
  }

  /**
   * A VIP credential is checked first (FR-29): a valid one skips x402 and is metered on
   * success; a bad one gets the normal 402 with the reason. Anyone else pays as usual.
   */
  async function charged(
    c: Context,
    endpoint: PricedEndpoint,
    scope: VipScope,
    rawBody: string,
    handler: (payer: string) => Promise<HandlerResult>,
  ): Promise<GuardedResult> {
    const decision = vip.check(
      {
        authorization: c.req.header("authorization"),
        timestamp: c.req.header("x-crossfare-timestamp"),
        signature: c.req.header("x-crossfare-sign"),
        method: c.req.method,
        path: c.req.path,
        body: rawBody,
      },
      scope,
    );
    if (decision.kind === "denied") {
      if (decision.status !== 402) return { status: decision.status, body: { error: decision.error } };
      const required = await deps.gateway.paymentRequired(endpoint, c.req.url, decision.error);
      return { status: 402, body: { ...(required.body as object), error: decision.error }, headers: required.headers };
    }
    if (decision.kind === "allowed") {
      const { status, body, usedBy } = await runUnpaid(endpoint, handler, decision.payer);
      if (status < 400) vip.record(decision.key, endpoint.key, usedBy ?? "");
      return { status, body };
    }
    return guard.run({ endpoint, url: c.req.url, header: paymentHeader(c.req) }, handler);
  }

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
      summary: describeSwap({ from: route.from, to: route.to, amountIn: route.amountIn, amountOut: route.amountOut, outcome: "quoted" }),
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

  // Thousands of tokens, so it's compressed and cacheable.
  app.get("/v1/assets", compress(), (c) => {
    c.header("cache-control", "public, max-age=3600");
    return c.json({ chains: listChains(), assets: listAssets().map(publicAsset) });
  });

  const findToken = (chainId: number, address: string) =>
    deps.tokens ? deps.tokens.find(chainId, address) : Promise.resolve(findAssetByContract(chainId, address) ?? null);

  // Free, like the asset list: it's how a picker finds a pasted contract.
  app.get("/v1/tokens/:address", async (c) => {
    const address = c.req.param("address");
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return c.json({ error: "address must be a 0x contract address" }, 400);
    const chain = c.req.query("chain");
    const chains = chain ? [evmChainByCode(chain)].filter((entry) => entry !== undefined) : UNISWAP_CHAINS;
    if (chains.length === 0) return c.json({ error: `Uniswap doesn't trade on ${chain}` }, 400);
    const found = await Promise.all(chains.map((entry) => findToken(entry.chainId, address)));
    return c.json({ tokens: found.flatMap((asset) => (asset ? [{ ...publicAsset(asset), verified: !asset.unlisted }] : [])) });
  });

  /** Turns `chain:0x…` into the token's ID, reading an unlisted token from the chain. Other IDs pass through. */
  async function canonicalAsset(id: unknown): Promise<unknown> {
    if (typeof id !== "string") return id;
    const ref = contractRef(id);
    if (!ref) return id;
    return (await findToken(ref.chainId, ref.address))?.id ?? id;
  }

  async function withCanonicalAssets(input: unknown): Promise<unknown> {
    const body = input as { from?: { asset?: unknown }; to?: { asset?: unknown } } | null;
    if (!body?.from || !body.to) return input;
    return {
      ...body,
      from: { ...body.from, asset: await canonicalAsset(body.from.asset) },
      to: { ...body.to, asset: await canonicalAsset(body.to.asset) },
    };
  }

  app.post("/v1/quote", async (c) => {
    // The raw body is what a VIP caller signs.
    const rawBody = await c.req.text();
    const parsed = parseQuoteRequest(await withCanonicalAssets(parseJson(rawBody)));
    if (!("request" in parsed)) return c.json({ error: parsed.error }, parsed.status);
    const { request } = parsed;

    const result = await charged(c, QUOTE_ENDPOINT, "quote", rawBody,
      async (payer) => {
        const answers = await Promise.allSettled(venues.map((venue) => venue.quote(request)));
        const routes = withUsdValues(preferDirectRoutes(venues, answers.flatMap((answer) => (answer.status === "fulfilled" ? answer.value : []))));
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
        const unlisted = [request.from.asset, request.to.asset].filter((id) => getAsset(id).unlisted);
        const warnings = unlisted.map((asset) => ({ code: "unlisted_token", asset }));
        return {
          status: 200,
          body: { requestId, swapToken, from: request.from.asset, to: request.to.asset, ...(warnings.length ? { warnings } : {}), routes: recorded },
          usedBy: requestId,
        };
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

  function capOrderWindow(prepared: PreparedSwap): PreparedSwap {
    if (!prepared.deposit) return prepared;
    const limit = now().getTime() + ORDER_WINDOW_MS;
    const venueDeadline = prepared.deposit.expiresAt ? new Date(prepared.deposit.expiresAt).getTime() : Infinity;
    return {
      ...prepared,
      deposit: {
        ...prepared.deposit,
        expiresAt: new Date(Math.min(limit, venueDeadline)).toISOString(),
        // The order window limits what Crossfare promises. A refund still runs on the provider's clock.
        ...(prepared.deposit.expiresAt ? { refundBy: prepared.deposit.expiresAt } : {}),
      },
    };
  }

  const swapBody = (swapId: string, venue: string, provider: string | undefined, prepared: PreparedSwap) => ({
    swapId,
    venue,
    ...(provider ? { provider } : {}),
    transactions: prepared.transactions,
    ...(prepared.deposit ? { deposit: prepared.deposit } : {}),
  });


  app.post("/v1/swap", async (c) => {
    const rawBody = await c.req.text();
    const body = parseJson(rawBody) as { quoteId?: unknown; swapToken?: unknown } | null;
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
        prepared = capOrderWindow(await venue.prepare(fresh, request));
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

    const result: GuardedResult = swapIsFree
      ? await runUnpaid(swapEndpoint, handler, quote.payer)
      : await charged(c, swapEndpoint, "swap", rawBody, handler);
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

  /**
   * The price shown while someone types. It is free, unpublished and can't be executed:
   * only a paid quote gets an ID. The venues rate-limit Crossfare, so callers share a
   * cache and an interval, and fall back on the pair's last rate.
   */
  app.get("/v1/price", async (c) => {
    const from = c.req.query("from") ?? "";
    const to = c.req.query("to") ?? "";
    const amount = c.req.query("amount") ?? "";
    let positive = false;
    try {
      positive = /^[0-9]*\.?[0-9]+$/.test(amount) && toBaseUnits(amount, getAsset(from).decimals) > 0n && !!getAsset(to);
    } catch {
      positive = false;
    }
    if (!positive || from === to) return c.json({ error: "invalid_price_request" }, 400);

    const time = now().getTime();
    const key = `${from}|${to}|${amount}`;
    const cached = priceCache.get(key);
    if (cached && time - cached.at < PRICE_CACHE_MS) return c.json(cached.answer);

    if (time - lastPriceCall < priceIntervalMs) {
      const known = pairRates.get(`${from}|${to}`);
      return known ? c.json(scalePrice(known, amount)) : c.json({ error: "price_busy" }, 429);
    }
    lastPriceCall = time;

    const sameChain = from.split(":")[0] === to.split(":")[0];
    const request: QuoteRequest = {
      from: { asset: from, amount, address: "" },
      to: { asset: to, address: "" },
      mode: "exact_in",
      slippageBps: sameChain ? 50 : 300,
      indicative: true,
    };
    const answers = await Promise.allSettled(venues.map((venue) => venue.quote(request)));
    const routes = rankRoutes(withUsdValues(preferDirectRoutes(venues, answers.flatMap((answer) => (answer.status === "fulfilled" ? answer.value : [])))));
    const best = routes[0];
    if (!best) {
      const allFailed = answers.length > 0 && answers.every((answer) => answer.status === "rejected");
      return allFailed ? c.json({ error: "venues_unavailable" }, 502) : c.json({ error: "no_route" }, 422);
    }
    const answer: PriceAnswer = {
      amount,
      amountOut: fromBaseUnits(best.amountOut, getAsset(to).decimals),
      venue: best.venue,
      ...(best.provider ? { provider: best.provider } : {}),
      ...(best.usd ? { usd: best.usd } : {}),
      etaSeconds: best.etaSeconds,
      estimated: false,
    };
    priceCache.set(key, { at: time, answer });
    pairRates.set(`${from}|${to}`, answer);
    return c.json(answer);
  });

  app.get("/v1/swaps/:id", async (c) => {
    const swap = store.getSwap(c.req.param("id"));
    if (!swap) return c.json({ error: "unknown_swap" }, 404);
    const quote = store.getQuote(swap.quoteId);
    if (!quote) return c.json({ error: "unknown_quote" }, 404);

    const deposit = (swap.prepared as PreparedSwap).deposit;
    const watchDue = now().getTime() - (lastWatched.get(swap.id) ?? -Infinity) >= depositWatchMs;
    if (swap.status === "awaiting_deposit" && deposit && deps.depositBalance && watchDue) {
      lastWatched.set(swap.id, now().getTime());
      const seen = await deps.depositBalance(deposit).catch((error: unknown) => {
        onError(`deposit check failed for ${swap.id}`, error);
        return null;
      });
      if (seen) recordBalance(swap.id, deposit, seen);
    }

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
      amountSent: current.depositDetails?.amountSent ?? null,
      depositShort: current.depositDetails?.depositShort ?? null,
      refundReason: current.depositDetails?.refundReason ?? null,
      partialRefund: current.depositDetails?.partialRefund ?? false,
      ...(deposit?.minAmount ? { minAmount: deposit.minAmount } : {}),
      ...(deposit?.refundBy ? { refundBy: deposit.refundBy } : {}),
      arkiv: { entityKey: quote.entityKey ?? null },
    });
  });

  function outcomeSummary(route: Route, outcome: string, received?: string, sent?: string) {
    const amountOut = received ? toBaseUnits(received, getAsset(route.to).decimals).toString() : route.amountOut;
    const amountIn = sent ? toBaseUnits(sent, getAsset(route.from).decimals).toString() : route.amountIn;
    return describeSwap({ from: route.from, to: route.to, amountIn, amountOut, outcome });
  }

  /** Below a provider's minimum a deposit isn't swapped. With no minimum documented, only dust is ignored. */
  function depositLevel(deposit: Deposit, amount: string): "enough" | "short" | "dust" {
    const { decimals } = getAsset(deposit.asset);
    const got = toBaseUnits(amount, decimals);
    if (deposit.minAmount) return got >= toBaseUnits(deposit.minAmount, decimals) ? "enough" : "short";
    return got * 2n >= toBaseUnits(deposit.amount, decimals) ? "enough" : "dust";
  }

  function recordBalance(swapId: string, deposit: Deposit, balance: string) {
    const details = store.getSwap(swapId)?.depositDetails ?? {};
    const level = depositLevel(deposit, balance);
    if (level === "short") {
      store.updateSwap(swapId, { depositDetails: { ...details, depositShort: balance } });
    } else if (level === "enough") {
      const { depositShort: _cleared, ...rest } = details;
      store.updateSwap(swapId, { status: "confirming", depositDetails: { ...rest, amountSent: balance } });
    }
  }

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
      const finished = TERMINAL.includes(tracked.status);
      const reportedShort =
        !finished && prepared.deposit && tracked.amountSent && depositLevel(prepared.deposit, tracked.amountSent) === "short"
          ? tracked.amountSent
          : undefined;
      const { depositShort: seenShort, ...earlier } = swap.depositDetails ?? {};
      const depositShort = finished ? undefined : (reportedShort ?? seenShort);
      const lapsed =
        tracked.status === "awaiting_deposit" && !depositShort && deadline && now().getTime() > new Date(deadline).getTime();
      // A venue can lag the chain, and a swap that has started must not read as unstarted.
      const lagging = tracked.status === "awaiting_deposit" && swap.status !== "awaiting_deposit";
      const status: SwapStatus = reportedShort ? "awaiting_deposit" : lagging ? swap.status : lapsed ? "expired" : tracked.status;
      const amountSent = reportedShort ? earlier.amountSent : (tracked.amountSent ?? earlier.amountSent);

      store.updateSwap(swap.id, {
        status,
        ...(tracked.txHashes ? { txHashes: tracked.txHashes } : {}),
        ...(tracked.amountReceived ? { amountReceived: tracked.amountReceived } : {}),
        depositDetails: {
          ...earlier,
          ...(amountSent ? { amountSent } : {}),
          ...(depositShort ? { depositShort } : {}),
          ...(tracked.refundReason ? { refundReason: tracked.refundReason } : {}),
          ...(tracked.partialRefund ? { partialRefund: true } : {}),
        },
      });

      if (TERMINAL.includes(status) && quote.entityKey) {
        await publisher
          .updateQuote(quote.entityKey, {
            status,
            summary: outcomeSummary(quote.route as Route, status, tracked.amountReceived, amountSent),
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
