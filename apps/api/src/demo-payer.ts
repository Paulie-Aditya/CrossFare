import { PrivateKey } from "@hiero-ledger/sdk";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import type { PaidPost } from "./demo.ts";
import { PAYMENT_NETWORK } from "./payment.ts";

export interface DemoPayerOptions {
  /** Reaches the API inside this process, so the call makes no network hop. */
  fetch: (request: Request) => Response | Promise<Response>;
  accountId: string;
  privateKey: string;
}

/** Makes a paid API call the same way any agent would, using the official x402 client. */
export function createPaidPost(options: DemoPayerOptions): PaidPost {
  const signer = createClientHederaSigner(options.accountId, PrivateKey.fromString(options.privateKey), {
    network: PAYMENT_NETWORK,
  });
  const client = new x402Client().register(PAYMENT_NETWORK, new ExactHederaScheme(signer));
  const paying = wrapFetchWithPayment(
    async (input, init) => options.fetch(new Request(input as Request, init)),
    client,
  );

  return async (path, body) => {
    const response = await paying(`http://crossfare.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
}
