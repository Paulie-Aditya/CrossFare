import { serve } from "@hono/node-server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createPublicClient, http, type Hash } from "viem";
import { base, mainnet } from "viem/chains";
import { createSwapKitVenue, createUniswapVenue, type GetReceipt } from "@crossfare/core";
import { createApp } from "./app.ts";
import { connectArkiv, createArkivPublisher } from "./arkiv-publisher.ts";
import { loadConfig } from "./config.ts";
import { connectHcs, createHcsAudit } from "./hcs-audit.ts";
import { createStore } from "./store.ts";
import { createX402Gateway } from "./x402-gateway.ts";

const config = loadConfig(process.env);

const readers = {
  [base.id]: createPublicClient({ chain: base, transport: http(config.baseRpcUrl) }),
  [mainnet.id]: createPublicClient({ chain: mainnet, transport: http() }),
};

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
  arkivWriter: arkiv.writer,
});

serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  console.log(`Crossfare API listening on http://localhost:${port}`);
});
