import { useEffect, useState } from "react";
import { useAccount, useConnect, useDisconnect, type Connector } from "wagmi";
import { shorten, walletOptions } from "./journey.ts";
import { CopyButton, Modal } from "./ui.tsx";

function WalletIcon({ connector }: { connector: Connector }) {
  if (connector.icon) return <img className="wallet-icon" src={connector.icon} alt="" width="36" height="36" />;
  return (
    <span className="wallet-icon wallet-icon-plain" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3M4 7.5V17a2.5 2.5 0 0 0 2.5 2.5H20V8H6.5A2.5 2.5 0 0 1 4 7.5ZM16 13.75h.01" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function WalletChooser({ onClose }: { onClose: () => void }) {
  const { address, isConnected, connector: active } = useAccount();
  const { connect, connectors, isPending, error, variables, reset } = useConnect();
  const { disconnect } = useDisconnect();
  const options = walletOptions(connectors as readonly Connector[]);
  const chosen = isPending ? (variables?.connector as Connector | undefined) : undefined;

  useEffect(() => reset, [reset]);

  if (isConnected && address) {
    return (
      <Modal title="Your wallet" onClose={onClose}>
        <div className="wallet-account">
          {active && <WalletIcon connector={active} />}
          <div>
            <p className="wallet-name">{active?.name ?? "Connected"}</p>
            <p className="wallet-address">{shorten(address)}</p>
          </div>
          <CopyButton value={address} />
        </div>
        <button
          type="button"
          className="ghost wallet-disconnect"
          onClick={() => {
            disconnect();
            onClose();
          }}
        >
          Disconnect
        </button>
      </Modal>
    );
  }

  return (
    <Modal title="Connect a wallet" onClose={onClose}>
      {options.length > 0 ? (
        <ul className="wallet-list">
          {options.map((connector) => {
            const waiting = chosen?.uid === connector.uid;
            return (
              <li key={connector.uid}>
                <button
                  type="button"
                  className="wallet-option"
                  disabled={isPending}
                  data-waiting={waiting || undefined}
                  onClick={() => connect({ connector }, { onSuccess: onClose })}
                >
                  <WalletIcon connector={connector} />
                  <span className="wallet-option-name">{connector.name}</span>
                  <span className="wallet-option-state">{waiting ? "Confirm in your wallet" : "Detected"}</span>
                  {waiting && <span className="spinner" aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="wallet-empty">
          This browser has no wallet installed. Install one such as MetaMask or Rabby, then reload this page.
        </p>
      )}
      {error && !isPending && (
        <p className="wallet-error" role="alert">
          {/reject|denied/i.test(error.message)
            ? "You declined in your wallet, so nothing connected. Choose a wallet to try again."
            : "That wallet didn't connect. Unlock it, then try again."}
        </p>
      )}
      <p className="wallet-hint">You don't need a wallet here to swap. You can send the deposit from any wallet app or exchange.</p>
    </Modal>
  );
}

export function WalletButton({ open, onOpen, onClose }: { open: boolean; onOpen: () => void; onClose: () => void }) {
  const { address, isConnected } = useAccount();
  return (
    <>
      <button className="wallet" onClick={onOpen} data-connected={isConnected || undefined}>
        {isConnected && address ? (
          <>
            <span className="wallet-dot" aria-hidden="true" />
            {shorten(address)}
          </>
        ) : (
          "Connect wallet"
        )}
      </button>
      {open && <WalletChooser onClose={onClose} />}
    </>
  );
}

export function useWalletMenu() {
  const [open, setOpen] = useState(false);
  return { open, onOpen: () => setOpen(true), onClose: () => setOpen(false) };
}
