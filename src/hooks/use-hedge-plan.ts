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
  /**
   * Cash limit: the most the plan may pay up front, as a fraction of position value.
   * Null or omitted means no limit.
   */
  maxOutlayFraction?: number | null;
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
  /** Quote-consistency findings, with arbitrage edges net of the taker fee in the inputs. */
  coherence: CoherenceFinding[];
  /** Readable message when the coherence check rejected the ladder; `coherence` is then empty and means nothing. */
  coherenceError: string | null;
  /** Readable message when the engine rejected the inputs. */
  error: string | null;
  /** True while the plan shown lags behind the latest inputs (for example during a slider drag). */
  stale: boolean;
  /**
   * Largest quantity hedgeable to the same floor fraction (and within the same cash-limit
   * fraction, when one is set); Infinity when no size needs a hedge at this floor; null when
   * depth is unlimited somewhere or not yet known.
   */
  maxHedgeable: number | null;
  maxHedgeableStatus: MaxHedgeableStatus;
  /**
   * The plan the same inputs give with no cash limit. Computed only when a limit is set and
   * the plan is `best-effort` or `unhedgeable`, to tell "the floor is out of reach" from
   * "the floor needs more cash than the limit"; null otherwise, or when it failed.
   */
  unlimitedPlan: HedgePlan | null;
  /** Readable message when the plan without a limit could not be computed. */
  unlimitedPlanError: string | null;
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
  outlayFraction: number | null;
  value: number | null;
  error: string | null;
}

/** Result of the comparison plan computed without a cash limit. */
interface UnlimitedResult {
  plan: HedgePlan | null;
  error: string | null;
}

/** Result of the quote-consistency check. */
interface CoherenceResult {
  findings: CoherenceFinding[];
  error: string | null;
}

/** Shared empty lists, so consumers see stable references. */
const NO_STATES: PriceState[] = [];
const NO_POINTS: PayoffPoint[] = [];
const NO_FINDINGS: CoherenceFinding[] = [];

/** Shared "nothing computed" comparison result. */
const NO_UNLIMITED: UnlimitedResult = { plan: null, error: null };

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
 * Runs the optimiser on a request with its cash limit removed, for the status copy.
 *
 * @param {HedgeRequest} request - The request computed with a limit.
 * @returns {UnlimitedResult} The plan without a limit, or a readable error.
 */
function computeUnlimited(request: HedgeRequest): UnlimitedResult {
  try {
    return { plan: optimizeHedge({ ...request, maxOutlay: null }), error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[use-hedge-plan] plan without a cash limit failed: ${message}`);
    return { plan: null, error: describeEngineError(error) };
  }
}

/**
 * Computes the hedge plan, payoff curve, price states and quote-consistency findings
 * for the current inputs, and the largest quantity the quotes can hedge to the same floor.
 *
 * The plan follows a deferred copy of the inputs so a slider drag stays responsive. The
 * largest hedgeable quantity runs about 50 optimiser solves, so it is computed only after
 * the inputs have been still for {@link MAX_HEDGEABLE_DEBOUNCE_MS}. When a cash limit is
 * set and the plan falls short of the floor, the plan without the limit is also computed
 * once per deferred request (memoised), so the page can say which of the two stands in
 * the way.
 *
 * @param {HedgePlanInputs | null} inputs - The inputs, or null while the ladder or spot is missing. Inputs
 *   with a quantity or spot that is zero, negative or not finite are treated like null.
 * @returns {HedgePlanState} The plan and derived data. Engine errors never escape: plan, payoff
 *   and price-state errors are caught into `error`, coherence errors into `coherenceError`,
 *   largest-hedgeable errors into `maxHedgeableStatus: "error"`, and errors in the plan without
 *   a limit into `unlimitedPlanError`.
 */
export function useHedgePlan(inputs: HedgePlanInputs | null): HedgePlanState {
  const ladder = inputs?.ladder ?? null;
  const asset = inputs?.exposure.asset ?? null;
  const quantity = inputs?.exposure.quantity ?? null;
  const spot = inputs?.exposure.spot ?? null;
  const fraction = inputs?.maxLossFraction ?? null;
  const takerFeeRate = inputs?.takerFeeRate ?? null;
  const assumedDepth = inputs?.assumedDepth ?? null;
  const outlayFraction = inputs?.maxOutlayFraction ?? null;

  const request = useMemo<HedgeRequest | null>(() => {
    if (ladder === null || asset === null || quantity === null || spot === null || fraction === null || takerFeeRate === null) {
      return null;
    }
    // The engine throws on a zero, negative or non-finite size or spot; callers show a prompt instead.
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(spot) || spot <= 0) {
      return null;
    }
    return {
      ladder,
      exposure: { asset, quantity, spot },
      maxLoss: fraction * quantity * spot,
      stressPrice: null,
      takerFeeRate,
      assumedDepth,
      maxOutlay: outlayFraction === null ? null : outlayFraction * quantity * spot,
    };
  }, [ladder, asset, quantity, spot, fraction, takerFeeRate, assumedDepth, outlayFraction]);

  const deferredRequest = useDeferredValue(request);
  const deferredFraction = useDeferredValue(fraction);
  const deferredOutlayFraction = useDeferredValue(outlayFraction);

  const computed = useMemo<Computed | null>(
    () => (deferredRequest === null ? null : compute(deferredRequest)),
    [deferredRequest],
  );

  const limitedStatus = computed?.plan?.status ?? null;
  const unlimitedResult = useMemo<UnlimitedResult>(() => {
    if (deferredRequest === null || deferredRequest.maxOutlay === null || deferredRequest.maxOutlay === undefined) {
      return NO_UNLIMITED;
    }
    if (limitedStatus !== "best-effort" && limitedStatus !== "unhedgeable") {
      return NO_UNLIMITED;
    }
    return computeUnlimited(deferredRequest);
  }, [deferredRequest, limitedStatus]);

  const coherenceResult = useMemo<CoherenceResult>(() => {
    if (ladder === null) {
      return { findings: NO_FINDINGS, error: null };
    }
    try {
      return { findings: checkCoherence(ladder, takerFeeRate ?? undefined), error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[use-hedge-plan] coherence check failed: ${message}`);
      return { findings: NO_FINDINGS, error: `The quotes could not be checked against each other: ${message}` };
    }
  }, [ladder, takerFeeRate]);

  const [maxResult, setMaxResult] = useState<MaxHedgeableResult | null>(null);

  useEffect(() => {
    if (deferredRequest === null || deferredFraction === null) {
      return;
    }
    const timer = setTimeout(() => {
      const tag = { request: deferredRequest, fraction: deferredFraction, outlayFraction: deferredOutlayFraction };
      try {
        const value = maxHedgeableQuantity(deferredRequest, deferredFraction, deferredOutlayFraction ?? undefined);
        setMaxResult({ ...tag, value, error: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[use-hedge-plan] largest hedgeable quantity failed: ${message}`);
        setMaxResult({ ...tag, value: null, error: message });
      }
    }, MAX_HEDGEABLE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [deferredRequest, deferredFraction, deferredOutlayFraction]);

  const maxCurrent =
    maxResult !== null &&
    maxResult.request === deferredRequest &&
    maxResult.fraction === deferredFraction &&
    maxResult.outlayFraction === deferredOutlayFraction
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
    coherence: coherenceResult.findings,
    coherenceError: coherenceResult.error,
    error: computed?.error ?? null,
    stale: request !== deferredRequest,
    maxHedgeable: maxCurrent?.value ?? null,
    maxHedgeableStatus,
    unlimitedPlan: unlimitedResult.plan,
    unlimitedPlanError: unlimitedResult.error,
  };
}
