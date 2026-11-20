import type { HedgePlan, HedgeStatus } from "@/lib/hedge/types";
import {
  formatCountdown,
  formatLocalDateTime,
  formatPercent,
  formatQuantity,
  formatStrike,
  formatUsd,
} from "./format";

/** Props for {@link PlanStats}. */
export interface PlanStatsProps {
  /** The computed plan, or null before one exists. */
  plan: HedgePlan | null;
  /** Position value in dollars (quantity times spot). */
  positionValue: number;
  /** Asset symbol for copy, for example "SOL". */
  asset: string;
  /** Ladder expiry as ISO 8601, or null when no ladder is selected. */
  expiry: string | null;
  /** Current time in epoch milliseconds for the countdown, or null before the client clock is known. */
  nowMs: number | null;
  /** The ladder's lowest strike, where protection stops; null when unknown. */
  lowestStrike: number | null;
  /** Largest quantity the quotes can hedge to this floor, or null when depth is unlimited or unknown. */
  maxHedgeableQuantity: number | null;
  /** True when the hedgeable quantity rests on an assumed depth rather than published sizes. */
  depthAssumed: boolean;
  /** True while the plan is being computed. */
  loading?: boolean;
  /** A readable message when the plan could not be computed. */
  error?: string | null;
  /**
   * Optional content placed directly under the three headline figures, before
   * the supporting figures. Intended for the payoff chart, so it sits next to
   * the numbers it explains.
   */
  chartSlot?: React.ReactNode;
  /** Replaces the text shown when `maxHedgeableQuantity` is null, for example while it is being computed. */
  maxHedgeableNote?: string | null;
  /** Replaces the "on assumed depth" / "on quoted sizes" caption under the largest hedgeable quantity. */
  depthNote?: string | null;
}

/** Plain-language headline and explanation for each plan status. */
interface StatusCopy {
  title: string;
  body: string;
}

/**
 * Builds the status headline and explanation for a plan.
 *
 * @param {HedgeStatus} status - The plan status.
 * @param {HedgePlan} plan - The plan, for figures used in the copy.
 * @returns {StatusCopy} Headline and explanation.
 */
function statusCopy(status: HedgeStatus, plan: HedgePlan): StatusCopy {
  const floor = formatUsd(-plan.requestedMaxLoss);
  switch (status) {
    case "optimal":
      return {
        title: "Floor met",
        body: `This is the lowest-cost basket that keeps every price range at or above your floor of ${floor} at expiry.`,
      };
    case "best-effort":
      return {
        title: "Floor out of reach",
        body: `The quoted contracts and depth cannot hold every price range at ${floor}. This basket lifts the worst case as far as the quotes allow, to ${formatUsd(plan.worstCaseAfter)}.`,
      };
    case "no-hedge-needed":
      return {
        title: "No hedge needed",
        body: `Your holding already stays at or above ${floor} in every price range down to ${formatUsd(plan.stressPrice)}. There is nothing to buy.`,
      };
    case "unhedgeable":
      return {
        title: "No contract helps",
        body: "None of the quoted contracts improves your worst case, so there is nothing worth buying on this ladder.",
      };
  }
}

/**
 * A small shape that marks the plan status without colour alone.
 *
 * @param {{ status: HedgeStatus }} props - Component props.
 * @param {HedgeStatus} props.status - The plan status.
 * @returns {JSX.Element} The status mark.
 */
function StatusMark({ status }: { status: HedgeStatus }) {
  if (status === "optimal") {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0 text-cobalt">
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path d="M4.6 8.2l2.2 2.2 4.6-4.8" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === "best-effort") {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0 text-alarm">
        <path d="M8 1.5l7 12.5H1z" fill="currentColor" />
        <path d="M8 6v4" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="8" cy="12" r="0.9" fill="#fff" />
      </svg>
    );
  }
  if (status === "no-hedge-needed") {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0 text-cobalt">
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0 text-graphite">
      <rect x="2" y="2" width="12" height="12" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5 8h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * A horizontal scale of losses: the worst case without and with the hedge, and
 * the floor as a tick. Longer bars are larger losses.
 *
 * @param {{ before: number; after: number; floor: number }} props - Component props.
 * @param {number} props.before - Worst case without the hedge, in dollars.
 * @param {number} props.after - Worst case with the hedge, in dollars.
 * @param {number} props.floor - The floor as a non-positive dollar amount.
 * @returns {JSX.Element} The loss scale.
 */
function LossScale({ before, after, floor }: { before: number; after: number; floor: number }) {
  const lossBefore = Math.max(0, -before);
  const lossAfter = Math.max(0, -after);
  const lossFloor = Math.max(0, -floor);
  const scaleMax = Math.max(lossBefore, lossAfter, lossFloor, 1) * 1.04;

  /**
   * Converts a loss to a percentage of the scale width.
   *
   * @param {number} loss - Loss in dollars.
   * @returns {string} A CSS percentage.
   */
  function toWidth(loss: number): string {
    return `${(loss / scaleMax) * 100}%`;
  }

  return (
    <div className="relative mt-1 flex flex-col gap-1.5 pt-5" aria-hidden="true">
      <div
        className="absolute top-0 flex -translate-x-1/2 flex-col items-center"
        style={{ left: toWidth(lossFloor) }}
      >
        <span className="figures whitespace-nowrap text-[11px] font-medium text-ink">Floor</span>
      </div>
      <div
        className="absolute bottom-0 top-4 w-px bg-ink"
        style={{ left: toWidth(lossFloor) }}
      />
      <div className="h-2.5 rounded-r-[2px] bg-graphite/35" style={{ width: toWidth(lossBefore) }} />
      <div className="h-2.5 rounded-r-[2px] bg-cobalt" style={{ width: toWidth(lossAfter) }} />
    </div>
  );
}

/**
 * The plan in numbers. Leads with the three figures that decide it (worst case
 * without the hedge, worst case with it, and what it costs), then supporting
 * figures and the limit of the protection below the lowest strike.
 *
 * @param {PlanStatsProps} props - Component props.
 * @param {React.ReactNode} [props.chartSlot] - Content shown under the headline figures.
 * @returns {JSX.Element} The summary.
 */
export function PlanStats({
  plan,
  positionValue,
  asset,
  expiry,
  nowMs,
  lowestStrike,
  maxHedgeableQuantity,
  depthAssumed,
  loading = false,
  error = null,
  chartSlot = null,
  maxHedgeableNote = null,
  depthNote = null,
}: PlanStatsProps) {
  if (error !== null && error !== "") {
    return (
      <section role="alert" className="flex flex-col gap-2 rounded-[6px] border border-alarm/30 bg-alarm-tint px-5 py-4">
        <h2 className="stretch-semiwide text-[15px] font-semibold text-alarm">The hedge could not be computed</h2>
        <p className="text-sm leading-relaxed text-ink">{error}</p>
      </section>
    );
  }

  if (plan === null) {
    return (
      <section aria-live="polite" className="@container flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-6 @2xl:grid-cols-3">
          {["Worst case without a hedge", "Worst case with the hedge", "Cost of the hedge"].map((label) => (
            <div key={label} className="flex flex-col gap-2">
              <span className="text-sm text-graphite">{label}</span>
              <span
                className={`h-11 w-40 rounded-[4px] bg-fog-deep ${loading ? "animate-pulse" : ""}`}
              />
            </div>
          ))}
        </div>
        <p className="text-sm text-graphite">
          {loading
            ? "Finding the cheapest basket for your floor"
            : "Choose a ladder and enter your holding to see the hedge."}
        </p>
        {chartSlot}
      </section>
    );
  }

  const copy = statusCopy(plan.status, plan);
  const costShare = positionValue > 0 ? plan.totalCost / positionValue : Number.NaN;
  const netExpectedCost = plan.totalCost - plan.expectedHedgePayout;
  const floor = -plan.requestedMaxLoss;
  const floorMet = plan.worstCaseAfter >= floor - 0.005;
  const bottomOutcome = plan.outcomes.length > 0 ? plan.outcomes[0] : null;
  const countdown = expiry !== null && nowMs !== null ? formatCountdown(expiry, nowMs) : null;
  // Large positions (BTC) produce figures like -$17,611.55 that overflow at the largest size.
  const longestFigure = Math.max(
    formatUsd(plan.worstCaseBefore).length,
    formatUsd(plan.worstCaseAfter).length,
    formatUsd(plan.totalCost).length,
  );
  const figureSize =
    longestFigure > 8 ? "text-[1.75rem] @3xl:text-[2.125rem]" : "text-[2.5rem] @3xl:text-5xl";

  return (
    <section aria-label="Hedge summary" className="@container flex flex-col gap-6">
      <div className="flex items-start gap-2.5">
        <StatusMark status={plan.status} />
        <p className="max-w-[68ch] text-sm leading-relaxed text-graphite">
          <span className={`font-semibold ${plan.status === "best-effort" ? "text-alarm" : "text-ink"}`}>
            {copy.title}.
          </span>{" "}
          {copy.body}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-x-8 gap-y-5 @2xl:grid-cols-[1fr_1fr_auto]">
        <div className="flex flex-col gap-1">
          <span className="text-sm text-graphite">Worst case without a hedge</span>
          <span className={`figures stretch-wide ${figureSize} font-medium leading-none tracking-tight text-ink/75`}>
            {formatUsd(plan.worstCaseBefore)}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-ink">Worst case with the hedge</span>
          <span className={`figures stretch-wide ${figureSize} font-bold leading-none tracking-tight text-cobalt`}>
            {formatUsd(plan.worstCaseAfter)}
          </span>
        </div>
        <div className="flex flex-col gap-1 @2xl:border-l @2xl:border-rule @2xl:pl-8">
          <span className="text-sm text-graphite">Cost of the hedge</span>
          <span className={`figures stretch-wide ${figureSize} font-bold leading-none tracking-tight text-ink`}>
            {formatUsd(plan.totalCost)}
          </span>
          <span className="figures text-xs text-graphite">
            {formatPercent(costShare)} of position, fees included
          </span>
        </div>
        <div className="@2xl:col-span-2">
          <LossScale before={plan.worstCaseBefore} after={plan.worstCaseAfter} floor={floor} />
          <p className="figures mt-1.5 text-xs text-graphite">
            Floor {formatUsd(floor)}.{" "}
            {floorMet
              ? `With the hedge, the worst case sits ${formatUsd(plan.worstCaseAfter - floor)} above it.`
              : `With the hedge, the worst case is still ${formatUsd(floor - plan.worstCaseAfter)} below it.`}
          </p>
        </div>
      </div>

      {chartSlot}

      <dl className="figures grid grid-cols-2 gap-x-6 gap-y-4 border-y border-rule py-4 text-sm @2xl:grid-cols-4">
        <div className="flex flex-col gap-0.5">
          <dt className="text-graphite">Expected hedge payout</dt>
          <dd className="text-base font-semibold">{formatUsd(plan.expectedHedgePayout)}</dd>
          <dd className="text-xs text-graphite">weighted by implied odds</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-graphite">Net expected cost</dt>
          <dd className="text-base font-semibold">{formatUsd(netExpectedCost)}</dd>
          <dd className="text-xs text-graphite">cost minus expected payout</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-graphite">Largest position hedgeable</dt>
          {maxHedgeableQuantity !== null ? (
            <>
              <dd className="text-base font-semibold">
                {formatQuantity(maxHedgeableQuantity)} {asset}
              </dd>
              <dd className="text-xs text-graphite">
                {depthNote !== null && depthNote !== ""
                  ? depthNote
                  : depthAssumed
                    ? "at this floor, on assumed depth"
                    : "at this floor, on quoted sizes"}
              </dd>
            </>
          ) : (
            <dd className="text-sm leading-snug text-graphite">
              {maxHedgeableNote !== null && maxHedgeableNote !== ""
                ? maxHedgeableNote
                : "not known: depth is unlimited or unknown"}
            </dd>
          )}
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-graphite">Ladder expires</dt>
          <dd className="text-base font-semibold">
            {countdown === null ? "–" : countdown === "expired" ? "Expired" : `in ${countdown}`}
          </dd>
          {expiry !== null ? (
            <dd className="text-xs text-graphite">
              <time dateTime={expiry} suppressHydrationWarning>
                {formatLocalDateTime(expiry)}
              </time>
            </dd>
          ) : null}
        </div>
      </dl>

      {lowestStrike !== null ? (
        <p className="max-w-[72ch] text-sm leading-relaxed text-ink">
          <span className="font-semibold">Protection stops at {formatStrike(lowestStrike)}.</span>{" "}
          {plan.legs.length > 0 && bottomOutcome !== null
            ? `If ${asset} settles below ${formatStrike(lowestStrike)}, the basket pays a fixed ${formatUsd(bottomOutcome.hedgePayout)} and every further dollar of decline is your loss again. `
            : `Below ${formatStrike(lowestStrike)} the ladder has no lower strikes, so the loss keeps growing with the price. `}
          The worst cases above are measured at expiry, down to {formatUsd(plan.stressPrice)}.
        </p>
      ) : null}
    </section>
  );
}
