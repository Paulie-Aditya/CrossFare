import { useEffect, useState } from "react";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { shorten } from "./journey.ts";
import { connectSolana, onSolanaWalletsChanged, signAndSendSolana, solanaWallets } from "./solana-wallet.ts";
import { Modal } from "./ui.tsx";

export interface SolanaWalletState {
  wallets: Wallet[];
  wallet: Wallet | null;
  account: WalletAccount | null;
  connect(wallet: Wallet): Promise<void>;
  disconnect(): void;
  /** Signs and sends Crossfare's transaction with the connected wallet; returns its signature. */
  signAndSend(base64Transaction: string): Promise<string>;
}

/** The Solana wallet this page holds, if any. Separate from the EVM wallet: a person can hold both. */
export function useSolanaWallet(): SolanaWalletState {
  const [wallets, setWallets] = useState<Wallet[]>(() => solanaWallets());
  const [connected, setConnected] = useState<{ wallet: Wallet; account: WalletAccount } | null>(null);

  useEffect(() => onSolanaWalletsChanged(() => setWallets(solanaWallets())), []);

  return {
    wallets,
    wallet: connected?.wallet ?? null,
    account: connected?.account ?? null,
    async connect(wallet) {
      setConnected({ wallet, account: await connectSolana(wallet) });
    },
    disconnect: () => setConnected(null),
    async signAndSend(base64Transaction) {
      if (!connected) throw new Error("No Solana wallet connected");
      return signAndSendSolana(connected.wallet, connected.account, base64Transaction);
    },
  };
}

export function SolanaWalletChooser({ solana, onClose }: { solana: SolanaWalletState; onClose: () => void }) {
  const [waiting, setWaiting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (solana.account && solana.wallet) {
    return (
      <Modal title="Your Solana wallet" onClose={onClose}>
        <div className="wallet-account">
          <img className="wallet-icon" src={solana.wallet.icon} alt="" width="36" height="36" />
          <div>
            <p className="wallet-name">{solana.wallet.name}</p>
            <p className="wallet-address">{shorten(solana.account.address)}</p>
          </div>
        </div>
        <button
          type="button"
          className="ghost wallet-disconnect"
          onClick={() => {
            solana.disconnect();
            onClose();
          }}
        >
          Disconnect
        </button>
      </Modal>
    );
  }

  async function choose(wallet: Wallet) {
    setWaiting(wallet.name);
    setError(null);
    try {
      await solana.connect(wallet);
      onClose();
    } catch (failure) {
      setError(
        /reject|denied/i.test((failure as Error).message)
          ? "You declined in your wallet, so nothing connected. Choose a wallet to try again."
          : "That wallet didn't connect. Unlock it, then try again.",
      );
    } finally {
      setWaiting(null);
    }
  }

  return (
    <Modal title="Connect a Solana wallet" onClose={onClose}>
      {solana.wallets.length > 0 ? (
        <ul className="wallet-list">
          {solana.wallets.map((wallet) => (
            <li key={wallet.name}>
              <button
                type="button"
                className="wallet-option"
                disabled={waiting !== null}
                data-waiting={waiting === wallet.name || undefined}
                onClick={() => choose(wallet)}
              >
                <img className="wallet-icon" src={wallet.icon} alt="" width="36" height="36" />
                <span className="wallet-option-name">{wallet.name}</span>
                <span className="wallet-option-state">{waiting === wallet.name ? "Confirm in your wallet" : "Detected"}</span>
                {waiting === wallet.name && <span className="spinner" aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="wallet-empty">This browser has no Solana wallet installed. Install one such as Phantom or Solflare, then reload this page.</p>
      )}
      {error && (
        <p className="wallet-error" role="alert">
          {error}
        </p>
      )}
      <p className="wallet-hint">Jupiter's routes on Solana are signed by your Solana wallet. Crossfare never holds your funds.</p>
    </Modal>
  );
}
