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
      <header className="masthead glass">
        <div className="brand" aria-label="Crossfare">
          <svg viewBox="0 0 32 32" width="24" height="24" aria-hidden="true">
            <path d="M5 23C11 23 11 9 17 9h10" fill="none" stroke="var(--mint)" strokeWidth="3.4" strokeLinecap="round" />
            <path d="M5 9c6 0 6 14 12 14h10" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" />
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
