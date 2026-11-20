"use client";

import { useId } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
  pattern,
} from "recharts";
import type { TooltipContentProps } from "recharts";
import type { PayoffPoint } from "@/lib/hedge/types";
import { formatStrike, formatUsd } from "./format";

/** Chart colours, mirrored from the theme tokens in globals.css (SVG attributes cannot read Tailwind classes). */
const CHART_COLORS = {
  ink: "#142033",
  graphite: "#566173",
  rule: "#d4dae1",
  cobalt: "#2741c4",
  hatchBase: "#f3f5f8",
} as const;

/** Diagonal hatching for the price range the hedge does not protect. Defined once, outside render. */
const UNPROTECTED_FILL = {
  color: CHART_COLORS.hatchBase,
  definition: pattern({
    width: 7,
    height: 7,
    rotation: 45,
    path: "M0 3.5H7",
    strokeWidth: 1.2,
    color: CHART_COLORS.ink,
    opacity: 0.28,
  }),
};

/** Props for {@link PayoffChart}. */
export interface PayoffChartProps {
  /** Profit and loss at expiry across prices, sorted by price. */
  points: PayoffPoint[];
  /** Largest acceptable loss in dollars, as a non-negative number; drawn as the floor line. */
  maxLoss: number;
  /** Current spot price, drawn as a vertical line, or null when unknown. */
  spot: number | null;
  /** Ladder strikes, ascending. The first is where protection stops. */
  strikes: number[];
  /** Asset symbol for copy, for example "SOL". */
  asset: string;
  /** Quantity held, for copy; null while the quantity field is blank or invalid, which keeps the caption neutral. */
  quantity: number | null;
  /** True while the plan is being computed and no points are available yet. */
  loading?: boolean;
  /** Chart height in pixels. Defaults to 340. */
  height?: number;
}

/**
 * Tooltip body for the payoff chart: the expiry price and both outcomes.
 *
 * @param {TooltipContentProps} props - Tooltip state from recharts.
 * @returns {JSX.Element | null} The tooltip, or null when inactive.
 */
function PayoffTooltip({ active, payload }: TooltipContentProps) {
  if (active !== true || payload === undefined || payload.length === 0) {
    return null;
  }
  const point = payload[0].payload as PayoffPoint;
  const difference = point.hedged - point.unhedged;
  return (
    <div className="figures rounded-[5px] border border-rule bg-paper px-3 py-2 text-xs shadow-[0_2px_10px_rgba(20,32,51,0.12)]">
      <p className="mb-1 font-semibold text-ink">Settles at {formatUsd(point.price)}</p>
      <p className="flex justify-between gap-6 text-graphite">
        <span>Without hedge</span>
        <span className="text-ink">{formatUsd(point.unhedged)}</span>
      </p>
      <p className="flex justify-between gap-6 text-graphite">
        <span>With hedge</span>
        <span className="font-semibold text-cobalt">{formatUsd(point.hedged)}</span>
      </p>
      <p className="mt-1 flex justify-between gap-6 border-t border-rule pt-1 text-graphite">
        <span>Hedge effect</span>
        <span className="text-ink">{formatUsd(difference, { signed: true })}</span>
      </p>
    </div>
  );
}

/**
 * Formats a y-axis tick as whole dollars.
 *
 * @param {number} value - Tick value in dollars.
 * @returns {string} The tick label.
 */
function formatDollarTick(value: number): string {
  return formatUsd(value, { decimals: 0 });
}

/**
 * Formats an x-axis tick as a strike price.
 *
 * @param {number} value - Tick value in dollars.
 * @returns {string} The tick label.
 */
function formatPriceTick(value: number): string {
  return formatStrike(value);
}

/** Candidate multipliers for a readable y-axis step. */
const NICE_STEP_MULTIPLIERS: readonly number[] = [1, 2, 2.5, 5, 10];

/** Y-axis range with evenly spaced round ticks. */
interface DollarScale {
  domain: [number, number];
  ticks: number[];
}

/**
 * Builds a y-axis scale with round dollar ticks that covers the data, zero and the floor.
 *
 * @param {PayoffPoint[]} points - The payoff points.
 * @param {number} floorValue - The floor as a non-positive dollar amount.
 * @param {number} [targetTickCount=6] - Roughly how many intervals to aim for.
 * @returns {DollarScale} The domain and tick values.
 */
function buildDollarScale(points: PayoffPoint[], floorValue: number, targetTickCount: number = 6): DollarScale {
  let low = Math.min(0, floorValue);
  let high = 0;
  for (const point of points) {
    low = Math.min(low, point.unhedged, point.hedged);
    high = Math.max(high, point.unhedged, point.hedged);
  }
  const range = Math.max(high - low, 1);
  const rawStep = range / targetTickCount;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  let step = magnitude * 10;
  for (const multiplier of NICE_STEP_MULTIPLIERS) {
    if (multiplier * magnitude >= rawStep) {
      step = multiplier * magnitude;
      break;
    }
  }
  const domainLow = Math.floor(low / step) * step;
  const domainHigh = Math.ceil(high / step) * step;
  const ticks: number[] = [];
  for (let tick = domainLow; tick <= domainHigh + step / 2; tick += step) {
    ticks.push(Number(tick.toFixed(6)));
  }
  return { domain: [domainLow, domainHigh], ticks };
}

/**
 * Profit and loss at expiry with and without the hedge, across expiry prices.
 * Shows the loss floor, the spot price, and hatches the range below the lowest
 * strike where the hedge pays a fixed amount and the holder is exposed again.
 *
 * @param {PayoffChartProps} props - Component props.
 * @returns {JSX.Element} The chart with its legend.
 */
export function PayoffChart({
  points,
  maxLoss,
  spot,
  strikes,
  asset,
  quantity,
  loading = false,
  height = 340,
}: PayoffChartProps) {
  const keyHatchId = `payoff-key-hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const hasData = points.length > 1;
  const lowestStrike = strikes.length > 0 ? strikes[0] : null;
  const minPrice = hasData ? points[0].price : null;
  const floorValue = -Math.abs(maxLoss);
  const yScale = buildDollarScale(points, floorValue);

  return (
    <figure className="flex flex-col gap-3">
      <figcaption className="flex flex-col gap-1">
        <span className="stretch-semiwide text-[15px] font-semibold">Profit and loss at expiry</span>
        <span className="text-sm leading-relaxed text-graphite">
          {quantity === null
            ? `How the value of your ${asset} holding changes from today`
            : `How the value of ${quantity} ${asset} changes from today`}
          {spot !== null ? ` (${formatUsd(spot)})` : ""}, by the price {asset} settles at when the
          ladder expires.
        </span>
      </figcaption>

      <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-graphite" aria-label="Chart key">
        <li className="flex items-center gap-2">
          <svg width="22" height="8" aria-hidden="true">
            <line x1="0" y1="4" x2="22" y2="4" stroke={CHART_COLORS.graphite} strokeWidth="1.5" strokeDasharray="4 3" />
          </svg>
          Without hedge
        </li>
        <li className="flex items-center gap-2 font-medium text-ink">
          <svg width="22" height="8" aria-hidden="true">
            <line x1="0" y1="4" x2="22" y2="4" stroke={CHART_COLORS.cobalt} strokeWidth="3" />
          </svg>
          With hedge
        </li>
        <li className="flex items-center gap-2">
          <svg width="22" height="8" aria-hidden="true">
            <line x1="0" y1="4" x2="22" y2="4" stroke={CHART_COLORS.ink} strokeWidth="1.25" strokeDasharray="1.5 2.5" />
          </svg>
          Your floor, {formatUsd(floorValue)}
        </li>
        {lowestStrike !== null ? (
          <li className="flex items-center gap-2">
            <svg width="14" height="12" aria-hidden="true">
              <defs>
                <pattern id={keyHatchId} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <line x1="0" y1="2" x2="4" y2="2" stroke={CHART_COLORS.ink} strokeOpacity="0.45" strokeWidth="1" />
                </pattern>
              </defs>
              <rect width="14" height="12" fill={CHART_COLORS.hatchBase} />
              <rect width="14" height="12" fill={`url(#${keyHatchId})`} />
            </svg>
            Not protected below {formatStrike(lowestStrike)}
          </li>
        ) : null}
      </ul>

      <div style={{ height }} className="w-full">
        {hasData ? (
          <ComposedChart
            data={points}
            responsive
            style={{ width: "100%", height: "100%" }}
            margin={{ top: 26, right: 12, bottom: 4, left: 4 }}
            accessibilityLayer
          >
            <CartesianGrid stroke={CHART_COLORS.rule} strokeDasharray="0" vertical={false} />
            {lowestStrike !== null && minPrice !== null && minPrice < lowestStrike ? (
              <ReferenceArea
                x1={minPrice}
                x2={lowestStrike}
                fill={UNPROTECTED_FILL}
                fillOpacity={1}
                ifOverflow="hidden"
                label={{
                  value: "Unprotected",
                  position: "insideTopLeft",
                  offset: 8,
                  fill: CHART_COLORS.ink,
                  fontSize: 11,
                  fontWeight: 600,
                }}
              />
            ) : null}
            <XAxis
              dataKey="price"
              type="number"
              domain={["dataMin", "dataMax"]}
              ticks={strikes}
              tickFormatter={formatPriceTick}
              interval="preserveStartEnd"
              minTickGap={6}
              tick={{ fill: CHART_COLORS.graphite, fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: CHART_COLORS.rule }}
              allowDecimals
            />
            <YAxis
              domain={yScale.domain}
              ticks={yScale.ticks}
              interval={0}
              tickFormatter={formatDollarTick}
              tick={{ fill: CHART_COLORS.graphite, fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              width={52}
            />
            <ReferenceLine y={0} stroke={CHART_COLORS.graphite} strokeOpacity={0.6} />
            <ReferenceLine
              y={floorValue}
              stroke={CHART_COLORS.ink}
              strokeWidth={1.25}
              strokeDasharray="1.5 3"
              ifOverflow="extendDomain"
              label={{
                value: `Floor ${formatUsd(floorValue)}`,
                position: "insideBottomRight",
                offset: 6,
                fill: CHART_COLORS.ink,
                fontSize: 11,
              }}
            />
            {spot !== null ? (
              <ReferenceLine
                x={spot}
                stroke={CHART_COLORS.ink}
                strokeOpacity={0.55}
                ifOverflow="extendDomain"
                label={{
                  value: `Spot ${formatUsd(spot)}`,
                  position: "top",
                  offset: 8,
                  fill: CHART_COLORS.ink,
                  fontSize: 11,
                  fontWeight: 600,
                }}
              />
            ) : null}
            <Line
              dataKey="unhedged"
              name="Without hedge"
              type="linear"
              stroke={CHART_COLORS.graphite}
              strokeWidth={1.5}
              strokeDasharray="5 4"
              dot={false}
              activeDot={{ r: 3, fill: CHART_COLORS.graphite, strokeWidth: 0 }}
              isAnimationActive={false}
            />
            <Line
              dataKey="hedged"
              name="With hedge"
              type="linear"
              stroke={CHART_COLORS.cobalt}
              strokeWidth={2.75}
              strokeLinejoin="round"
              dot={false}
              activeDot={{ r: 4, fill: CHART_COLORS.cobalt, stroke: "#ffffff", strokeWidth: 2 }}
              isAnimationActive={false}
            />
            <Tooltip
              content={PayoffTooltip}
              cursor={{ stroke: CHART_COLORS.graphite, strokeOpacity: 0.4 }}
              isAnimationActive={false}
            />
          </ComposedChart>
        ) : (
          <div className="flex h-full items-center justify-center rounded-[5px] border border-dashed border-rule bg-fog/40 px-6 text-center text-sm text-graphite">
            {loading ? (
              <span className="animate-pulse">Computing the payoff for this ladder</span>
            ) : (
              <span>
                No payoff to draw yet. Choose a ladder with quotes and enter the quantity you hold.
              </span>
            )}
          </div>
        )}
      </div>
    </figure>
  );
}
