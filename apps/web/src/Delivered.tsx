import { useEffect, useRef, useState } from "react";
import { formatAmount, formatRate, formatUsd, receivedAboveMinimum, sentComparedToQuote, shorten, statusLabel, type PublicRoute } from "./journey.ts";
import { chainNameOf, symbolOf } from "./asset-book.ts";
import { Coin, prefersReducedMotion } from "./ui.tsx";

const PALETTE = ["#7cf2d0", "#8ab4ff", "#a78bff", "#ffffff", "#ff8ec7", "#ffe08a"];
const CONFETTI_MS = 3_400;

/** One burst from behind the amount, drawn on a canvas that removes itself. */
function Confetti() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [done, setDone] = useState(() => prefersReducedMotion());

  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (done || !canvas || !context) return;
    const scale = window.devicePixelRatio || 1;
    const resize = () => {
      canvas.width = window.innerWidth * scale;
      canvas.height = window.innerHeight * scale;
      context.setTransform(scale, 0, 0, scale, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const originX = window.innerWidth / 2;
    const originY = Math.min(window.innerHeight * 0.34, 300);
    const pieces = Array.from({ length: 170 }, (_, index) => {
      const angle = Math.random() * Math.PI * 2;
      const speed = 4 + Math.random() * 11;
      return {
        x: originX,
        y: originY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 5,
        size: 5 + Math.random() * 6,
        spin: Math.random() * Math.PI,
        spinRate: (Math.random() - 0.5) * 0.35,
        color: PALETTE[index % PALETTE.length]!,
        round: index % 4 === 0,
      };
    });

    const started = performance.now();
    let frame = 0;
    const draw = (time: number) => {
      const elapsed = time - started;
      if (elapsed > CONFETTI_MS) {
        setDone(true);
        return;
      }
      context.clearRect(0, 0, window.innerWidth, window.innerHeight);
      context.globalAlpha = Math.min(1, (CONFETTI_MS - elapsed) / 900);
      for (const piece of pieces) {
        piece.vx *= 0.985;
        piece.vy = piece.vy * 0.985 + 0.2;
        piece.x += piece.vx;
        piece.y += piece.vy;
        piece.spin += piece.spinRate;
        context.save();
        context.translate(piece.x, piece.y);
        context.rotate(piece.spin);
        context.fillStyle = piece.color;
        if (piece.round) {
          context.beginPath();
          context.arc(0, 0, piece.size / 2.4, 0, Math.PI * 2);
          context.fill();
        } else {
          context.fillRect(-piece.size / 2, -piece.size / 4, piece.size, (piece.size / 2) * Math.abs(Math.cos(piece.spin)) + 1);
        }
        context.restore();
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, [done]);

  return done ? null : <canvas ref={ref} className="confetti" aria-hidden="true" />;
}

/** Counts up to the amount received, landing exactly on it. */
function useCountUp(target: number, durationMs = 1_400) {
  const [value, setValue] = useState(() => (prefersReducedMotion() ? target : 0));
  useEffect(() => {
    if (prefersReducedMotion()) return setValue(target);
    let frame = 0;
    const started = performance.now();
    const step = (time: number) => {
      const progress = Math.min(1, (time - started) / durationMs);
      setValue(target * (1 - (1 - progress) ** 4));
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);
  return value;
}

export interface ProofLink {
  label: string;
  url: string;
}

export function Delivered(props: {
  route: PublicRoute | undefined;
  from: string;
  to: string;
  amount: string;
  amountSent: string | null;
  partialRefund: boolean;
  refundAddress: string;
  recipient: string;
  amountReceived: string | null;
  elapsedSeconds: number | null;
  links: ProofLink[];
  onAgain: () => void;
}) {
  const { route, from, to, amount, amountSent, partialRefund, refundAddress, recipient, amountReceived, elapsedSeconds, links } = props;
  const sent = amountSent ?? amount;
  const difference = sentComparedToQuote(amountSent, amount);
  const symbolFrom = symbolOf(from);
  const symbolTo = symbolOf(to);
  const chainTo = chainNameOf(to);
  const chainFrom = chainNameOf(from);
  const final = amountReceived ?? route?.amountOut ?? "0";
  const counted = useCountUp(Number(final));
  const settled = counted === Number(final);
  const dollars =
    route?.usd && Number(route.amountOut) > 0 ? formatUsd((route.usd.out / Number(route.amountOut)) * Number(final)) : null;
  // Sending more than quoted says nothing about how well the swap did.
  const above = route && !difference ? receivedAboveMinimum(amountReceived, route.minAmountOut) : null;
  const rate = partialRefund ? null : formatRate(sent, final, symbolFrom, symbolTo);

  return (
    <section className="delivered glass" aria-label="Swap result">
      <Confetti />
      <div className="delivered-bloom" aria-hidden="true" />
      <svg className="delivered-tick" viewBox="0 0 72 72" width="72" height="72" aria-hidden="true">
        <circle className="delivered-ring" cx="36" cy="36" r="31" />
        <path className="delivered-check" d="M23 37.5 32 46.5 50 27" />
      </svg>
      <h2>Swap complete</h2>
      <p className="delivered-amount" aria-label={`${formatAmount(final)} ${symbolTo} received`}>
        <span className="delivered-figure">{settled ? formatAmount(final) : counted.toFixed(Math.max(4, final.split(".")[1]?.length ? 6 : 2))}</span>{" "}
        <span className="delivered-symbol">{symbolTo}</span>
      </p>
      <p className="delivered-sub">
        {dollars && <span>{dollars}</span>} <span>on {chainTo}</span>
      </p>
      <p className="status status-completed delivered-status">{statusLabel("completed")}</p>

      <div className="delivered-flow">
        <span>
          <Coin asset={from} size={22} /> {sent} {symbolFrom} on {chainFrom}
        </span>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M5 12h14m0 0-6-6m6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>
          <Coin asset={to} size={22} /> {formatAmount(final)} {symbolTo} on {chainTo}
        </span>
      </div>

      <dl className="delivered-facts">
        {difference && (
          <div>
            <dt>You sent</dt>
            <dd>
              {sent} {symbolFrom}
              <em className="delivered-notice">
                {difference === "less" ? "Less" : "More"} than the {amount} {symbolFrom} quoted, and {partialRefund ? "the part that couldn't swap went back" : "all of it swapped"}
              </em>
            </dd>
          </div>
        )}
        {partialRefund && (
          <div>
            <dt>Refund</dt>
            <dd>Part of your deposit went back to {shorten(refundAddress)}</dd>
          </div>
        )}
        {route && difference !== "less" && (
          <div>
            <dt>Guaranteed at least</dt>
            <dd>
              {formatAmount(route.minAmountOut)} {symbolTo}
              {above && <em> You got {above} more</em>}
            </dd>
          </div>
        )}
        {rate && (
          <div>
            <dt>Rate you got</dt>
            <dd>{rate}</dd>
          </div>
        )}
        {elapsedSeconds !== null && (
          <div>
            <dt>Time from deposit</dt>
            <dd>{elapsedSeconds < 90 ? `${elapsedSeconds} seconds` : `${Math.round(elapsedSeconds / 60)} minutes`}</dd>
          </div>
        )}
        <div>
          <dt>Sent to</dt>
          <dd className="delivered-address" title={recipient}>
            {shorten(recipient)}
          </dd>
        </div>
      </dl>

      {links.length > 0 && (
        <div className="proof-links">
          {links.map((link) => (
            <a key={link.url} href={link.url} target="_blank" rel="noreferrer">
              {link.label}
            </a>
          ))}
        </div>
      )}
      <button className="primary delivered-action" onClick={props.onAgain}>
        Start another swap
      </button>
    </section>
  );
}
