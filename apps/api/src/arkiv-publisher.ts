import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { and, desc, eq } from "@arkiv-network/sdk/query";
import { bytes, defineSchema, str, u64 } from "@arkiv-network/sdk/schema";
import { http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PublicQuote, QuoteOutcome, QuotePublisher } from "./publisher.ts";

const PROJECT = "crossfare";
const QUOTE_TYPE = "quote";
/** Quotes stay readable briefly after they lapse, so late checks still work. */
const EXPIRY_GRACE_SECONDS = 120;
const COMPLETED_RETENTION_SECONDS = 7 * 24 * 3600;
const QUERY_LIMIT = 50;

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

export interface QuoteAttributes {
  project: string;
  type: string;
  quoteId: string;
  requestId: string;
  venue: string;
  fromAsset: string;
  toAsset: string;
  payer: string;
  status: string;
  createdAt: bigint;
  validUntil: bigint;
  payload: Uint8Array;
}

export interface QuotePatch {
  status: string;
  amountReceived?: string;
  txHashes?: string;
}

/** The SDK calls Crossfare needs, separated so the rules here are testable. */
export interface ArkivClients {
  create(attributes: QuoteAttributes, expiresInSeconds: number): Promise<string>;
  patch(entityKey: string, patch: QuotePatch): Promise<void>;
  extend(entityKey: string, seconds: number): Promise<void>;
  queryByPayer(payer: string, writer: string): Promise<unknown[]>;
}

export interface ArkivPublisherOptions {
  clients: ArkivClients;
  /** Queries match this owner only: anyone can write an entity that looks like ours. */
  writer: string;
  now?: () => Date;
}

export function createArkivPublisher(options: ArkivPublisherOptions): QuotePublisher {
  const { clients, writer } = options;
  const now = options.now ?? (() => new Date());

  // One wallet, one nonce sequence: concurrent writes would collide.
  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(write: () => Promise<T>): Promise<T> {
    const result = queue.then(write);
    queue = result.catch(() => undefined);
    return result;
  }

  return {
    publishQuote(quote: PublicQuote) {
      const { payload, ...attributes } = quote;
      const expiresIn =
        quote.validUntil - Math.floor(now().getTime() / 1000) + EXPIRY_GRACE_SECONDS;
      return enqueue(() =>
        clients.create(
          {
            ...attributes,
            project: PROJECT,
            type: QUOTE_TYPE,
            createdAt: BigInt(quote.createdAt),
            validUntil: BigInt(quote.validUntil),
            payload: new TextEncoder().encode(JSON.stringify(payload)),
          },
          expiresIn,
        ),
      );
    },

    async updateQuote(entityKey: string, outcome: QuoteOutcome) {
      const patch: QuotePatch = {
        status: outcome.status,
        ...(outcome.amountReceived ? { amountReceived: outcome.amountReceived } : {}),
        ...(outcome.txHashes?.length ? { txHashes: outcome.txHashes.join(",") } : {}),
      };
      await enqueue(() => clients.patch(entityKey, patch));
      if (outcome.status === "completed") {
        await enqueue(() => clients.extend(entityKey, COMPLETED_RETENTION_SECONDS));
      }
    },

    quotesByPayer(payer: string) {
      return clients.queryByPayer(payer, writer);
    },
  };
}

export interface ArkivConnection {
  privateKey: Hex;
  accessKey: string;
}

/** Connects to Arkiv's Rabdi testnet, the chain the prize page names. */
export function connectArkiv(connection: ArkivConnection): { clients: ArkivClients; writer: string } {
  const chain = rabdi({ accessKey: connection.accessKey });
  const account = privateKeyToAccount(connection.privateKey);
  const publicClient = createPublicClient({ chain, transport: http() });
  const walletClient = createWalletClient({ chain, transport: http(), account });

  return {
    writer: account.address,
    clients: {
      async create(attributes, expiresInSeconds) {
        const row = {
          ...attributes,
          createdAt: u64(attributes.createdAt),
          validUntil: u64(attributes.validUntil),
        };
        const { entityKey } = await walletClient.createEntity(QuoteSchema, row, {
          expiration: ExpirationTime.fromSeconds(expiresInSeconds),
        });
        return entityKey;
      },
      async patch(entityKey, patch) {
        await walletClient.patchEntity(QuoteSchema, entityKey as Hex, { set: patch });
      },
      async extend(entityKey, seconds) {
        await walletClient.extendEntity({
          entityKey: entityKey as Hex,
          expiration: ExpirationTime.fromSeconds(seconds),
        });
      },
      async queryByPayer(payer, writer) {
        const page = await publicClient
          .select({
            $key: true,
            quoteId: true,
            requestId: true,
            venue: true,
            fromAsset: true,
            toAsset: true,
            status: true,
            validUntil: true,
            payload: true,
            amountReceived: true,
          })
          .from(QuoteSchema)
          .where(and(eq("project", PROJECT), eq("payer", payer)))
          .ownedBy(writer as Hex)
          .orderBy(desc("createdAt"))
          .limit(QUERY_LIMIT)
          .fetch();
        return page.entities.map(toPlainRow);
      },
    },
  };
}

/** SDK rows hold typed value wrappers and bigints, neither of which survive JSON. */
function toPlainRow(row: Record<string, unknown>): Record<string, unknown> {
  const plain: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(row)) {
    const value = field && typeof field === "object" && "value" in field ? (field as { value: unknown }).value : field;
    if (name === "payload" && typeof value === "string") {
      plain.payload = JSON.parse(Buffer.from(value.slice(2), "hex").toString("utf8"));
    } else {
      plain[name === "$key" ? "entityKey" : name] = typeof value === "bigint" ? Number(value) : value;
    }
  }
  return plain;
}
