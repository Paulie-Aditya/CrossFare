import { readFileSync } from "node:fs";
import { generateKeyPairSigner, getBase64Encoder, getTransactionDecoder, verifySignature, getBase58Encoder } from "@solana/kit";
import { assembleJupiterTransaction } from "@crossfare/core/solana";
import { describe, expect, it } from "vitest";
import { signSolanaTransaction } from "./solana.ts";

const recorded = readFileSync(new URL("../../../packages/core/src/venues/fixtures/jupiter/build-sol-usdc.json", import.meta.url), "utf8");
/** The recorded swap, as /build would have written it for this wallet: the taker signs its own instructions. */
const buildFor = (taker: string) => JSON.parse(recorded.replaceAll("GZRiD2TR1oiSXXFDsGhLR5fZWbfHqY9KyfHkiChUuVBR", taker));

describe("signSolanaTransaction", () => {
  it("signs Crossfare's unsigned transaction as its fee payer, and returns the signature to report", async () => {
    const signer = await generateKeyPairSigner();
    const { transaction } = await assembleJupiterTransaction(buildFor(signer.address), signer.address);
    const { wire, signature } = await signSolanaTransaction(transaction, signer.keyPair);
    const signed = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
    const bytes = signed.signatures[signer.address]!;
    expect(await verifySignature(signer.keyPair.publicKey, bytes, signed.messageBytes)).toBe(true);
    expect(getBase58Encoder().encode(signature)).toEqual(bytes);
  });

  it("refuses a transaction some other wallet must pay for", async () => {
    const signer = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    const { transaction } = await assembleJupiterTransaction(buildFor(other.address), other.address);
    await expect(signSolanaTransaction(transaction, signer.keyPair)).rejects.toThrow(/not a signer/);
  });
});
