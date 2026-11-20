"use client";

import { useId } from "react";
import type { LadderSummary } from "@/lib/hedge/types";
import { DataSourceBadge } from "./data-source-badge";
import { formatCountdown, formatLocalDateTime } from "./format";

/** Props for {@link LadderPicker}. */
export interface LadderPickerProps {
  /** Ladders available for the selected asset. */
  ladders: LadderSummary[];
  /** Event ticker of the selected ladder, or null when none is selected. */
  selectedTicker: string | null;
  /** Called with the event ticker the user picks. */
  onSelect: (eventTicker: string) => void;
  /** Current time in epoch milliseconds for countdowns, or null before the client clock is known. */
  nowMs: number | null;
  /** The selected asset, used in empty and loading copy. */
  asset: string;
  /** True while the list is loading. */
  loading?: boolean;
  /** A readable message when the list could not be loaded. */
  error?: string | null;
}

/**
 * The Gemini ladders available for the asset, each with time to expiry, local
 * expiry time, how many rungs carry a quote, and whether the data is live or a
 * snapshot.
 *
 * @param {LadderPickerProps} props - Component props.
 * @returns {JSX.Element} The picker.
 */
export function LadderPicker({
  ladders,
  selectedTicker,
  onSelect,
  nowMs,
  asset,
  loading = false,
  error = null,
}: LadderPickerProps) {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="stretch-semiwide text-[15px] font-semibold">
          Price ladder
        </h2>
        <p className="text-sm leading-relaxed text-graphite">
          A ladder is a set of contracts on one expiry price. Each pays $1 if {asset} settles at or
          above its strike.
        </p>
      </div>

      {error !== null && error !== "" ? (
        <p role="alert" className="rounded-[5px] border border-alarm/30 bg-alarm-tint px-3 py-2 text-sm text-alarm">
          {error}
        </p>
      ) : null}

      {loading && ladders.length === 0 ? (
        <div className="flex flex-col gap-2" aria-live="polite">
          <div className="h-[74px] animate-pulse rounded-[5px] bg-fog-deep" />
          <p className="text-xs text-graphite">Looking up {asset} ladders on Gemini</p>
        </div>
      ) : null}

      {!loading && ladders.length === 0 && (error === null || error === "") ? (
        <p className="rounded-[5px] border border-dashed border-rule px-3 py-3 text-sm text-graphite">
          Gemini lists no {asset} ladder right now. Try another asset, or check back after the next
          ladder opens.
        </p>
      ) : null}

      {ladders.length > 0 ? (
        <div role="radiogroup" aria-labelledby={headingId} className="flex flex-col gap-1.5">
          {ladders.map((ladder) => {
            const selected = ladder.eventTicker === selectedTicker;
            const countdown = nowMs !== null ? formatCountdown(ladder.expiry, nowMs) : null;
            const expired = countdown === "expired";
            return (
              <button
                key={ladder.eventTicker}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onSelect(ladder.eventTicker)}
                className={`flex flex-col gap-1.5 rounded-[5px] border-l-[3px] px-3 py-2.5 text-left transition-colors ${
                  selected
                    ? "border-l-cobalt bg-paper"
                    : "border-l-transparent bg-fog-deep/60 hover:bg-paper/70"
                }`}
              >
                <span className="flex items-start justify-between gap-3">
                  <span className="text-sm font-semibold leading-snug">{ladder.title}</span>
                  <DataSourceBadge source={ladder.source} />
                </span>
                <span className="figures flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-graphite">
                  <span className={expired ? "font-medium text-alarm" : "font-medium text-ink"}>
                    {countdown === null
                      ? "Expiry"
                      : expired
                        ? "Expired"
                        : `Expires in ${countdown}`}
                  </span>
                  <time dateTime={ladder.expiry} suppressHydrationWarning>
                    {formatLocalDateTime(ladder.expiry)}
                  </time>
                  <span>
                    {ladder.quotedRungCount} of {ladder.rungCount} rungs quoted
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
