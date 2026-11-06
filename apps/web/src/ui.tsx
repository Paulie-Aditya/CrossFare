import { useEffect, useRef, useState, type ReactNode } from "react";

export const CHAIN_NAMES: Record<string, string> = {
  base: "Base",
  eth: "Ethereum",
  btc: "Bitcoin",
  sol: "Solana",
  xrp: "XRP Ledger",
};

const COINS: Record<string, { color: string; glyph: string }> = {
  usdc: { color: "#2775ca", glyph: "$" },
  eth: { color: "#627eea", glyph: "Ξ" },
  btc: { color: "#f7931a", glyph: "₿" },
  sol: { color: "#9945ff", glyph: "S" },
  xrp: { color: "#39424e", glyph: "X" },
};
const CHAIN_DOTS: Record<string, string> = { base: "#0052ff", eth: "#8a9df0", btc: "#f7931a", sol: "#14f195", xrp: "#8d99a8" };

/** A plain mark for an asset, with its chain as a dot. */
export function Coin({ asset, size = 28 }: { asset: string; size?: number }) {
  const [chain = "", symbol = ""] = asset.split(":");
  const coin = COINS[symbol] ?? { color: "#555d7a", glyph: symbol.charAt(0).toUpperCase() };
  return (
    <span className="coin" style={{ width: size, height: size, fontSize: size * 0.52, background: coin.color }} aria-hidden="true">
      {coin.glyph}
      <i style={{ background: CHAIN_DOTS[chain] ?? "#fff" }} />
    </span>
  );
}

export function Modal(props: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal glass"
      aria-label={props.title}
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) props.onClose();
      }}
    >
      <div className="modal-body">
        <header className="modal-head">
          <h2>{props.title}</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={props.onClose}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M3 3l10 10M13 3 3 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        {props.children}
      </div>
    </dialog>
  );
}

const COPIED_MS = 2_000;

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      setCopied(false);
    }
  }
  return (
    <button type="button" className="order-copy" data-copied={copied || undefined} onClick={copy}>
      {copied ? "Copied" : label}
    </button>
  );
}

export const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
