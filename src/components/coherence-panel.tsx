import type { CoherenceFinding, CoherenceKind } from "@/lib/hedge/types";
import { formatStrike, formatUsd } from "./format";

/** Props for {@link CoherencePanel}. */
export interface CoherencePanelProps {
  /** Findings from the coherence check; empty when the quotes are consistent. */
  findings: CoherenceFinding[];
}

/** Readable name and one-line explanation for each kind of finding. */
const KIND_COPY: Record<CoherenceKind, { name: string; explanation: string; executable: boolean }> = {
  arbitrage: {
    name: "Executable mispricing",
    explanation:
      "Buying YES on the lower strike and NO on the higher one costs less than the $1 the pair is certain to pay. Fees and size can close the gap.",
    executable: true,
  },
  "bid-inversion": {
    name: "Bid inversion",
    explanation:
      "The higher strike is bid above the lower one, which a consistent ladder never does. It cannot be traded on by buying alone.",
    executable: false,
  },
  "ask-inversion": {
    name: "Ask inversion",
    explanation:
      "The higher strike is offered above the lower one, which a consistent ladder never does. It cannot be traded on by buying alone.",
    executable: false,
  },
};

/**
 * Checks the ladder's quotes against each other. A higher strike can never be
 * more likely than a lower one, so its price should never be higher. Lists any
 * pair that breaks this, and says plainly when none do.
 *
 * @param {CoherencePanelProps} props - Component props.
 * @returns {JSX.Element} The panel.
 */
export function CoherencePanel({ findings }: CoherencePanelProps) {
  return (
    <section aria-label="Quote consistency" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="stretch-semiwide text-[15px] font-semibold">Quote consistency</h2>
        <p className="text-sm leading-relaxed text-graphite">
          A higher strike can never be more likely than a lower one, so it should never be priced
          above it.
        </p>
      </div>

      {findings.length === 0 ? (
        <p className="flex items-start gap-2.5 rounded-[5px] bg-fog px-3 py-3 text-sm leading-relaxed">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="mt-0.5 shrink-0 text-cobalt">
            <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M5 8.2l2 2 4-4.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>
            <span className="font-semibold">Consistent.</span> Every strike is priced at or below the
            one beneath it, on both bids and asks.
          </span>
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-rule border-y border-rule">
          {findings.map((finding) => {
            const copy = KIND_COPY[finding.kind];
            return (
              <li
                key={`${finding.kind}-${finding.lowerStrike}-${finding.higherStrike}`}
                className="flex flex-col gap-1 py-3"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="flex items-center gap-2 text-sm font-semibold">
                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className={copy.executable ? "text-alarm" : "text-graphite"}>
                      {copy.executable ? (
                        <path d="M5 0.5l4.5 8.5H0.5z" fill="currentColor" />
                      ) : (
                        <path d="M5 0.75l4.25 8H0.75z" fill="none" stroke="currentColor" strokeWidth="1.3" />
                      )}
                    </svg>
                    {copy.name}
                    <span className="figures font-normal text-graphite">
                      {formatStrike(finding.lowerStrike)} and {formatStrike(finding.higherStrike)}
                    </span>
                  </span>
                  <span className="figures text-sm">
                    <span className="text-graphite">gap </span>
                    <span className="font-semibold">{formatUsd(finding.edge)}</span>
                    <span className="text-graphite"> per pair</span>
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-graphite">{copy.explanation}</p>
                {finding.detail !== "" ? (
                  <p className="figures text-xs leading-relaxed text-ink">{finding.detail}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
