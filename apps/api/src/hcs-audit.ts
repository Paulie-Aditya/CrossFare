import { AccountId, Client, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import type { AuditEntry, AuditLog } from "./payment.ts";
import { parseHederaKey } from "@crossfare/core/hedera-key";

export type SubmitMessage = (message: string) => Promise<void>;

/** Writes each settled payment to a public HCS topic: the owner's spending log (FR-7). */
export function createHcsAudit(submit: SubmitMessage): AuditLog {
  return {
    log: (entry: AuditEntry) =>
      submit(
        JSON.stringify({
          payer: entry.payer,
          endpoint: entry.endpoint,
          amount: entry.amount,
          asset: "USDC",
          usedBy: entry.usedBy,
          transactionId: entry.transactionId,
        }),
      ),
  };
}

export function connectHcs(operatorId: string, operatorKey: string, topicId: string): SubmitMessage {
  const client = Client.forTestnet().setOperator(
    AccountId.fromString(operatorId),
    parseHederaKey(operatorKey),
  );
  return async (message) => {
    const response = await new TopicMessageSubmitTransaction({ topicId, message }).execute(client);
    await response.getReceipt(client);
  };
}
