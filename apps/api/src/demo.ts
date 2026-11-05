import type { Hono } from "hono";

export type PaidPost = (path: string, body: unknown) => Promise<{ status: number; body: unknown }>;

export interface DemoLimits {
  perIpPerHour: number;
  perDay: number;
}

export interface DemoOptions {
  paidPost: PaidPost;
  limits: DemoLimits;
  now?: () => Date;
  onError?: (context: string, error: unknown) => void;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function createLimiter(limits: DemoLimits, now: () => Date) {
  const byIp = new Map<string, number[]>();
  let daily: number[] = [];

  return (ip: string): boolean => {
    const time = now().getTime();
    daily = daily.filter((at) => time - at < DAY_MS);
    const recent = (byIp.get(ip) ?? []).filter((at) => time - at < HOUR_MS);
    if (recent.length >= limits.perIpPerHour || daily.length >= limits.perDay) {
      byIp.set(ip, recent);
      return false;
    }
    byIp.set(ip, [...recent, time]);
    daily.push(time);
    return true;
  };
}

/**
 * Lets a visitor without a Hedera wallet use the UI: the server pays the x402 fee
 * from a testnet-only account. Swapped funds stay in the visitor's own wallet.
 * The daily limit is the real protection, since a forwarded IP can be spoofed.
 */
export function mountDemo(app: Hono, options: DemoOptions): void {
  const now = options.now ?? (() => new Date());
  const onError = options.onError ?? ((context, error) => console.error(context, error));
  const allow = createLimiter(options.limits, now);

  const forward = (route: string, target: string) =>
    app.post(route, async (c) => {
      const body = (await c.req.json().catch(() => null)) as unknown;
      if (body === null) return c.json({ error: "invalid_json" }, 400);
      const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
      if (!allow(ip)) return c.json({ error: "demo_limit_reached" }, 429);
      try {
        const result = await options.paidPost(target, body);
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "content-type": "application/json" },
        });
      } catch (error) {
        onError(`demo payment failed for ${target}`, error);
        return c.json({ error: "demo_payment_failed" }, 502);
      }
    });

  forward("/demo/quote", "/v1/quote");
  forward("/demo/swap", "/v1/swap");
}
