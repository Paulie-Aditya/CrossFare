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
  /** Unset means POST /v1/swap is free. */
  swapPriceUsd?: string;
  /** RPC endpoints by EVM chain ID. A chain without one uses its public RPCs. */
  rpcUrls: Record<number, string>;
  port: number;
  databasePath: string;
  webRoot: string;
  /** Pays the x402 fee for visitors to the UI. Null turns the /demo routes off. */
  demo: { accountId: string; privateKey: string; limits: { perIpPerHour: number; perDay: number } } | null;
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

/** RPC_URL_<chainId> for any chain. BASE_RPC_URL and ETHEREUM_RPC_URL still work, and lose to the numbered name. */
function rpcUrls(env: Record<string, string | undefined>): Record<number, string> {
  const urls: Record<number, string> = {};
  if (env.ETHEREUM_RPC_URL) urls[1] = env.ETHEREUM_RPC_URL;
  if (env.BASE_RPC_URL) urls[8453] = env.BASE_RPC_URL;
  for (const [name, value] of Object.entries(env)) {
    const match = /^RPC_URL_(\d+)$/.exec(name);
    if (match && value) urls[Number(match[1])] = value;
  }
  return urls;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const demoAccount = env.DEMO_HEDERA_ACCOUNT || env.AGENT_HEDERA_ACCOUNT;
  const demoKey = env.DEMO_HEDERA_KEY || env.AGENT_HEDERA_KEY;
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
    ...(env.SWAP_PRICE_USDC ? { swapPriceUsd: env.SWAP_PRICE_USDC } : {}),
    rpcUrls: rpcUrls(env),
    port: Number(env.PORT || 8787),
    databasePath: env.DATABASE_PATH || "crossfare.db",
    webRoot: env.WEB_ROOT || "../web/dist",
    demo:
      demoAccount && demoKey
        ? {
            accountId: demoAccount,
            privateKey: demoKey,
            limits: {
              perIpPerHour: Number(env.DEMO_LIMIT_PER_IP_HOUR || 20),
              perDay: Number(env.DEMO_LIMIT_PER_DAY || 200),
            },
          }
        : null,
  };
}
