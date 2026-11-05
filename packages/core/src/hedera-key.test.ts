import { PrivateKey } from "@hiero-ledger/sdk";
import { describe, expect, it } from "vitest";
import { parseHederaKey } from "./hedera-key.ts";

describe("parseHederaKey", () => {
  it("reads a 0x-prefixed key as ECDSA, the format the Hedera portal shows", () => {
    const key = PrivateKey.generateECDSA();
    expect(parseHederaKey(`0x${key.toStringRaw()}`).publicKey.toString()).toBe(key.publicKey.toString());
  });

  it("reads a bare hex key as ED25519", () => {
    const key = PrivateKey.generateED25519();
    expect(parseHederaKey(key.toStringRaw()).publicKey.toString()).toBe(key.publicKey.toString());
  });

  it.each([
    ["ECDSA", PrivateKey.generateECDSA()],
    ["ED25519", PrivateKey.generateED25519()],
  ])("reads a DER-encoded %s key", (_name, key) => {
    expect(parseHederaKey(key.toStringDer()).publicKey.toString()).toBe(key.publicKey.toString());
  });

  it("names the likely mistake when given a public EVM address", () => {
    expect(() => parseHederaKey("0xC9bebBA9f481b12cE6f3EA54c4B182c9636ec421")).toThrow(/address, not a private key/);
  });

  it("never repeats the value in its error", () => {
    const secret = "not-a-real-key-value";
    expect(() => parseHederaKey(secret)).toThrow(/Hedera private key/);
    expect(() => parseHederaKey(secret)).not.toThrow(new RegExp(secret));
  });
});
