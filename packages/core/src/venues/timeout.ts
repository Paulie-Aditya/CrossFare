import type { Route } from "../routes.ts";
import { VenueError, type QuoteRequest, type Venue } from "./types.ts";

/**
 * Every quote waits for all venues, so one that never answers would hold up every pair it
 * serves. Past the limit its quote fails like any venue error, and the others' routes stand.
 */
export function withQuoteTimeout(venue: Venue, ms: number): Venue {
  return {
    ...venue,
    quote(request: QuoteRequest): Promise<Route[]> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new VenueError(venue.name, 504, `no quote within ${ms} ms`)), ms);
      });
      return Promise.race([venue.quote(request), late]).finally(() => clearTimeout(timer));
    },
  };
}
