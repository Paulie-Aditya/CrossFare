import { parseArgs } from "node:util";
import { isValidAddress, parseAssetId } from "@crossfare/core";
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
  /** By chain ID. Ethereum and Base have defaults; any other chain can be set as RPC_URL_<chainId>. */
  rpcUrls: Record<number, string>;
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
    rpcUrls: {
      1: env.ETHEREUM_RPC_URL || "https://ethereum-rpc.publicnode.com",
      8453: env.BASE_RPC_URL || "https://mainnet.base.org",
      ...Object.fromEntries(
        Object.entries(env).flatMap(([name, value]) => {
          const match = /^RPC_URL_(\d+)$/.exec(name);
          return match && value ? [[Number(match[1]), value]] : [];
        }),
      ),
    },
  };
}

const ADDRESS_ATTEMPTS = 3;
const CROSS_CHAIN_SLIPPAGE_BPS = 300;
const SAME_CHAIN_SLIPPAGE_BPS = 50;

/** Reads the instruction. Swapped funds go only to an address someone actually gave. */
export async function resolveGoal(
  args: string[],
  sender: string,
  ask: (question: string) => Promise<string>,
): Promise<Goal> {
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
  const { from, to, amount } = values;

  let recipient = values.recipient?.trim();
  if (recipient !== undefined && !isValidAddress(to, recipient)) {
    throw new Error(`--recipient is not a valid receiving address for ${to}`);
  }
  const chain = parseAssetId(to).chain;
  for (let attempt = 0; recipient === undefined && attempt < ADDRESS_ATTEMPTS; attempt++) {
    const answer = (await ask(`Receiving address on ${chain}: `)).trim();
    if (isValidAddress(to, answer)) recipient = answer;
  }
  if (recipient === undefined) throw new Error(`No valid receiving address for ${to}`);

  const crossChain = parseAssetId(from).chain !== chain;
  const defaultSlippage = crossChain ? CROSS_CHAIN_SLIPPAGE_BPS : SAME_CHAIN_SLIPPAGE_BPS;
  return {
    from: { asset: from, amount, address: sender },
    to: { asset: to, address: recipient },
    slippageBps: Number(values["slippage-bps"] ?? defaultSlippage),
    refundAddress: sender,
  };
}
