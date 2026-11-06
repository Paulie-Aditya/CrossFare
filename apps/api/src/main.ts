import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createPublicClient, erc20Abi, fallback, http, type Address, type Hash } from "viem";
import { base, mainnet } from "viem/chains";
import { createSwapKitScreen, createSwapKitVenue, createUniswapVenue, type GetReceipt } from "@crossfare/core";
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

const readers = {
  [base.id]: createPublicClient({ chain: base, transport: http(config.baseRpcUrl) }),
  [mainnet.id]: createPublicClient({
    chain: mainnet,
    transport: fallback([...(config.ethereumRpcUrl ? [http(config.ethereumRpcUrl)] : []), http("https://ethereum-rpc.publicnode.com"), http("https://eth.drpc.org"), http()]),
  }),
};

const balancesOn = (reader: (typeof readers)[keyof typeof readers]) => ({
  tokenBalance: (token: string, holder: string) =>
    reader.readContract({ address: token as Address, abi: erc20Abi, functionName: "balanceOf", args: [holder as Address] }),
  nativeBalance: (holder: string) => reader.getBalance({ address: holder as Address }),
});

const getReceipt: GetReceipt = async (chainId, hash) => {
  const reader = readers[chainId as keyof typeof readers];
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
  depositSeen: createDepositWatcher({ [base.id]: balancesOn(readers[base.id]), [mainnet.id]: balancesOn(readers[mainnet.id]) }),
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
