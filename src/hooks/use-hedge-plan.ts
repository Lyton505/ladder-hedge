import { useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  buildPriceStates,
  checkCoherence,
  maxHedgeableQuantity,
  optimizeHedge,
  payoffCurve,
} from "@/lib/hedge";
import type {
  CoherenceFinding,
  Exposure,
  HedgePlan,
  HedgeRequest,
  Ladder,
  PayoffPoint,
  PriceState,
} from "@/lib/hedge/types";

/** Points requested from `payoffCurve`; strike points are added on top. */
export const PAYOFF_POINT_COUNT = 160;

/** Quiet time after the last input change before the largest hedgeable quantity is computed. */
export const MAX_HEDGEABLE_DEBOUNCE_MS = 350;

/** Inputs to the hedge computation. */
export interface HedgePlanInputs {
  ladder: Ladder;
  exposure: Exposure;
  /** Largest acceptable loss as a fraction of position value. */
  maxLossFraction: number;
  takerFeeRate: number;
  /** Contracts assumed per leg where the size is unknown; null means unlimited. */
  assumedDepth: number | null;
}

/** State of the largest-hedgeable-quantity computation. */
export type MaxHedgeableStatus = "idle" | "computing" | "ready" | "error";

/** Value returned by {@link useHedgePlan}. */
export interface HedgePlanState {
  plan: HedgePlan | null;
  /** The request `plan` was computed from (it can lag the latest inputs while `stale`). */
  planRequest: HedgeRequest | null;
  /** Price states with implied probabilities, for the distribution chart. */
  states: PriceState[];
  payoff: PayoffPoint[];
  coherence: CoherenceFinding[];
  /** Readable message when the engine rejected the inputs. */
  error: string | null;
  /** True while the plan shown lags behind the latest inputs (for example during a slider drag). */
  stale: boolean;
  /** Largest quantity hedgeable to the same floor fraction, or null when depth is unlimited somewhere or not yet known. */
  maxHedgeable: number | null;
  maxHedgeableStatus: MaxHedgeableStatus;
}

/** Engine outputs for one request. */
interface Computed {
  plan: HedgePlan | null;
  states: PriceState[];
  payoff: PayoffPoint[];
  error: string | null;
}

/** Stored result of one largest-hedgeable computation, tagged with its request. */
interface MaxHedgeableResult {
  request: HedgeRequest;
  fraction: number;
  value: number | null;
  error: string | null;
}

/** Shared empty lists, so consumers see stable references. */
const NO_STATES: PriceState[] = [];
const NO_POINTS: PayoffPoint[] = [];
const NO_FINDINGS: CoherenceFinding[] = [];

/**
 * Formats an engine error for display.
 *
 * @param {unknown} error - The thrown value.
 * @returns {string} A readable message.
 */
function describeEngineError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `The optimiser could not price this ladder: ${detail}`;
}

/**
 * Runs the optimiser and derives the payoff curve and price states.
 *
 * @param {HedgeRequest} request - The request.
 * @returns {Computed} The plan and derived data, or an error message.
 */
function compute(request: HedgeRequest): Computed {
  try {
    const plan = optimizeHedge(request);
    const payoff = payoffCurve(plan, request.exposure, request.ladder, PAYOFF_POINT_COUNT);
    const states = plan.outcomes.length > 0 ? plan.outcomes : buildPriceStates(request.ladder, plan.stressPrice);
    return { plan, states, payoff, error: null };
  } catch (error) {
    console.error(`[use-hedge-plan] ${error instanceof Error ? error.message : String(error)}`);
    return { plan: null, states: NO_STATES, payoff: NO_POINTS, error: describeEngineError(error) };
  }
}

/**
 * Computes the hedge plan, payoff curve, price states and quote-consistency findings
 * for the current inputs, and the largest quantity the quotes can hedge to the same floor.
 *
 * The plan follows a deferred copy of the inputs so a slider drag stays responsive. The
 * largest hedgeable quantity runs about 50 optimiser solves, so it is computed only after
 * the inputs have been still for {@link MAX_HEDGEABLE_DEBOUNCE_MS}.
 *
 * @param {HedgePlanInputs | null} inputs - The inputs, or null while the ladder or spot is missing.
 * @returns {HedgePlanState} The plan and derived data. Engine errors are caught into `error`.
 */
export function useHedgePlan(inputs: HedgePlanInputs | null): HedgePlanState {
  const ladder = inputs?.ladder ?? null;
  const asset = inputs?.exposure.asset ?? null;
  const quantity = inputs?.exposure.quantity ?? null;
  const spot = inputs?.exposure.spot ?? null;
  const fraction = inputs?.maxLossFraction ?? null;
  const takerFeeRate = inputs?.takerFeeRate ?? null;
  const assumedDepth = inputs?.assumedDepth ?? null;

  const request = useMemo<HedgeRequest | null>(() => {
    if (ladder === null || asset === null || quantity === null || spot === null || fraction === null || takerFeeRate === null) {
      return null;
    }
    return {
      ladder,
      exposure: { asset, quantity, spot },
      maxLoss: fraction * quantity * spot,
      stressPrice: null,
      takerFeeRate,
      assumedDepth,
    };
  }, [ladder, asset, quantity, spot, fraction, takerFeeRate, assumedDepth]);

  const deferredRequest = useDeferredValue(request);
  const deferredFraction = useDeferredValue(fraction);

  const computed = useMemo<Computed | null>(
    () => (deferredRequest === null ? null : compute(deferredRequest)),
    [deferredRequest],
  );

  const coherence = useMemo<CoherenceFinding[]>(() => {
    if (ladder === null) {
      return NO_FINDINGS;
    }
    try {
      return checkCoherence(ladder);
    } catch (error) {
      console.error(`[use-hedge-plan] coherence check failed: ${error instanceof Error ? error.message : String(error)}`);
      return NO_FINDINGS;
    }
  }, [ladder]);

  const [maxResult, setMaxResult] = useState<MaxHedgeableResult | null>(null);

  useEffect(() => {
    if (deferredRequest === null || deferredFraction === null) {
      return;
    }
    const timer = setTimeout(() => {
      try {
        const value = maxHedgeableQuantity(deferredRequest, deferredFraction);
        setMaxResult({ request: deferredRequest, fraction: deferredFraction, value, error: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[use-hedge-plan] largest hedgeable quantity failed: ${message}`);
        setMaxResult({ request: deferredRequest, fraction: deferredFraction, value: null, error: message });
      }
    }, MAX_HEDGEABLE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [deferredRequest, deferredFraction]);

  const maxCurrent =
    maxResult !== null && maxResult.request === deferredRequest && maxResult.fraction === deferredFraction
      ? maxResult
      : null;
  let maxHedgeableStatus: MaxHedgeableStatus = "idle";
  if (request !== null) {
    if (maxCurrent === null) {
      maxHedgeableStatus = "computing";
    } else {
      maxHedgeableStatus = maxCurrent.error === null ? "ready" : "error";
    }
  }

  return {
    plan: computed?.plan ?? null,
    planRequest: computed !== null && computed.plan !== null ? deferredRequest : null,
    states: computed?.states ?? NO_STATES,
    payoff: computed?.payoff ?? NO_POINTS,
    coherence,
    error: computed?.error ?? null,
    stale: request !== deferredRequest,
    maxHedgeable: maxCurrent?.value ?? null,
    maxHedgeableStatus,
  };
}
