import { useEffect, useState } from "react";
import { get } from "./api.ts";
import { setBook, type AssetOption, type ChainOption } from "./asset-book.ts";
import { QuoteRecord } from "./QuoteRecord.tsx";
import { SwapPage } from "./SwapPage.tsx";
import { useWalletMenu, WalletButton } from "./WalletMenu.tsx";

export function App() {
  const [page, setPage] = useState<"swap" | "record">("swap");
  const walletMenu = useWalletMenu();
  const [catalog, setCatalog] = useState<{ assets: AssetOption[]; chains: ChainOption[] }>({ assets: [], chains: [] });

  useEffect(() => {
    get("/v1/assets")
      .then((answer) => {
        if (!answer.ok) return;
        setBook(answer.body.assets, answer.body.chains);
        setCatalog({ assets: answer.body.assets, chains: answer.body.chains });
      })
      .catch(() => undefined);
  }, []);
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
            History
          </button>
        </nav>
        <WalletButton {...walletMenu} />
      </header>
      <main>
        {/* Stays mounted so a swap in progress survives a look at the record. */}
        <div hidden={page !== "swap"}>
          <SwapPage onConnectWallet={walletMenu.onOpen} assets={catalog.assets} chains={catalog.chains} />
        </div>
        {page === "record" && <QuoteRecord />}
      </main>
    </>
  );
}
