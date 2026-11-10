import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { HTTPFacilitatorClient } from "@x402/core/server";
import {
  ContractFunctionExecutionError,
  createPublicClient,
  erc20Abi,
  erc20Abi_bytes32,
  fallback,
  hexToString,
  http,
  parseAbi,
  type Address,
  type Hash,
  type PublicClient,
} from "viem";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  addUnlistedAssets,
  createNearIntentsVenue,
  createSwapKitScreen,
  createSwapKitVenue,
  createPancakeSwapVenue,
  createJupiterVenue,
  PANCAKE_PERMIT2,
  PANCAKESWAP_CHAINS,
  createThorchainVenue,
  createUniswapVenue,
  fetchSwapKitCatalog,
  fetchUniswapTokenList,
  listAssets,
  mergeCatalogs,
  nativeAssets,
  registerAssets,
  UNISWAP_CHAINS,
  type Asset,
  type GetReceipt,
} from "@crossfare/core";
import { createPancakeRouter } from "@crossfare/core/pancakeswap-router";
import { assembleJupiterTransaction, createSolanaReader } from "@crossfare/core/solana";
import { createApp } from "./app.ts";
import { createDepositWatcher } from "./deposit-watcher.ts";
import { connectArkiv, createArkivPublisher } from "./arkiv-publisher.ts";
import { loadConfig } from "./config.ts";
import { mountDemo } from "./demo.ts";
import { createPaidPost } from "./demo-payer.ts";
import { connectHcs, createHcsAudit } from "./hcs-audit.ts";
import { createStore } from "./store.ts";
import { createTokenLookup, type ReadToken } from "./token-lookup.ts";
import { createX402Gateway } from "./x402-gateway.ts";

const config = loadConfig(process.env);

const catalogCache = join(dirname(config.databasePath), "swapkit-tokens.json");
const CATALOG_REFRESH_MS = 24 * 3_600_000;

/** Stored swaps can name any listed token, so the last list loads before the server answers. */
async function loadCatalog() {
  const cached = await readFile(catalogCache, "utf8").catch(() => null);
  if (cached) registerAssets(JSON.parse(cached) as Asset[]);
  const refresh = async () => {
    const [swapkit, uniswap] = await Promise.allSettled([
      fetchSwapKitCatalog({ apiKey: config.swapkitApiKey }),
      fetchUniswapTokenList(),
    ]);
    if (swapkit.status === "rejected") throw swapkit.reason;
    if (swapkit.value.length === 0) return;
    if (uniswap.status === "rejected") console.error("Uniswap token list failed", uniswap.reason);
    // Stored swaps can name a token only Uniswap lists, so a failed list keeps the last one's.
    const uniswapOnly = uniswap.status === "fulfilled" ? uniswap.value : listAssets().filter((asset) => !asset.swapkit);
    // SwapKit's entries go first, so a token both list keeps the entry both venues can route.
    const catalog = mergeCatalogs(swapkit.value, uniswapOnly, nativeAssets());
    registerAssets(catalog);
    await writeFile(catalogCache, JSON.stringify(catalog));
    console.log(`Token catalog: ${catalog.length} tokens (${swapkit.value.length} from SwapKit)`);
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

/** PancakeSwap reads many pools per quote, so its readers batch calls through multicall. */
const pancakeReaders = new Map<number, PublicClient>(
  PANCAKESWAP_CHAINS.flatMap((chainId) => {
    const chain = UNISWAP_CHAINS.find((entry) => entry.chainId === chainId);
    if (!chain) return [];
    const urls = config.rpcUrls[chainId] ? [config.rpcUrls[chainId]!] : [];
    const transport = fallback([...urls.map((url) => http(url)), http()]);
    return [[chainId, createPublicClient({ chain: chain.viem, transport, batch: { multicall: { batchSize: 200_000 } } }) as PublicClient]];
  }),
);

const PERMIT2_ALLOWANCE_ABI = parseAbi(["function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)"]);

/** What a wallet lets Permit2 move, and what Permit2 lets the router move. */
async function readPermit2Allowances(chainId: number, token: string, owner: string, spender: string) {
  const reader = readers.get(chainId);
  if (!reader) throw new Error(`No chain reader for ${chainId}`);
  const [tokenAllowance, [amount, expiration]] = await Promise.all([
    reader.readContract({ address: token as Address, abi: erc20Abi, functionName: "allowance", args: [owner as Address, PANCAKE_PERMIT2] }),
    reader.readContract({ address: PANCAKE_PERMIT2, abi: PERMIT2_ALLOWANCE_ABI, functionName: "allowance", args: [owner as Address, token as Address, spender as Address] }),
  ]);
  return { token: tokenAllowance, router: { amount, expiration: Number(expiration) } };
}

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

/** A revert or empty return means the contract isn't an ERC-20. Anything else is the RPC failing. */
const notAToken = (error: unknown) => {
  if (error instanceof ContractFunctionExecutionError) return null;
  throw error;
};

/** Older tokens such as MKR return their symbol and name as bytes32. */
async function readText(reader: PublicClient, address: Address, functionName: "symbol" | "name"): Promise<string> {
  const text = await reader.readContract({ address, abi: erc20Abi, functionName }).catch(notAToken);
  if (text !== null) return text;
  const raw = await reader.readContract({ address, abi: erc20Abi_bytes32, functionName }).catch(notAToken);
  return raw ? hexToString(raw, { size: 32 }).replace(/\u0000+$/, "") : "";
}

const readToken: ReadToken = async (chainId, address) => {
  const reader = readers.get(chainId);
  if (!reader) return null;
  const contract = address as Address;
  const code = await reader.getCode({ address: contract });
  if (!code || code === "0x") return null;
  const decimals = await reader.readContract({ address: contract, abi: erc20Abi, functionName: "decimals" }).catch(notAToken);
  if (decimals === null) return null;
  const [symbol, name] = await Promise.all([readText(reader, contract, "symbol"), readText(reader, contract, "name")]);
  return { symbol, name, decimals };
};

const store = createStore(config.databasePath);
// Swaps can name a token someone pasted, so those resolve before the server answers.
addUnlistedAssets(store.listUnlistedAssets());

const arkiv = connectArkiv({ privateKey: config.arkivPrivateKey, accessKey: config.arkivAccessKey });

const app = createApp({
  venues: [
    createUniswapVenue({
      apiKey: config.uniswapApiKey,
      getReceipt,
    }),
    // Reached directly, these keep the whole affiliate fee. SwapKit stays the fallback for both.
    ...(config.nearIntents ? [createNearIntentsVenue(config.nearIntents)] : []),
    ...(config.thorchain ? [createThorchainVenue(config.thorchain)] : []),
    ...(config.pancakeswap
      ? [createPancakeSwapVenue({
          router: createPancakeRouter({ clientFor: (chainId) => pancakeReaders.get(chainId) }),
          getReceipt,
          readAllowances: readPermit2Allowances,
        })]
      : []),
    ...(config.jupiter
      ? [createJupiterVenue({
          ...(config.jupiter.apiKey ? { apiKey: config.jupiter.apiKey } : {}),
          solana: createSolanaReader(config.jupiter.solanaRpcUrl ? { rpcUrl: config.jupiter.solanaRpcUrl } : {}),
          assemble: assembleJupiterTransaction,
        })]
      : []),
    createSwapKitVenue({ apiKey: config.swapkitApiKey }),
  ],
  store,
  tokens: createTokenLookup({ readToken, store }),
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
