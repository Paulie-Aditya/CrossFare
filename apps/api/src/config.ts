import type { Hex } from "viem";

export interface Config {
  uniswapApiKey: string;
  swapkitApiKey: string;
  arkivPrivateKey: Hex;
  arkivAccessKey: string;
  hederaOperatorId: string;
  hederaOperatorKey: string;
  payToAccount: string;
  hcsTopicId: string;
  usdcTokenId: string;
  facilitatorUrl: string;
  baseRpcUrl: string;
  port: number;
  databasePath: string;
}

const REQUIRED = [
  "UNISWAP_API_KEY",
  "SWAPKIT_API_KEY",
  "ARKIV_PRIVATE_KEY",
  "ARKIV_ACCESS_KEY",
  "HEDERA_OPERATOR_ID",
  "HEDERA_OPERATOR_KEY",
  "HEDERA_PAY_TO_ACCOUNT",
  "HEDERA_HCS_TOPIC_ID",
] as const;

/** Hedera testnet USDC, from Circle's published contract addresses. */
const TESTNET_USDC = "0.0.429274";

export function loadConfig(env: Record<string, string | undefined>): Config {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  if (!/^0x[0-9a-fA-F]+$/.test(env.ARKIV_PRIVATE_KEY!)) {
    throw new Error("ARKIV_PRIVATE_KEY must be a 0x-prefixed hex string");
  }
  return {
    uniswapApiKey: env.UNISWAP_API_KEY!,
    swapkitApiKey: env.SWAPKIT_API_KEY!,
    arkivPrivateKey: env.ARKIV_PRIVATE_KEY as Hex,
    arkivAccessKey: env.ARKIV_ACCESS_KEY!,
    hederaOperatorId: env.HEDERA_OPERATOR_ID!,
    hederaOperatorKey: env.HEDERA_OPERATOR_KEY!,
    payToAccount: env.HEDERA_PAY_TO_ACCOUNT!,
    hcsTopicId: env.HEDERA_HCS_TOPIC_ID!,
    usdcTokenId: env.HEDERA_USDC_TOKEN_ID || TESTNET_USDC,
    facilitatorUrl: env.X402_FACILITATOR_URL || "https://x402.org/facilitator",
    baseRpcUrl: env.BASE_RPC_URL || "https://mainnet.base.org",
    port: Number(env.PORT || 8787),
    databasePath: env.DATABASE_PATH || "crossfare.db",
  };
}
