// Creates the public HCS topic for the payment audit log. Prints the ID for .env.
import { AccountId, Client, TopicCreateTransaction } from "@hiero-ledger/sdk";
import { parseHederaKey } from "@crossfare/core/hedera-key";

const { HEDERA_OPERATOR_ID, HEDERA_OPERATOR_KEY } = process.env;
if (!HEDERA_OPERATOR_ID || !HEDERA_OPERATOR_KEY) {
  throw new Error("Set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY in .env");
}

const client = Client.forTestnet().setOperator(
  AccountId.fromString(HEDERA_OPERATOR_ID),
  parseHederaKey(HEDERA_OPERATOR_KEY),
);
const response = await new TopicCreateTransaction().setTopicMemo("Crossfare x402 payment audit log").execute(client);
const { topicId } = await response.getReceipt(client);
console.log(`HEDERA_HCS_TOPIC_ID=${topicId}`);
client.close();
