/** A quote as it appears publicly on Arkiv. Holds no addresses and no venue state. */
export interface PublicQuote {
  quoteId: string;
  requestId: string;
  venue: string;
  fromAsset: string;
  toAsset: string;
  payer: string;
  status: string;
  /** One readable line about the swap, with no addresses. */
  summary?: string;
  createdAt: number;
  validUntil: number;
  /** Normalized route in human units. */
  payload: Record<string, unknown>;
}

export interface QuoteOutcome {
  status: string;
  summary?: string;
  amountReceived?: string;
  txHashes?: string[];
}

export interface QuotePublisher {
  /** Resolves with the entity key once the write is in a block. */
  publishQuote(quote: PublicQuote): Promise<string>;
  /** Records execution status and, for finished swaps, extends the record's lifetime. */
  updateQuote(entityKey: string, outcome: QuoteOutcome): Promise<void>;
  quotesByPayer(payer: string): Promise<unknown[]>;
  recentQuotes(): Promise<unknown[]>;
}
