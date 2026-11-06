import { formatAmount, formatEta, shorten, type OrderStage, type PublicRoute } from "./journey.ts";
import { chainNameOf as chainOf, symbolOf } from "./asset-book.ts";
import { Coin } from "./ui.tsx";

export function Stepper({ stages }: { stages: OrderStage[] }) {
  return (
    <ol className="stepper" aria-label="Swap progress">
      {stages.map((stage, index) => (
        <li key={stage.id} className={`step is-${stage.state}`} aria-current={stage.state === "current" ? "step" : undefined}>
          <span className="step-mark" aria-hidden="true">
            {stage.state === "done" ? (
              <svg viewBox="0 0 16 16" width="12" height="12">
                <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              index + 1
            )}
          </span>
          <span className="step-name">{stage.name}</span>
        </li>
      ))}
    </ol>
  );
}

/** How far along the usual time it is. It slows near the end, since the estimate isn't a promise. */
const progressShare = (elapsed: number, eta: number) => Math.min(0.94, 1 - Math.exp(-elapsed / Math.max(eta * 0.7, 10)));

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export function InFlight(props: {
  stages: OrderStage[];
  status: string;
  route: PublicRoute | undefined;
  providerName: string;
  from: string;
  to: string;
  amount: string;
  recipient: string;
  elapsedSeconds: number;
  sentLink: { label: string; url: string } | null;
  /** The quote's estimate no longer applies once a different amount arrives. */
  sentDiffers?: boolean;
}) {
  const { stages, status, route, from, to, amount, recipient, elapsedSeconds, sentLink, sentDiffers } = props;
  const eta = route?.etaSeconds ?? 60;
  const etaText = formatEta(eta);
  const detail =
    status === "exchanging" ? `Swapping through ${props.providerName}` : `Confirming on ${chainOf(from)}, then swapping through ${props.providerName}`;
  const sentName = stages[0]?.name ?? "Deposit received";
  return (
    <section className="flight glass" aria-label="Swap in progress">
      <Stepper stages={stages} />
      <div className="flight-route">
        <div className="flight-end">
          <Coin asset={from} size={44} />
          <p>
            <strong>
              {amount} {symbolOf(from)}
            </strong>
            <span>on {chainOf(from)}</span>
          </p>
        </div>
        <div className="flight-track" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </div>
        <div className="flight-end">
          <Coin asset={to} size={44} />
          <p>
            <strong>
              {route && !sentDiffers ? `~${formatAmount(route.amountOut)}` : ""} {symbolOf(to)}
            </strong>
            <span>on {chainOf(to)}</span>
          </p>
        </div>
      </div>

      <div className="flight-status">
        <h2 role="status">{detail}</h2>
        <p className="flight-clock">{clock(elapsedSeconds)}</p>
      </div>
      <div
        className="flight-bar"
        role="progressbar"
        aria-label="Estimated progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progressShare(elapsedSeconds, eta) * 100)}
      >
        <span style={{ width: `${progressShare(elapsedSeconds, eta) * 100}%` }} />
      </div>
      {etaText && <p className="flight-eta">{etaText} is usual for this route. The swap continues even if you close this page.</p>}

      <ul className="timeline">
        <li className="is-done">
          <span>{sentName}</span>
          {sentLink && (
            <a href={sentLink.url} target="_blank" rel="noreferrer">
              View on {sentLink.label}
            </a>
          )}
        </li>
        <li className="is-current">
          <span>Swapping {symbolOf(from)} to {symbolOf(to)}</span>
        </li>
        <li>
          <span>
            Delivered to {shorten(recipient)} on {chainOf(to)}
          </span>
        </li>
      </ul>
    </section>
  );
}
