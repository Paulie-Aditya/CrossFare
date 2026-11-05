import { bytes, defineSchema, str, u64 } from "@arkiv-network/sdk/schema";

/** The public record of one quote. Shared so readers check exactly what the API writes. */
export const QuoteSchema = defineSchema("crossfare-quote", {
  project: str().indexed(),
  type: str().indexed(),
  quoteId: str().indexed(),
  requestId: str().indexed(),
  venue: str().indexed(),
  fromAsset: str().indexed(),
  toAsset: str().indexed(),
  payer: str().indexed(),
  status: str().indexed(),
  createdAt: u64().indexed(),
  validUntil: u64().indexed(),
  payload: bytes(),
  amountReceived: str().optional(),
  txHashes: str().optional(),
});
