"use client";

import { useId, useState } from "react";
import {
  DEFAULT_MAX_OUTLAY_FRACTION,
  MAX_MAX_OUTLAY_FRACTION,
  MIN_MAX_OUTLAY_FRACTION,
} from "@/lib/client/workbench-model";
import { formatPercent, formatQuantity, formatUsd } from "./format";

/** Contracts restored when the "unlimited" toggle is switched off with no earlier value. */
const DEFAULT_ASSUMED_DEPTH = 100;

/** Step of the cash-limit slider, as a fraction of position value (0.5%). */
const OUTLAY_STEP_FRACTION = 0.005;

/** Props for {@link NumberField}. */
export interface NumberFieldProps {
  /** Id for the input, so a label can point at it. */
  id: string;
  /** Current value in model units, or null when the field is blank. */
  value: number | null;
  /** Called with a valid value in model units whenever the text parses and is in range. */
  onCommit: (value: number) => void;
  /** Optional: called whenever the text becomes blank, unparseable or out of range. */
  onInvalid?: () => void;
  /** Smallest accepted value in display units. Defaults to 0. */
  min?: number;
  /** Largest accepted value in display units. Defaults to unbounded. */
  max?: number;
  /** Multiplier from model units to display units, for example 100 for a percentage. Defaults to 1. */
  scale?: number;
  /** Short unit text shown inside the field on the right, for example "%" or "SOL". */
  suffix?: string;
  /** Disables the input. */
  disabled?: boolean;
  /** Id of an element that describes the field. */
  describedBy?: string;
}

/**
 * Rounds a display number to at most six decimals and prints it without trailing zeros.
 *
 * @param {number} value - The number to print.
 * @returns {string} The printed number.
 */
function printDraftNumber(value: number): string {
  return String(Number(value.toFixed(6)));
}

/**
 * Parses the text in a number field.
 *
 * @param {string} text - Raw input text.
 * @returns {number | null} The parsed number, or null when the text is blank or not a number.
 */
function parseDraftNumber(text: string): number | null {
  const trimmed = text.trim().replace(/,/g, "");
  if (trimmed === "") {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A text-based numeric input that keeps the user's draft while they type and
 * only reports values that parse and fall within range. When the value changes
 * from outside, the draft follows it.
 *
 * @param {NumberFieldProps} props - Component props.
 * @returns {JSX.Element} The input.
 */
export function NumberField({
  id,
  value,
  onCommit,
  onInvalid,
  min = 0,
  max = Number.POSITIVE_INFINITY,
  scale = 1,
  suffix,
  disabled = false,
  describedBy,
}: NumberFieldProps) {
  const displayed = value === null ? "" : printDraftNumber(value * scale);
  const [draft, setDraft] = useState<string>(displayed);
  const [lastValue, setLastValue] = useState<number | null>(value);

  if (value !== lastValue) {
    setLastValue(value);
    const draftNumber = parseDraftNumber(draft);
    const draftMatches =
      draftNumber !== null && value !== null && Math.abs(draftNumber / scale - value) < 1e-9;
    if (!draftMatches) {
      setDraft(displayed);
    }
  }

  const parsed = parseDraftNumber(draft);
  const isInvalid = parsed === null || parsed < min || parsed > max;

  /**
   * Stores the new draft and reports it when valid, or reports that it is not.
   *
   * @param {string} text - The new input text.
   * @returns {void}
   */
  function handleChange(text: string): void {
    setDraft(text);
    const next = parseDraftNumber(text);
    if (next !== null && next >= min && next <= max) {
      onCommit(next / scale);
    } else if (onInvalid !== undefined) {
      onInvalid();
    }
  }

  return (
    <div
      className={`flex h-10 items-center rounded-[5px] border bg-paper focus-within:border-cobalt ${
        isInvalid && !disabled ? "border-alarm" : "border-rule"
      } ${disabled ? "opacity-50" : ""}`}
    >
      <input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        value={draft}
        disabled={disabled}
        aria-invalid={isInvalid && !disabled}
        aria-describedby={describedBy}
        onChange={(event) => handleChange(event.target.value)}
        className="figures h-full w-full min-w-0 bg-transparent px-3 text-base text-ink outline-none disabled:cursor-not-allowed"
      />
      {suffix !== undefined ? (
        <span className="pr-3 text-sm text-graphite" aria-hidden="true">
          {suffix}
        </span>
      ) : null}
    </div>
  );
}

/** Props for {@link FloorControls}. */
export interface FloorControlsProps {
  /** Position value in dollars (quantity times spot). */
  positionValue: number;
  /** Largest acceptable loss as a fraction of position value, for example 0.015. */
  maxLossFraction: number;
  /** Called with a new fraction when the slider moves. */
  onMaxLossFractionChange: (fraction: number) => void;
  /** Cash limit: the most the plan may pay up front, as a fraction of position value; null means no limit. */
  maxOutlayFraction: number | null;
  /** Called with a new cash-limit fraction, or null for no limit. */
  onMaxOutlayFractionChange: (fraction: number | null) => void;
  /** Gemini taker fee rate as a fraction, for example 0.07. */
  takerFeeRate: number;
  /** Called with a new fee rate as a fraction. */
  onTakerFeeRateChange: (rate: number) => void;
  /** Contracts assumed available per leg when sizes are unknown; null means unlimited. */
  assumedDepth: number | null;
  /** Called with a new assumed depth, or null for unlimited. */
  onAssumedDepthChange: (depth: number | null) => void;
  /** True when the ladder does not publish order sizes, so depth is an assumption. */
  sizesUnknown: boolean;
  /** Smallest slider fraction. Defaults to 0.0025 (0.25%). */
  minFraction?: number;
  /** Largest slider fraction. Defaults to 0.10 (10%). */
  maxFraction?: number;
  /** Slider step as a fraction. Defaults to 0.0005 (0.05%). */
  stepFraction?: number;
}

/**
 * Inputs that define the hedge request: the loss floor, the cash limit (the most
 * the plan may pay up front, or no limit), the taker fee rate and the depth
 * assumed for each contract.
 *
 * @param {FloorControlsProps} props - Component props.
 * @returns {JSX.Element} The controls.
 */
export function FloorControls({
  positionValue,
  maxLossFraction,
  onMaxLossFractionChange,
  maxOutlayFraction,
  onMaxOutlayFractionChange,
  takerFeeRate,
  onTakerFeeRateChange,
  assumedDepth,
  onAssumedDepthChange,
  sizesUnknown,
  minFraction = 0.0025,
  maxFraction = 0.1,
  stepFraction = 0.0005,
}: FloorControlsProps) {
  const baseId = useId();
  const sliderId = `${baseId}-floor`;
  const feeId = `${baseId}-fee`;
  const feeHelpId = `${baseId}-fee-help`;
  const depthId = `${baseId}-depth`;
  const depthHelpId = `${baseId}-depth-help`;
  const outlayId = `${baseId}-outlay`;
  const outlayHelpId = `${baseId}-outlay-help`;
  const [lastDepth, setLastDepth] = useState<number>(assumedDepth ?? DEFAULT_ASSUMED_DEPTH);
  const [lastOutlayFraction, setLastOutlayFraction] = useState<number>(
    maxOutlayFraction ?? DEFAULT_MAX_OUTLAY_FRACTION,
  );
  const noOutlayLimit = maxOutlayFraction === null;
  const outlayFractionShown = maxOutlayFraction ?? lastOutlayFraction;
  const maxOutlayAmount = outlayFractionShown * positionValue;

  const isUnlimited = assumedDepth === null;
  const maxLossDollars = maxLossFraction * positionValue;
  const hasPosition = Number.isFinite(positionValue) && positionValue > 0;

  /**
   * Switches between an unlimited depth and the last finite depth.
   *
   * @param {boolean} unlimited - True to make depth unlimited.
   * @returns {void}
   */
  function handleUnlimitedChange(unlimited: boolean): void {
    if (unlimited) {
      if (assumedDepth !== null) {
        setLastDepth(assumedDepth);
      }
      onAssumedDepthChange(null);
      return;
    }
    onAssumedDepthChange(lastDepth);
  }

  /**
   * Switches between no cash limit and the last limit used.
   *
   * @param {boolean} unlimited - True to remove the limit.
   * @returns {void}
   */
  function handleNoOutlayLimitChange(unlimited: boolean): void {
    if (unlimited) {
      if (maxOutlayFraction !== null) {
        setLastOutlayFraction(maxOutlayFraction);
      }
      onMaxOutlayFractionChange(null);
      return;
    }
    onMaxOutlayFractionChange(lastOutlayFraction);
  }

  /**
   * Reports a new cash-limit fraction from the slider and remembers it for the "No limit" toggle.
   *
   * @param {number} fraction - Share of position value.
   * @returns {void}
   */
  function handleOutlayFractionChange(fraction: number): void {
    setLastOutlayFraction(fraction);
    onMaxOutlayFractionChange(fraction);
  }

  /**
   * Reports a new finite depth and remembers it for the unlimited toggle.
   *
   * @param {number} depth - Contracts per leg.
   * @returns {void}
   */
  function handleDepthCommit(depth: number): void {
    setLastDepth(depth);
    onAssumedDepthChange(depth);
  }

  return (
    <section aria-labelledby={`${baseId}-heading`} className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <h2 id={`${baseId}-heading`} className="stretch-semiwide text-[15px] font-semibold">
          Loss floor
        </h2>
        <label htmlFor={sliderId} className="text-sm text-graphite">
          The most you are willing to lose at expiry
        </label>
        <div className="flex items-baseline justify-between gap-3">
          <span className="figures stretch-wide text-3xl font-semibold tracking-tight">
            {hasPosition ? formatUsd(-maxLossDollars) : "–"}
          </span>
          <span className="figures text-sm text-graphite">
            {formatPercent(maxLossFraction)} of position
          </span>
        </div>
        <input
          id={sliderId}
          type="range"
          min={minFraction}
          max={maxFraction}
          step={stepFraction}
          value={maxLossFraction}
          aria-valuetext={`${formatPercent(maxLossFraction)} of position, ${formatUsd(maxLossDollars)}`}
          onChange={(event) => onMaxLossFractionChange(Number(event.target.value))}
          className="h-6 w-full cursor-pointer"
        />
        <div className="figures flex justify-between text-xs text-graphite" aria-hidden="true">
          <span>{formatPercent(minFraction)}</span>
          <span>{formatPercent(maxFraction, 0)}</span>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="stretch-semiwide text-[15px] font-semibold">Cash limit</h2>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={noOutlayLimit}
              onChange={(event) => handleNoOutlayLimitChange(event.target.checked)}
              className="h-4 w-4"
            />
            No limit
          </label>
        </div>
        <label htmlFor={outlayId} className="text-sm text-graphite">
          The most you will pay up front, fees included
        </label>
        <div className="flex items-baseline justify-between gap-3">
          <span className={`figures stretch-wide text-2xl font-semibold tracking-tight ${noOutlayLimit ? "text-graphite" : ""}`}>
            {noOutlayLimit ? "No limit" : hasPosition ? formatUsd(maxOutlayAmount) : "–"}
          </span>
          <span className="figures text-sm text-graphite">
            {noOutlayLimit ? "any amount" : `${formatPercent(outlayFractionShown, 1)} of position`}
          </span>
        </div>
        <input
          id={outlayId}
          type="range"
          min={MIN_MAX_OUTLAY_FRACTION}
          max={MAX_MAX_OUTLAY_FRACTION}
          step={OUTLAY_STEP_FRACTION}
          value={outlayFractionShown}
          disabled={noOutlayLimit}
          aria-describedby={outlayHelpId}
          aria-valuetext={
            noOutlayLimit
              ? "No limit"
              : `${formatPercent(outlayFractionShown, 1)} of position, ${formatUsd(maxOutlayAmount)}`
          }
          onChange={(event) => handleOutlayFractionChange(Number(event.target.value))}
          className="h-6 w-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
        />
        <div className="figures flex justify-between text-xs text-graphite" aria-hidden="true">
          <span>{formatPercent(MIN_MAX_OUTLAY_FRACTION, 0)}</span>
          <span>{formatPercent(MAX_MAX_OUTLAY_FRACTION, 0)}</span>
        </div>
        <p id={outlayHelpId} className="text-xs leading-relaxed text-graphite">
          {noOutlayLimit
            ? "The plan may ask for any amount up front to reach the floor."
            : "The plan never pays more than this. If the floor needs more, the page says so, shows how close a basket within the limit gets, and says how much the floor would take."}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={feeId} className="text-sm font-medium">
          Taker fee rate
        </label>
        <div className="w-32">
          <NumberField
            id={feeId}
            value={takerFeeRate}
            onCommit={onTakerFeeRateChange}
            min={0}
            max={100}
            scale={100}
            suffix="%"
            describedBy={feeHelpId}
          />
        </div>
        <p id={feeHelpId} className="text-xs leading-relaxed text-graphite">
          Gemini taker fee: rate x contracts x price x (1 - price)
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <label htmlFor={depthId} className="text-sm font-medium">
            Contracts available per leg
          </label>
          {sizesUnknown ? (
            <span className="rounded-[3px] border border-dashed border-graphite/60 bg-fog-deep px-1.5 py-px text-xs font-medium">
              assumed
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-4">
          <div className="w-32">
            <NumberField
              id={depthId}
              value={assumedDepth}
              onCommit={handleDepthCommit}
              min={0.01}
              suffix="ct"
              disabled={isUnlimited}
              describedBy={depthHelpId}
            />
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isUnlimited}
              onChange={(event) => handleUnlimitedChange(event.target.checked)}
              className="h-4 w-4"
            />
            Unlimited
          </label>
        </div>
        <p id={depthHelpId} className="text-xs leading-relaxed text-graphite">
          {sizesUnknown
            ? isUnlimited
              ? "Order sizes are not published for these quotes. With unlimited depth, any quantity is assumed fillable at the quoted price."
              : `Order sizes are not published for these quotes, so each contract is capped at an assumed ${formatQuantity(assumedDepth ?? 0)} contracts.`
            : "Applies only to quotes whose size is unknown."}
        </p>
      </div>
    </section>
  );
}
