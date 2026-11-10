import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";

/**
 * Solana wallets through the Wallet Standard, which Phantom, Solflare, Backpack and others
 * announce to the page. Only signing and sending is needed: Crossfare builds the transaction.
 */

const MAINNET = "solana:mainnet";
const CONNECT = "standard:connect";
const SIGN_AND_SEND = "solana:signAndSendTransaction";

type ConnectFeature = { connect(): Promise<{ accounts: readonly WalletAccount[] }> };
type SignAndSendFeature = {
  signAndSendTransaction(...inputs: { account: WalletAccount; chain: string; transaction: Uint8Array }[]): Promise<readonly { signature: Uint8Array }[]>;
};

/** Wallets that can sign and send on Solana mainnet. */
export function solanaWallets(wallets: readonly Wallet[] = getWallets().get()): Wallet[] {
  return wallets.filter((wallet) => wallet.chains.includes(MAINNET) && CONNECT in wallet.features && SIGN_AND_SEND in wallet.features);
}

/** Calls back whenever a wallet is installed or removed while the page is open. */
export function onSolanaWalletsChanged(listener: () => void): () => void {
  const wallets = getWallets();
  const offRegister = wallets.on("register", listener);
  const offUnregister = wallets.on("unregister", listener);
  return () => {
    offRegister();
    offUnregister();
  };
}

export async function connectSolana(wallet: Wallet): Promise<WalletAccount> {
  const { accounts } = await (wallet.features[CONNECT] as ConnectFeature).connect();
  const account = accounts.find((entry) => entry.chains.includes(MAINNET)) ?? accounts[0];
  if (!account) throw new Error(`${wallet.name} shared no Solana account`);
  return account;
}

/** Has the wallet sign Crossfare's unsigned transaction and send it; returns the signature to report. */
export async function signAndSendSolana(wallet: Wallet, account: WalletAccount, base64Transaction: string): Promise<string> {
  const feature = wallet.features[SIGN_AND_SEND] as SignAndSendFeature;
  const [result] = await feature.signAndSendTransaction({ account, chain: MAINNET, transaction: fromBase64(base64Transaction) });
  if (!result) throw new Error("The wallet returned no signature");
  return base58(result.signature);
}

export function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 as Bitcoin and Solana write it: each leading zero byte is a "1". */
export function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}
