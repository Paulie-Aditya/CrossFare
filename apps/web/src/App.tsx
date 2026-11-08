import { useEffect, useState } from "react";
import { get } from "./api.ts";
import { setBook, type AssetOption, type CatalogStatus, type ChainOption } from "./asset-book.ts";
import { QuoteRecord } from "./QuoteRecord.tsx";
import { SwapPage } from "./SwapPage.tsx";
import { useWalletMenu, WalletButton } from "./WalletMenu.tsx";

const CATALOG_RETRY_MS = 10_000;

export function App() {
  const [page, setPage] = useState<"swap" | "record">("swap");
  const walletMenu = useWalletMenu();
  const [catalog, setCatalog] = useState<{ assets: AssetOption[]; chains: ChainOption[]; status: CatalogStatus }>({
    assets: [],
    chains: [],
    status: "loading",
  });

  // Keeps trying, so tokens appear as soon as the API comes back, with no reload.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const answer = await get("/v1/assets").catch(() => null);
      if (stopped) return;
      if (answer?.ok && Array.isArray(answer.body?.assets)) {
        setBook(answer.body.assets, answer.body.chains);
        setCatalog({ assets: answer.body.assets, chains: answer.body.chains, status: "ready" });
        return;
      }
      setCatalog((current) => ({ ...current, status: "failed" }));
      timer = setTimeout(load, CATALOG_RETRY_MS);
    };
    load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  return (
    <>
      <header className="masthead glass">
        <div className="brand" aria-label="Crossfare">
          <img src="/logo.svg" alt="" width="35" height="22" />
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
          <SwapPage onConnectWallet={walletMenu.onOpen} assets={catalog.assets} chains={catalog.chains} catalogStatus={catalog.status} />
        </div>
        {page === "record" && <QuoteRecord />}
      </main>
    </>
  );
}
