"use client";

import { useId } from "react";
import { Bar, BarChart, CartesianGrid, LabelList, Tooltip, XAxis, YAxis } from "recharts";
import type { BarShapeProps, TooltipContentProps } from "recharts";
import type { PriceState } from "@/lib/hedge/types";
import { formatPercent, formatPriceInterval, formatStrike } from "./format";

/** Chart colours, mirrored from the theme tokens in globals.css. */
const CHART_COLORS = {
  ink: "#142033",
  graphite: "#566173",
  rule: "#d4dae1",
  bar: "#b9c2cf",
  cobalt: "#2741c4",
  hatchBase: "#f3f5f8",
} as const;

/** Bars below this probability get no value label, to keep the axis readable. */
const LABEL_THRESHOLD = 0.005;

/** One bar of the distribution chart. */
interface DistributionRow {
  index: number;
  tick: string;
  interval: string;
  probability: number;
  isBelowLadder: boolean;
  containsSpot: boolean;
}

/** Props for {@link DistributionChart}. */
export interface DistributionChartProps {
  /** Price states with their market-implied probabilities, ordered by index. */
  states: PriceState[];
  /** Current spot price, used to highlight the interval it falls in; null when unknown. */
  spot: number | null;
  /** Asset symbol for copy, for example "SOL". */
  asset: string;
  /** Chart height in pixels. Defaults to 220. */
  height?: number;
}

/**
 * Short x-axis label for a price state: "<$68" for the bottom state, "$75+" for
 * the top state, otherwise the lower bound.
 *
 * @param {PriceState} state - The price state.
 * @returns {string} The tick label.
 */
function stateTick(state: PriceState): string {
  if (state.lower === null) {
    return state.upper !== null ? `<${formatStrike(state.upper)}` : "all";
  }
  if (state.upper === null) {
    return `${formatStrike(state.lower)}+`;
  }
  return formatStrike(state.lower);
}

/**
 * Whether a price falls inside a state's interval.
 *
 * @param {PriceState} state - The price state.
 * @param {number} price - The price to test.
 * @returns {boolean} True when lower <= price < upper, treating null bounds as open.
 */
function stateContains(state: PriceState, price: number): boolean {
  const aboveLower = state.lower === null || price >= state.lower;
  const belowUpper = state.upper === null || price < state.upper;
  return aboveLower && belowUpper;
}

/**
 * Tooltip body: the full interval and its implied probability.
 *
 * @param {TooltipContentProps} props - Tooltip state from recharts.
 * @returns {JSX.Element | null} The tooltip, or null when inactive.
 */
function DistributionTooltip({ active, payload }: TooltipContentProps) {
  if (active !== true || payload === undefined || payload.length === 0) {
    return null;
  }
  const row = payload[0].payload as DistributionRow;
  return (
    <div className="figures rounded-[5px] border border-rule bg-paper px-3 py-2 text-xs shadow-[0_2px_10px_rgba(20,32,51,0.12)]">
      <p className="font-semibold text-ink">Settles {row.interval}</p>
      <p className="text-graphite">
        Implied probability <span className="font-semibold text-ink">{formatPercent(row.probability, 1)}</span>
      </p>
    </div>
  );
}

/**
 * Formats a bar value label, hiding labels for very small probabilities.
 *
 * @param {unknown} value - The bar's probability.
 * @returns {string} The label text.
 */
function formatBarLabel(value: unknown): string {
  if (typeof value !== "number" || value < LABEL_THRESHOLD) {
    return "";
  }
  return formatPercent(value, value < 0.1 ? 1 : 0);
}

/**
 * Formats a y-axis tick as a whole percentage.
 *
 * @param {number} value - Tick value as a fraction.
 * @returns {string} The tick label.
 */
function formatProbabilityTick(value: number): string {
  return formatPercent(value, 0);
}

/**
 * The market-implied probability of each expiry price interval, read from the
 * ladder's mid quotes. The interval containing spot is drawn in cobalt; the
 * interval below the lowest strike is hatched to match the payoff chart.
 *
 * @param {DistributionChartProps} props - Component props.
 * @returns {JSX.Element} The chart.
 */
export function DistributionChart({ states, spot, asset, height = 220 }: DistributionChartProps) {
  const hatchId = `distribution-hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const rows: DistributionRow[] = states.map((state) => ({
    index: state.index,
    tick: stateTick(state),
    interval: formatPriceInterval(state.lower, state.upper),
    probability: state.probability,
    isBelowLadder: state.lower === null,
    containsSpot: spot !== null && stateContains(state, spot),
  }));

  /**
   * Draws one bar, coloured by its role.
   *
   * @param {BarShapeProps} props - Bar geometry and payload from recharts.
   * @returns {JSX.Element} The bar rectangle.
   */
  function renderBar(props: BarShapeProps) {
    const row = props.payload as DistributionRow;
    const barHeight = Math.max(props.height, 0);
    const fill = row.isBelowLadder
      ? `url(#${hatchId})`
      : row.containsSpot
        ? CHART_COLORS.cobalt
        : CHART_COLORS.bar;
    return (
      <rect
        x={props.x}
        y={props.y}
        width={props.width}
        height={barHeight}
        fill={fill}
        stroke={row.isBelowLadder ? CHART_COLORS.graphite : "none"}
        strokeWidth={row.isBelowLadder ? 1 : 0}
        rx={1.5}
      />
    );
  }

  return (
    <figure className="flex flex-col gap-3">
      <figcaption className="flex flex-col gap-1">
        <span className="stretch-semiwide text-[15px] font-semibold">Where the market expects {asset} to settle</span>
        <span className="text-sm leading-relaxed text-graphite">
          Probabilities implied by mid quotes on the ladder. The cobalt bar holds today&apos;s spot.
        </span>
      </figcaption>
      <svg width="0" height="0" className="absolute" aria-hidden="true" focusable="false">
        <defs>
          <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill={CHART_COLORS.hatchBase} />
            <line x1="0" y1="3" x2="6" y2="3" stroke={CHART_COLORS.ink} strokeOpacity="0.35" strokeWidth="1.2" />
          </pattern>
        </defs>
      </svg>
      <div style={{ height }} className="w-full">
        {rows.length > 0 ? (
          <BarChart
            data={rows}
            responsive
            style={{ width: "100%", height: "100%" }}
            margin={{ top: 18, right: 4, bottom: 0, left: 0 }}
            barCategoryGap="18%"
            accessibilityLayer
          >
            <CartesianGrid stroke={CHART_COLORS.rule} vertical={false} />
            <XAxis
              dataKey="tick"
              interval={0}
              tick={{ fill: CHART_COLORS.graphite, fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: CHART_COLORS.rule }}
            />
            <YAxis
              tickFormatter={formatProbabilityTick}
              tick={{ fill: CHART_COLORS.graphite, fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={40}
              domain={[0, "auto"]}
            />
            <Tooltip
              content={DistributionTooltip}
              cursor={{ fill: CHART_COLORS.rule, fillOpacity: 0.35 }}
              isAnimationActive={false}
            />
            <Bar dataKey="probability" shape={renderBar} isAnimationActive={false}>
              <LabelList
                dataKey="probability"
                position="top"
                formatter={formatBarLabel}
                fill={CHART_COLORS.ink}
                fontSize={11}
              />
            </Bar>
          </BarChart>
        ) : (
          <div className="flex h-full items-center justify-center rounded-[5px] border border-dashed border-rule px-6 text-center text-sm text-graphite">
            No implied distribution yet. It appears once a ladder with quotes is loaded.
          </div>
        )}
      </div>
    </figure>
  );
}
