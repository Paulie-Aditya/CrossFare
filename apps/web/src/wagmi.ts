import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { WALLET_CHAINS } from "./wallet-chains.ts";

const chains = WALLET_CHAINS.map((entry) => entry.chain) as unknown as readonly [(typeof WALLET_CHAINS)[number]["chain"], ...(typeof WALLET_CHAINS)[number]["chain"][]];

export const wagmiConfig = createConfig({
  chains,
  connectors: [injected()],
  transports: Object.fromEntries(chains.map((chain) => [chain.id, http()])) as Record<(typeof chains)[number]["id"], ReturnType<typeof http>>,
});

export type WalletChainId = (typeof chains)[number]["id"];
