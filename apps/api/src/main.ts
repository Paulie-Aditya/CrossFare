import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createPublicClient, erc20Abi, fallback, http, type Address, type Hash, type PublicClient } from "viem";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createSwapKitScreen,
  createSwapKitVenue,
  createUniswapVenue,
  fetchSwapKitCatalog,
  registerAssets,
  UNISWAP_CHAINS,
  type Asset,
  type GetReceipt,
} from "@crossfare/core";
import { createApp } from "./app.ts";
import { createDepositWatcher } from "./deposit-watcher.ts";
import { connectArkiv, createArkivPublisher } from "./arkiv-publisher.ts";
import { loadConfig } from "./config.ts";
import { mountDemo } from "./demo.ts";
import { createPaidPost } from "./demo-payer.ts";
import { connectHcs, createHcsAudit } from "./hcs-audit.ts";
import { createStore } from "./store.ts";
import { createX402Gateway } from "./x402-gateway.ts";

const config = loadConfig(process.env);

const catalogCache = join(dirname(config.databasePath), "swapkit-tokens.json");
const CATALOG_REFRESH_MS = 24 * 3_600_000;

/** Stored swaps can name any listed token, so the last list loads before the server answers. */
async function loadCatalog() {
  const cached = await readFile(catalogCache, "utf8").catch(() => null);
  if (cached) registerAssets(JSON.parse(cached) as Asset[]);
  const refresh = async () => {
    const catalog = await fetchSwapKitCatalog({ apiKey: config.swapkitApiKey });
    if (catalog.length === 0) return;
    registerAssets(catalog);
    await writeFile(catalogCache, JSON.stringify(catalog));
    console.log(`SwapKit catalog: ${catalog.length} tokens`);
  };
  // Without a cached list, wait for the first one. With one, refresh behind it.
  const first = refresh().catch((error: unknown) => console.error("SwapKit catalog failed", error));
  if (!cached) await first;
  setInterval(() => refresh().catch((error: unknown) => console.error("SwapKit catalog failed", error)), CATALOG_REFRESH_MS).unref();
}

await loadCatalog();

/** Ethereum's default public RPC rate-limits, so it gets more to fall back on. */
const SPARE_RPCS: Record<number, string[]> = { 1: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"] };

/** One reader per chain Uniswap trades on: receipts for its swaps, balances for deposits. */
const readers = new Map<number, PublicClient>(
  UNISWAP_CHAINS.map((chain) => {
    const urls = [...(config.rpcUrls[chain.chainId] ? [config.rpcUrls[chain.chainId]!] : []), ...(SPARE_RPCS[chain.chainId] ?? [])];
    const transport = fallback([...urls.map((url) => http(url)), http()]);
    return [chain.chainId, createPublicClient({ chain: chain.viem, transport }) as PublicClient];
  }),
);

const balancesOn = (reader: PublicClient) => ({
  tokenBalance: (token: string, holder: string) =>
    reader.readContract({ address: token as Address, abi: erc20Abi, functionName: "balanceOf", args: [holder as Address] }),
  nativeBalance: (holder: string) => reader.getBalance({ address: holder as Address }),
});

const getReceipt: GetReceipt = async (chainId, hash) => {
  const reader = readers.get(chainId);
  if (!reader) throw new Error(`No chain reader for ${chainId}`);
  // viem throws until the transaction is mined.
  return reader.getTransactionReceipt({ hash: hash as Hash }).catch(() => null);
};

const arkiv = connectArkiv({ privateKey: config.arkivPrivateKey, accessKey: config.arkivAccessKey });

const app = createApp({
  venues: [
    createUniswapVenue({ apiKey: config.uniswapApiKey, getReceipt }),
    createSwapKitVenue({ apiKey: config.swapkitApiKey }),
  ],
  store: createStore(config.databasePath),
  gateway: await createX402Gateway({
    facilitator: new HTTPFacilitatorClient({ url: config.facilitatorUrl }),
    payTo: config.payToAccount,
    usdcTokenId: config.usdcTokenId,
  }),
  audit: createHcsAudit(connectHcs(config.hederaOperatorId, config.hederaOperatorKey, config.hcsTopicId)),
  publisher: createArkivPublisher(arkiv),
  payTo: config.payToAccount,
  ...(config.swapPriceUsd ? { swapPriceUsd: config.swapPriceUsd } : {}),
  arkivWriter: arkiv.writer,
  depositBalance: createDepositWatcher(Object.fromEntries([...readers].map(([chainId, reader]) => [chainId, balancesOn(reader)]))),
  screen: createSwapKitScreen({ apiKey: config.swapkitApiKey }),
});

if (config.demo) {
  const { accountId, privateKey, limits } = config.demo;
  mountDemo(app, {
    limits,
    paidPost: createPaidPost({ fetch: (request) => app.fetch(request), accountId, privateKey }),
  });
}

// Registered last, so the API's routes always win.
app.use("/*", serveStatic({ root: config.webRoot }));

serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  console.log(`Crossfare API listening on http://localhost:${port}`);
});
