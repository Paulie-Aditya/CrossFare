import { parseArgs } from "node:util";
import type { Goal } from "./run.ts";

const USDC_DECIMALS = 1_000_000;
const TESTNET_USDC = "0.0.429274";

export interface AgentConfig {
  apiUrl: string;
  hederaAccount: string;
  hederaKey: string;
  evmPrivateKey: `0x${string}`;
  arkivAccessKey: string;
  allowedPayTo: string[];
  allowLiveSwaps: boolean;
  perCallCap: bigint;
  totalBudget: bigint;
  usdcTokenId: string;
  baseRpcUrl: string;
}

const REQUIRED = [
  "AGENT_HEDERA_ACCOUNT",
  "AGENT_HEDERA_KEY",
  "AGENT_EVM_PRIVATE_KEY",
  "ARKIV_ACCESS_KEY",
  "AGENT_ALLOWED_PAY_TO",
] as const;

const usdc = (value: string) => BigInt(Math.round(Number(value) * USDC_DECIMALS));

export function loadAgentConfig(env: Record<string, string | undefined>): AgentConfig {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  return {
    apiUrl: env.CROSSFARE_API_URL || "http://localhost:8787",
    hederaAccount: env.AGENT_HEDERA_ACCOUNT!,
    hederaKey: env.AGENT_HEDERA_KEY!,
    evmPrivateKey: env.AGENT_EVM_PRIVATE_KEY as `0x${string}`,
    arkivAccessKey: env.ARKIV_ACCESS_KEY!,
    allowedPayTo: env.AGENT_ALLOWED_PAY_TO!.split(",").map((account) => account.trim()),
    allowLiveSwaps: env.AGENT_ALLOW_LIVE_SWAPS === "true",
    perCallCap: usdc(env.AGENT_PER_CALL_CAP_USDC || "0.10"),
    totalBudget: usdc(env.AGENT_BUDGET_USDC || "0.20"),
    usdcTokenId: env.HEDERA_USDC_TOKEN_ID || TESTNET_USDC,
    baseRpcUrl: env.BASE_RPC_URL || "https://mainnet.base.org",
  };
}

export function parseGoalArgs(args: string[], sender: string): Goal {
  const { values } = parseArgs({
    args,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      amount: { type: "string" },
      recipient: { type: "string" },
      "slippage-bps": { type: "string" },
    },
  });
  if (!values.from) throw new Error("--from is required");
  if (!values.to) throw new Error("--to is required");
  if (!values.amount) throw new Error("--amount is required");
  return {
    from: { asset: values.from, amount: values.amount, address: sender },
    to: { asset: values.to, address: values.recipient ?? sender },
    slippageBps: Number(values["slippage-bps"] ?? 50),
    refundAddress: sender,
  };
}
