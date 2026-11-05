// Associates testnet USDC with Crossfare's fee account and the agent's account.
// Hedera refuses token transfers to an account until this is done. Safe to re-run.
import { parseHederaKey } from "@crossfare/core/hedera-key";
import { AccountId, Client, Status, StatusError, TokenAssociateTransaction } from "@hiero-ledger/sdk";

const TESTNET_USDC = "0.0.429274";
const env = process.env;
const token = env.HEDERA_USDC_TOKEN_ID || TESTNET_USDC;

const accounts = [
  { name: "Crossfare fee account", id: env.HEDERA_OPERATOR_ID, key: env.HEDERA_OPERATOR_KEY },
  { name: "Agent account", id: env.AGENT_HEDERA_ACCOUNT, key: env.AGENT_HEDERA_KEY },
];

for (const { name, id, key } of accounts) {
  if (!id || !key) {
    console.log(`${name}: skipped, its ID or key isn't set in .env`);
    continue;
  }
  const accountId = AccountId.fromString(id);
  const privateKey = parseHederaKey(key);
  const client = Client.forTestnet().setOperator(accountId, privateKey);
  try {
    const response = await new TokenAssociateTransaction({ accountId, tokenIds: [token] }).execute(client);
    await response.getReceipt(client);
    console.log(`${name} ${id}: associated with ${token}`);
  } catch (error) {
    if (error instanceof StatusError && error.status === Status.TokenAlreadyAssociatedToAccount) {
      console.log(`${name} ${id}: already associated with ${token}`);
    } else {
      throw error;
    }
  } finally {
    client.close();
  }
}
console.log("Next: get testnet USDC for the agent account from https://faucet.circle.com (choose Hedera testnet).");
