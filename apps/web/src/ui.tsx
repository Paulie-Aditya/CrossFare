import { useEffect, useRef, useState, type ReactNode } from "react";
import { chainLogoOf, logoOf, symbolOf } from "./asset-book.ts";

const FALLBACK_COLORS = ["#2775ca", "#627eea", "#f7931a", "#9945ff", "#26a17b", "#e84142", "#39424e"];

/** An asset's own logo with its chain as a badge, falling back to a letter if an image won't load. */
export function Coin({ asset, size = 28, badge = true }: { asset: string; size?: number; badge?: boolean }) {
  const [chain = ""] = asset.split(":");
  const logo = logoOf(asset);
  const chainLogo = chainLogoOf(chain);
  const [failed, setFailed] = useState<string | null>(null);
  const [badgeFailed, setBadgeFailed] = useState<string | null>(null);
  const symbol = symbolOf(asset);
  const color = FALLBACK_COLORS[[...symbol].reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % FALLBACK_COLORS.length];
  return (
    <span className="coin" style={{ width: size, height: size, fontSize: size * 0.46 }} aria-hidden="true">
      {logo && failed !== logo ? (
        <img src={logo} alt="" width={size} height={size} loading="lazy" onError={() => setFailed(logo)} />
      ) : (
        <span className="coin-letter" style={{ background: color }}>
          {symbol.charAt(0)}
        </span>
      )}
      {badge && chainLogo && badgeFailed !== chainLogo && chainLogo !== logo && (
        <img className="coin-chain" src={chainLogo} alt="" loading="lazy" onError={() => setBadgeFailed(chainLogo)} />
      )}
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
