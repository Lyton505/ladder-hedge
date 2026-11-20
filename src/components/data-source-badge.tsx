import type { DataSource } from "@/lib/hedge/types";

/** Props for {@link DataSourceBadge}. */
export interface DataSourceBadgeProps {
  /** Whether the data was read live from Gemini or from a captured snapshot. */
  source: DataSource;
  /** Optional extra text after the label, for example a capture time. */
  detail?: string;
}

/**
 * A small label that states where a piece of data came from. Live data gets a
 * solid cobalt mark; snapshot data gets a dashed hollow mark so the two never
 * look alike, even in greyscale.
 *
 * @param {DataSourceBadgeProps} props - Component props.
 * @param {DataSource} props.source - The data source to label.
 * @param {string} [props.detail] - Optional trailing detail text.
 * @returns {JSX.Element} The badge.
 */
export function DataSourceBadge({ source, detail }: DataSourceBadgeProps) {
  const isLive = source === "live";
  const label = isLive ? "Live" : "Snapshot";
  const title = isLive
    ? "Quotes read from Gemini just now"
    : "Captured earlier from Gemini; not live prices";

  return (
    <span
      title={title}
      className={
        isLive
          ? "inline-flex shrink-0 items-center gap-1.5 rounded-[3px] bg-cobalt-tint px-1.5 py-0.5 text-xs font-medium text-cobalt-deep"
          : "inline-flex shrink-0 items-center gap-1.5 rounded-[3px] border border-dashed border-graphite/60 bg-fog-deep px-1.5 py-0.5 text-xs font-medium text-ink"
      }
    >
      <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
        {isLive ? (
          <circle cx="4" cy="4" r="3.5" fill="currentColor" />
        ) : (
          <circle
            cx="4"
            cy="4"
            r="3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeDasharray="1.6 1.2"
          />
        )}
      </svg>
      {label}
      {detail !== undefined && detail !== "" ? (
        <span className="font-normal text-graphite">{detail}</span>
      ) : null}
    </span>
  );
}
