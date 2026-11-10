import {
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  signTransaction,
} from "@solana/kit";

/**
 * Signs the unsigned Solana transaction Crossfare returns. Only a transaction the agent's own
 * wallet pays for is signed: kit refuses one whose signers don't include this key.
 */
type KeyPair = Parameters<typeof signTransaction>[0][number];

export async function signSolanaTransaction(base64: string, keyPair: KeyPair): Promise<{ wire: string; signature: string }> {
  const unsigned = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  const signed = await signTransaction([keyPair], unsigned as never);
  return { wire: getBase64EncodedWireTransaction(signed), signature: getSignatureFromTransaction(signed) };
}
