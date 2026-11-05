import { PrivateKey } from "@hiero-ledger/sdk";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PREFIXED_HEX = /^0x[0-9a-fA-F]{64}$/;
const BARE_HEX = /^[0-9a-fA-F]{64}$/;
const DER = /^30[0-9a-fA-F]+$/;

/**
 * The SDK's own fromString reads raw hex as ED25519, which silently produces the
 * wrong key for the ECDSA accounts the Hedera portal creates. Errors never repeat
 * the value, because it may be a secret.
 */
export function parseHederaKey(value: string): PrivateKey {
  const key = value.trim();
  if (EVM_ADDRESS.test(key)) {
    throw new Error("Expected a Hedera private key, but this looks like a public EVM address, not a private key");
  }
  if (PREFIXED_HEX.test(key)) return PrivateKey.fromStringECDSA(key);
  if (BARE_HEX.test(key)) return PrivateKey.fromStringED25519(key);
  if (DER.test(key)) return PrivateKey.fromStringDer(key);
  throw new Error("Expected a Hedera private key as 0x-prefixed ECDSA hex, bare ED25519 hex or DER");
}
