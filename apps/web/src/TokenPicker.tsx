import { useMemo, useState } from "react";
import { chainLogoOf, chainNameOf, displaySymbol, filterAssets, symbolOf, type AssetOption, type ChainOption } from "./asset-book.ts";
import { shorten } from "./journey.ts";
import { Coin, Modal } from "./ui.tsx";

/** The contract, for telling apart tokens that share a ticker. */
const contractOf = (id: string) => id.split(":")[1]?.split("-").slice(1).join("-") ?? "";

function ChainChip(props: { chain: ChainOption | null; active: boolean; onPick: () => void }) {
  const logo = props.chain && chainLogoOf(props.chain.id);
  return (
    <button type="button" className="chain-chip" aria-pressed={props.active} onClick={props.onPick}>
      {logo && <img src={logo} alt="" width="16" height="16" loading="lazy" />}
      {props.chain?.name ?? "All chains"}
    </button>
  );
}

export function TokenButton(props: {
  label: string;
  asset: string;
  assets: readonly AssetOption[];
  chains: readonly ChainOption[];
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [chain, setChain] = useState<string | null>(null);
  const found = useMemo(() => filterAssets(props.assets, query, chain), [props.assets, query, chain]);
  return (
    <>
      <button
        type="button"
        className="token"
        aria-label={`${props.label}: ${symbolOf(props.asset)} on ${chainNameOf(props.asset)}`}
        onClick={() => setOpen(true)}
      >
        <Coin asset={props.asset} size={26} />
        <span className="token-text">
          <strong>{symbolOf(props.asset)}</strong>
          <small>{chainNameOf(props.asset)}</small>
        </span>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <Modal title={props.label} onClose={() => setOpen(false)}>
          <input
            className="token-search"
            type="search"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            aria-label="Search by name, symbol or contract"
            placeholder="Search by name, symbol or contract"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="chain-chips" role="group" aria-label="Filter by chain">
            <ChainChip chain={null} active={chain === null} onPick={() => setChain(null)} />
            {props.chains.map((option) => (
              <ChainChip key={option.id} chain={option} active={chain === option.id} onPick={() => setChain(option.id)} />
            ))}
          </div>
          {found.shown.length === 0 ? (
            <p className="token-empty">No token matches that. Check the spelling, or paste its contract address.</p>
          ) : (
            <ul className="token-list">
              {found.shown.map((option) => {
                const contract = contractOf(option.id);
                return (
                  <li key={option.id}>
                    <button
                      type="button"
                      className="token-option"
                      aria-current={option.id === props.asset || undefined}
                      onClick={() => {
                        props.onPick(option.id);
                        setOpen(false);
                      }}
                    >
                      <Coin asset={option.id} size={36} />
                      <span className="token-option-text">
                        <strong>{displaySymbol(option.symbol)}</strong>
                        {/* A native coin is usually named after its chain, which needn't be said twice. */}
                        <small>{option.name === chainNameOf(option.id) ? option.name : `${option.name} on ${chainNameOf(option.id)}`}</small>
                      </span>
                      {contract && <span className="token-contract">{shorten(contract)}</span>}
                      {option.id === props.asset && (
                        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                          <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="token-count">
            {found.total > found.shown.length
              ? `Showing ${found.shown.length} of ${found.total.toLocaleString("en-US")} tokens. Search to find the rest.`
              : `${found.total.toLocaleString("en-US")} ${found.total === 1 ? "token" : "tokens"}`}
          </p>
        </Modal>
      )}
    </>
  );
}
