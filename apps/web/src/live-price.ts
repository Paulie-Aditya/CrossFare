import { useEffect, useState } from "react";
import { get } from "./api.ts";
import { isPriceable } from "./journey.ts";

export interface LivePrice {
  amount: string;
  amountOut: string;
  venue: string;
  provider?: string;
  usd?: { in: number; out: number };
  etaSeconds: number;
  estimated: boolean;
}

export type PriceState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; price: LivePrice; refreshMs: number; fetchedAt: number }
  | { status: "no_route" }
  | { status: "unavailable" };

const DEBOUNCE_MS = 500;
const REFRESH_MS = 30_000;
/** Soon enough to replace an estimate, and past the API's shared interval. */
const ESTIMATE_RETRY_MS = 8_000;

/**
 * Follows the amount as it's typed. It waits for a pause, drops answers to older
 * amounts, and keeps the price fresh while the tab is visible.
 */
export function useLivePrice(from: string, to: string, amount: string, enabled: boolean): PriceState {
  const [state, setState] = useState<PriceState>({ status: "idle" });

  useEffect(() => {
    if (!enabled || !isPriceable(amount) || from === to) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const query = `/v1/price?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&amount=${encodeURIComponent(amount)}`;

    async function load() {
      if (document.hidden) {
        timer = setTimeout(load, REFRESH_MS);
        return;
      }
      const answer = await get(query).catch(() => null);
      if (cancelled) return;
      if (answer?.ok) {
        const refreshMs = answer.body.estimated ? ESTIMATE_RETRY_MS : REFRESH_MS;
        setState({ status: "ready", price: answer.body, refreshMs, fetchedAt: Date.now() });
        timer = setTimeout(load, refreshMs);
      } else if (answer?.status === 422) {
        setState({ status: "no_route" });
      } else if (answer?.status === 429) {
        timer = setTimeout(load, ESTIMATE_RETRY_MS);
      } else {
        setState({ status: "unavailable" });
        timer = setTimeout(load, REFRESH_MS);
      }
    }

    setState({ status: "loading" });
    timer = setTimeout(load, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [from, to, amount, enabled]);

  return state;
}
