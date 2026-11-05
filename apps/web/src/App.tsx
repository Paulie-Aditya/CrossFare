import { useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { shorten } from "./journey.ts";
import { QuoteRecord } from "./QuoteRecord.tsx";
import { SwapPage } from "./SwapPage.tsx";

function WalletButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <button className="wallet" onClick={() => disconnect()} title="Disconnect wallet">
        {shorten(address)}
      </button>
    );
  }
  const connector = connectors[0];
  return (
    <div className="wallet-slot">
      <button className="wallet" disabled={isPending || !connector} onClick={() => connector && connect({ connector })}>
        {isPending ? "Connecting" : "Connect wallet"}
      </button>
      {error && <p className="wallet-error">No wallet connected. Install a browser wallet, then try again.</p>}
    </div>
  );
}

export function App() {
  const [page, setPage] = useState<"swap" | "record">("swap");
  return (
    <>
      <header className="masthead">
        <div className="brand" aria-label="Crossfare">
          <svg viewBox="0 0 48 20" width="48" height="20" aria-hidden="true">
            <path d="M0 16 48 4" stroke="var(--signal)" strokeWidth="5" />
            <circle cx="24" cy="10" r="6.5" fill="var(--enamel)" stroke="#fff" strokeWidth="3" />
          </svg>
          <span>Crossfare</span>
        </div>
        <nav aria-label="Pages">
          <button aria-current={page === "swap" ? "page" : undefined} onClick={() => setPage("swap")}>
            Swap
          </button>
          <button aria-current={page === "record" ? "page" : undefined} onClick={() => setPage("record")}>
            Quote record
          </button>
        </nav>
        <WalletButton />
      </header>
      <main>
        {/* Stays mounted so a swap in progress survives a look at the record. */}
        <div hidden={page !== "swap"}>
          <SwapPage />
        </div>
        {page === "record" && <QuoteRecord />}
      </main>
    </>
  );
}
