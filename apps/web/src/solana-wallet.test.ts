import { describe, expect, it, vi } from "vitest";
import { base58, fromBase64, signAndSendSolana, solanaWallets } from "./solana-wallet.ts";

const SIGNATURE = new Uint8Array(64).fill(7);

function fakeWallet(name: string, chains: string[], features: string[]) {
  const signAndSendTransaction = vi.fn(async () => [{ signature: SIGNATURE }]);
  return {
    name,
    icon: "data:image/svg+xml;base64,AA==",
    chains,
    accounts: [],
    version: "1.0.0",
    features: Object.fromEntries(features.map((feature) => [feature, feature === "solana:signAndSendTransaction" ? { signAndSendTransaction } : {}])),
    signAndSendTransaction,
  };
}

describe("solanaWallets", () => {
  it("lists only wallets that can sign and send on Solana mainnet", () => {
    const phantom = fakeWallet("Phantom", ["solana:mainnet"], ["standard:connect", "solana:signAndSendTransaction"]);
    const evmOnly = fakeWallet("EVM", ["eip155:1"], ["standard:connect"]);
    const signOnly = fakeWallet("SignOnly", ["solana:mainnet"], ["standard:connect", "solana:signTransaction"]);
    expect(solanaWallets([phantom, evmOnly, signOnly] as never).map((wallet) => wallet.name)).toEqual(["Phantom"]);
  });
});

describe("encoding", () => {
  it("reads base64 into bytes and writes base58 as Solana does", () => {
    expect([...fromBase64("AQID")]).toEqual([1, 2, 3]);
    expect(base58(new Uint8Array([0, 0, 1]))).toBe("112");
    expect(base58(new Uint8Array(32))).toBe("11111111111111111111111111111111");
  });
});

describe("signAndSendSolana", () => {
  it("hands the wallet the transaction's bytes on mainnet and returns the signature in base58", async () => {
    const wallet = fakeWallet("Phantom", ["solana:mainnet"], ["standard:connect", "solana:signAndSendTransaction"]);
    const account = { address: "GZRiD2TR1oiSXXFDsGhLR5fZWbfHqY9KyfHkiChUuVBR", publicKey: new Uint8Array(32), chains: ["solana:mainnet"], features: [] };
    const signature = await signAndSendSolana(wallet as never, account as never, "AQID");
    expect(wallet.signAndSendTransaction).toHaveBeenCalledWith({ account, chain: "solana:mainnet", transaction: new Uint8Array([1, 2, 3]) });
    expect(signature).toBe(base58(SIGNATURE));
  });
});
