import { solve, type Constraint, type Model } from "yalps";
import { buildPriceStates, legPaysAtPrice } from "@/lib/hedge/price-states";
import type {
  Exposure,
  HedgeLeg,
  HedgePlan,
  HedgeRequest,
  HedgeStatus,
  LadderRung,
  LegSide,
  PriceState,
  StateOutcome,
} from "@/lib/hedge/types";

/** Gemini's published prediction-market taker rate (https://www.gemini.com/fees/predictions). */
export const GEMINI_TAKER_FEE_RATE = 0.07;

/**
 * Largest number of dollars by which a rounded plan's worst case may sit below
 * the floor and still be labelled `optimal`. This only absorbs floating-point
 * noise: real rounding shortfalls (quantity and fee rounding) are repaired,
 * not tolerated. See `floorTolerance` for the exact per-request value.
 */
export const FLOOR_TOLERANCE = 1e-6;

/** Floor tolerance per dollar of position value plus loss limit, so tiny positions get a tiny tolerance. */
const FLOOR_TOLERANCE_RELATIVE = 1e-10;

/** Tolerance for comparisons of dollar amounts that should be equal. */
const EPSILON = 1e-9;

/** How many times stage 1 is re-solved with a tighter floor to absorb rounding. */
const MAX_REPAIR_ATTEMPTS = 12;

/** Extra margin, in dollars, added to the floor on the first repair attempt; doubles on each later one. */
const REPAIR_MIN_STEP = 0.005;

/** Most a cent-rounded fee can exceed the linear fee the solver assumed, in dollars. */
const FEE_ROUNDING_SLACK = 0.01;

/** Slack, in increments, so a quantity that is already a whole number of increments is not bumped. */
const INCREMENT_SLACK = 1e-6;

/** Digits kept when cleaning floating-point noise from derived prices and rounded quantities. */
const CLEAN_DIGITS = 10;

/** Largest position `maxHedgeableQuantity` will search to. */
const MAX_SEARCH_QUANTITY = 1e9;

/** Bisection steps used by `maxHedgeableQuantity`. */
const BISECTION_ITERATIONS = 40;

/** A leg the optimiser may buy, with everything the linear programs need. */
interface CandidateLeg {
  rung: LadderRung;
  side: LegSide;
  /** Ask price per contract in dollars, before fees. */
  price: number;
  /** price plus the linear taker fee per contract; what one contract costs inside the LPs. */
  unitCost: number;
  /** Largest whole number of increments within the cap, or null when unlimited. */
  cap: number | null;
  /** pays[j] is true when the leg pays $1 at state j's evaluation price. */
  pays: boolean[];
}

/**
 * Removes floating-point noise from a number by rounding to a fixed number of decimals.
 *
 * @param {number} value - Number to clean.
 * @returns {number} The value rounded to CLEAN_DIGITS decimals.
 */
function clean(value: number): number {
  return Number(value.toFixed(CLEAN_DIGITS));
}

/**
 * Throws when a request has values the engine cannot reason about.
 *
 * @param {HedgeRequest} request - The request to validate.
 * @returns {void}
 * @throws {RangeError} If maxLoss, fee rate, exposure, depth or an increment is out of range.
 */
function validateRequest(request: HedgeRequest): void {
  const { exposure, maxLoss, takerFeeRate, assumedDepth } = request;
  if (!Number.isFinite(maxLoss) || maxLoss < 0) {
    throw new RangeError(`maxLoss must be a finite non-negative number, got ${maxLoss}`);
  }
  if (!Number.isFinite(takerFeeRate) || takerFeeRate < 0 || takerFeeRate >= 1) {
    throw new RangeError(`takerFeeRate must be in [0, 1), got ${takerFeeRate}`);
  }
  if (!Number.isFinite(exposure.quantity) || exposure.quantity < 0) {
    throw new RangeError(`Exposure quantity must be a finite non-negative number (long holdings only), got ${exposure.quantity}`);
  }
  if (!Number.isFinite(exposure.spot) || exposure.spot < 0) {
    throw new RangeError(`Exposure spot must be a finite non-negative number, got ${exposure.spot}`);
  }
  if (assumedDepth !== null && (!Number.isFinite(assumedDepth) || assumedDepth < 0)) {
    throw new RangeError(`assumedDepth must be null or a finite non-negative number, got ${assumedDepth}`);
  }
  request.ladder.rungs.forEach((rung) => {
    if (!Number.isFinite(rung.quantityIncrement) || rung.quantityIncrement <= 0) {
      throw new RangeError(`Rung ${rung.instrumentSymbol} has an invalid quantityIncrement ${rung.quantityIncrement}`);
    }
  });
}

/**
 * Returns the floating-point tolerance used when comparing hedged P&L with the
 * floor: proportional to the request's dollar scale and never above
 * FLOOR_TOLERANCE. Scaling matters for tiny positions, where an absolute
 * tolerance would let a plan with no legs pass as meeting the floor.
 *
 * @param {HedgeRequest} request - The validated request.
 * @returns {number} Tolerance in dollars.
 */
function floorTolerance(request: HedgeRequest): number {
  const scale = request.exposure.quantity * request.exposure.spot + request.maxLoss;
  return Math.min(FLOOR_TOLERANCE, FLOOR_TOLERANCE_RELATIVE * scale);
}

/**
 * Computes the long holder's profit and loss at an expiry price.
 *
 * @param {Exposure} exposure - The holding.
 * @param {number} price - Expiry price in dollars.
 * @returns {number} quantity * (price - spot). Not cleaned, so tiny positions keep their sign.
 */
function unhedgedPnlAt(exposure: Exposure, price: number): number {
  return exposure.quantity * (price - exposure.spot);
}

/**
 * Computes Gemini's taker fee for a fill, rounded up to the next cent.
 *
 * @param {number} rate - Taker fee rate.
 * @param {number} quantity - Contracts bought.
 * @param {number} price - Price per contract in dollars.
 * @returns {number} The fee in dollars; 0 when the rate is 0.
 */
function takerFee(rate: number, quantity: number, price: number): number {
  if (rate === 0) {
    return 0;
  }
  const rawCents = rate * quantity * price * (1 - price) * 100;
  return Math.max(0, Math.ceil(rawCents - EPSILON)) / 100;
}

/**
 * Resolves a leg's cap: the size quoted on the side being lifted, else the
 * assumed depth, else unlimited. The cap is then rounded down to a whole number
 * of increments so that rounding a solver quantity up can never exceed it.
 *
 * @param {LadderRung} rung - The leg's rung.
 * @param {LegSide} side - YES lifts the YES ask; NO lifts the YES bid.
 * @param {number | null} assumedDepth - Contracts assumed available when the size is unknown.
 * @returns {number | null} The usable cap in contracts, or null when unlimited.
 */
function legCap(rung: LadderRung, side: LegSide, assumedDepth: number | null): number | null {
  const quotedSize = side === "yes" ? rung.yesAskSize : rung.yesBidSize;
  const rawCap = quotedSize ?? assumedDepth;
  if (rawCap === null) {
    return null;
  }
  const wholeSteps = Math.floor(Math.max(0, rawCap) / rung.quantityIncrement + INCREMENT_SLACK);
  return clean(wholeSteps * rung.quantityIncrement);
}

/**
 * Lists the legs the optimiser may use: YES at the ask and NO at one minus the
 * bid wherever that quote exists, excluding legs whose unit cost after fees is
 * at least $1 (they can never improve any state) and legs with a zero cap.
 *
 * @param {HedgeRequest} request - The hedge request.
 * @param {PriceState[]} states - The ladder's price states.
 * @returns {CandidateLeg[]} Available legs, ordered by rung then YES before NO.
 */
function candidateLegs(request: HedgeRequest, states: PriceState[]): CandidateLeg[] {
  const candidates: CandidateLeg[] = [];
  request.ladder.rungs.forEach((rung) => {
    const quotes: [LegSide, number | null][] = [
      ["yes", rung.yesAsk],
      ["no", rung.yesBid === null ? null : clean(1 - rung.yesBid)],
    ];
    quotes.forEach(([side, price]) => {
      if (price === null) {
        return;
      }
      const unitCost = price + request.takerFeeRate * price * (1 - price);
      if (unitCost >= 1) {
        return;
      }
      const cap = legCap(rung, side, request.assumedDepth);
      if (cap !== null && cap <= 0) {
        return;
      }
      candidates.push({
        rung,
        side,
        price,
        unitCost,
        cap,
        pays: states.map((state) => legPaysAtPrice(side, rung.strike, state.evalPrice)),
      });
    });
  });
  return candidates;
}

/**
 * Builds the constraint map shared by both linear programs: one constraint per
 * state on the leg-dependent part of hedged P&L, plus one cap per capped leg.
 *
 * Every state constraint carries each leg's full unit cost, so total cost
 * reduces hedged P&L in every state, not only in the objective.
 *
 * @param {CandidateLeg[]} candidates - Available legs.
 * @param {number[]} stateMinimums - Lower bound for state j's leg-dependent P&L.
 * @returns {Map<string, Constraint>} Constraints keyed "state-j" and "cap-l".
 */
function sharedConstraints(candidates: CandidateLeg[], stateMinimums: number[]): Map<string, Constraint> {
  const constraints = new Map<string, Constraint>();
  stateMinimums.forEach((minimum, stateIndex) => {
    constraints.set(`state-${stateIndex}`, { min: minimum });
  });
  candidates.forEach((candidate, legIndex) => {
    if (candidate.cap !== null) {
      constraints.set(`cap-${legIndex}`, { max: candidate.cap });
    }
  });
  return constraints;
}

/**
 * Builds a leg variable's coefficients: in each state it adds (pays - unitCost)
 * per contract, it counts once against its own cap, and it adds unitCost to "cost".
 *
 * @param {CandidateLeg} candidate - The leg.
 * @param {number} legIndex - Its position in the candidate list.
 * @returns {Map<string, number>} Coefficients keyed by constraint name.
 */
function legCoefficients(candidate: CandidateLeg, legIndex: number): Map<string, number> {
  const coefficients = new Map<string, number>();
  candidate.pays.forEach((pays, stateIndex) => {
    coefficients.set(`state-${stateIndex}`, (pays ? 1 : 0) - candidate.unitCost);
  });
  if (candidate.cap !== null) {
    coefficients.set(`cap-${legIndex}`, 1);
  }
  coefficients.set("cost", candidate.unitCost);
  return coefficients;
}

/**
 * Reads leg quantities out of a solver solution, clamping solver noise below zero to zero.
 *
 * @param {[string, number][]} variables - The solution's non-zero variables.
 * @param {number} legCount - Number of candidate legs.
 * @returns {number[]} One non-negative quantity per candidate leg.
 */
function readQuantities(variables: [string, number][], legCount: number): number[] {
  const quantities = new Array<number>(legCount).fill(0);
  variables.forEach(([key, value]) => {
    if (key.startsWith("leg-")) {
      const legIndex = Number(key.slice("leg-".length));
      quantities[legIndex] = Math.max(0, value);
    }
  });
  return quantities;
}

/**
 * Stage 1: the cheapest leg quantities such that, in every state,
 * unhedged_j + sum(quantity_l * pays_lj) - totalCost >= floor.
 *
 * @param {CandidateLeg[]} candidates - Available legs.
 * @param {number[]} unhedged - Unhedged P&L per state.
 * @param {number} floor - Required hedged P&L in every state (negative of the loss limit, plus any repair margin).
 * @returns {number[] | null} Quantities per leg, or null when the floor cannot be met.
 * @throws {Error} If the solver ends in any state other than optimal or infeasible.
 */
function solveMinimumCost(candidates: CandidateLeg[], unhedged: number[], floor: number): number[] | null {
  const variables = new Map<string, Map<string, number>>();
  candidates.forEach((candidate, legIndex) => {
    variables.set(`leg-${legIndex}`, legCoefficients(candidate, legIndex));
  });
  const model: Model = {
    direction: "minimize",
    objective: "cost",
    constraints: sharedConstraints(
      candidates,
      unhedged.map((value) => floor - value),
    ),
    variables,
  };
  const solution = solve(model);
  if (solution.status === "infeasible") {
    return null;
  }
  if (solution.status !== "optimal") {
    throw new Error(`Stage 1 hedge solver ended with status ${solution.status}`);
  }
  return readQuantities(solution.variables, candidates.length);
}

/**
 * Stage 2: leg quantities that maximise the worst hedged P&L across states.
 *
 * The worst case t is written as t = worstCaseBefore + lift with lift >= 0.
 * This keeps every solver variable non-negative (yalps has no free variables)
 * without losing the optimum, because buying nothing already achieves
 * t = worstCaseBefore. The lift is also capped at `maxLift`: there is no
 * value in raising the worst case past the floor (plus the rounding margin),
 * and the cap keeps the program bounded even when uncapped legs form an
 * arbitrage.
 *
 * @param {CandidateLeg[]} candidates - Available legs.
 * @param {number[]} unhedged - Unhedged P&L per state.
 * @param {number} worstCaseBefore - Minimum unhedged P&L across states.
 * @param {number} maxLift - Largest useful improvement of the worst case, in dollars.
 * @returns {{ quantities: number[]; lift: number }} Quantities per leg and the solver's improvement of the worst case.
 * @throws {Error} If the solver ends in any state other than optimal.
 */
function solveMaximumWorstCase(
  candidates: CandidateLeg[],
  unhedged: number[],
  worstCaseBefore: number,
  maxLift: number,
): { quantities: number[]; lift: number } {
  const variables = new Map<string, Map<string, number>>();
  candidates.forEach((candidate, legIndex) => {
    variables.set(`leg-${legIndex}`, legCoefficients(candidate, legIndex));
  });
  const liftCoefficients = new Map<string, number>();
  unhedged.forEach((_value, stateIndex) => {
    liftCoefficients.set(`state-${stateIndex}`, -1);
  });
  liftCoefficients.set("lift", 1);
  variables.set("lift", liftCoefficients);

  const constraints = sharedConstraints(
    candidates,
    unhedged.map((value) => worstCaseBefore - value),
  );
  constraints.set("lift", { max: maxLift });
  const model: Model = { direction: "maximize", objective: "lift", constraints, variables };
  const solution = solve(model);
  if (solution.status !== "optimal") {
    throw new Error(`Stage 2 hedge solver ended with status ${solution.status}`);
  }
  return {
    quantities: readQuantities(solution.variables, candidates.length),
    lift: Math.max(0, solution.result),
  };
}

/**
 * Bounds how much rounding can lower any state's hedged P&L below what the
 * solver planned. Per leg: rounding up adds at most one increment of unit cost
 * plus one cent of fee rounding; dropping a leg below half an increment loses
 * at most half an increment of payout. Both are below increment + 1 cent, so
 * the sum of that over all candidate legs is a safe (loose) bound.
 *
 * @param {CandidateLeg[]} candidates - Available legs.
 * @returns {number} The bound in dollars.
 */
function maxRoundingLoss(candidates: CandidateLeg[]): number {
  return candidates.reduce((total, candidate) => total + candidate.rung.quantityIncrement + FEE_ROUNDING_SLACK, 0);
}

/**
 * Turns solver quantities into tradable legs: drops legs below half an
 * increment, rounds the rest up to a whole number of increments (down instead
 * if up would pass the cap), and prices each with the cent-rounded taker fee.
 *
 * @param {CandidateLeg[]} candidates - Available legs.
 * @param {number[]} quantities - Solver quantity per leg.
 * @param {number} takerFeeRate - Taker fee rate.
 * @returns {HedgeLeg[]} Rounded legs with positive quantities.
 */
function roundLegs(candidates: CandidateLeg[], quantities: number[], takerFeeRate: number): HedgeLeg[] {
  const legs: HedgeLeg[] = [];
  candidates.forEach((candidate, legIndex) => {
    const raw = quantities[legIndex];
    const increment = candidate.rung.quantityIncrement;
    if (raw < increment / 2) {
      return;
    }
    let quantity = clean(Math.ceil(raw / increment - INCREMENT_SLACK) * increment);
    if (candidate.cap !== null && quantity > candidate.cap + EPSILON) {
      quantity = clean(Math.floor(raw / increment + INCREMENT_SLACK) * increment);
      quantity = Math.min(quantity, candidate.cap);
    }
    if (quantity <= 0) {
      return;
    }
    const fee = takerFee(takerFeeRate, quantity, candidate.price);
    legs.push({
      instrumentSymbol: candidate.rung.instrumentSymbol,
      strike: candidate.rung.strike,
      side: candidate.side,
      quantity,
      price: candidate.price,
      fee,
      cost: clean(quantity * candidate.price + fee),
    });
  });
  return legs;
}

/**
 * Assembles a plan, recomputing cost, every outcome, the worst case and the
 * expected payout from the given (already rounded) legs.
 *
 * @param {HedgeStatus} status - Plan status.
 * @param {HedgeLeg[]} legs - Rounded legs.
 * @param {PriceState[]} states - Price states.
 * @param {HedgeRequest} request - The original request.
 * @param {number} worstCaseBefore - Minimum unhedged P&L across states.
 * @returns {HedgePlan} The plan.
 */
function assemblePlan(
  status: HedgeStatus,
  legs: HedgeLeg[],
  states: PriceState[],
  request: HedgeRequest,
  worstCaseBefore: number,
): HedgePlan {
  const totalCost = clean(legs.reduce((total, leg) => total + leg.cost, 0));
  const outcomes: StateOutcome[] = states.map((state) => {
    const unhedgedPnl = unhedgedPnlAt(request.exposure, state.evalPrice);
    const hedgePayout = legs
      .filter((leg) => legPaysAtPrice(leg.side, leg.strike, state.evalPrice))
      .reduce((total, leg) => total + leg.quantity, 0);
    return {
      ...state,
      unhedgedPnl,
      hedgePayout: clean(hedgePayout),
      hedgedPnl: unhedgedPnl + clean(hedgePayout) - totalCost,
    };
  });
  const worstCaseAfter = Math.min(...outcomes.map((outcome) => outcome.hedgedPnl));
  const expectedHedgePayout = clean(
    outcomes.reduce((total, outcome) => total + outcome.probability * outcome.hedgePayout, 0),
  );
  return {
    status,
    legs,
    totalCost,
    outcomes,
    worstCaseBefore,
    worstCaseAfter,
    expectedHedgePayout,
    requestedMaxLoss: request.maxLoss,
    stressPrice: states[0].evalPrice,
  };
}

/**
 * Computes the cheapest basket of ladder contracts that keeps the holder's
 * hedged P&L at or above -maxLoss in every price state.
 *
 * Stage 1 minimises cost subject to the floor. Its quantities are rounded to
 * tradable increments and priced with the real cent-rounded fee; if rounding
 * leaves the worst case below the floor, stage 1 is re-solved with the floor
 * raised by the shortfall (growing geometrically, with a final attempt at a
 * provable rounding bound) until the rounded plan meets it. If the floor
 * cannot be met, stage 2 maximises the worst case instead (`best-effort`); if
 * that rounded plan happens to meet the floor it is labelled `optimal`, and if
 * no leg improves the worst case the plan is `unhedgeable`. A plan labelled
 * `optimal` always meets the floor after rounding, within `floorTolerance`
 * (at most FLOOR_TOLERANCE dollars of floating-point noise). Every number in
 * the returned plan describes the rounded legs.
 *
 * @param {HedgeRequest} request - Ladder, exposure, loss limit, stress price, fee rate and assumed depth.
 * @returns {HedgePlan} The plan.
 * @throws {RangeError} If the request has out-of-range values or the ladder has no rungs.
 * @throws {Error} If the linear programming solver fails unexpectedly.
 */
export function optimizeHedge(request: HedgeRequest): HedgePlan {
  validateRequest(request);
  const states = buildPriceStates(request.ladder, request.stressPrice);
  const unhedged = states.map((state) => unhedgedPnlAt(request.exposure, state.evalPrice));
  const worstCaseBefore = Math.min(...unhedged);
  const floor = -request.maxLoss;
  const tolerance = floorTolerance(request);

  if (worstCaseBefore >= floor - tolerance) {
    return assemblePlan("no-hedge-needed", [], states, request, worstCaseBefore);
  }

  const candidates = candidateLegs(request, states);
  if (candidates.length === 0) {
    return assemblePlan("unhedgeable", [], states, request, worstCaseBefore);
  }

  const roundingBound = maxRoundingLoss(candidates);
  let margin = 0;
  let step = REPAIR_MIN_STEP;
  for (let attempt = 0; attempt < MAX_REPAIR_ATTEMPTS; attempt += 1) {
    if (attempt === MAX_REPAIR_ATTEMPTS - 1) {
      margin = Math.max(margin, roundingBound);
    }
    const quantities = solveMinimumCost(candidates, unhedged, floor + margin);
    if (quantities === null) {
      break;
    }
    const legs = roundLegs(candidates, quantities, request.takerFeeRate);
    const plan = assemblePlan("optimal", legs, states, request, worstCaseBefore);
    const shortfall = floor - plan.worstCaseAfter;
    if (shortfall <= tolerance) {
      return plan;
    }
    margin += Math.max(shortfall, step);
    step *= 2;
  }

  const maxLift = floor + roundingBound - worstCaseBefore;
  const { quantities, lift } = solveMaximumWorstCase(candidates, unhedged, worstCaseBefore, maxLift);
  if (lift <= EPSILON) {
    return assemblePlan("unhedgeable", [], states, request, worstCaseBefore);
  }
  const legs = roundLegs(candidates, quantities, request.takerFeeRate);
  const roundedPlan = assemblePlan("best-effort", legs, states, request, worstCaseBefore);
  if (roundedPlan.worstCaseAfter <= worstCaseBefore + EPSILON) {
    return assemblePlan("unhedgeable", [], states, request, worstCaseBefore);
  }
  if (roundedPlan.worstCaseAfter >= floor - tolerance) {
    return { ...roundedPlan, status: "optimal" };
  }
  return roundedPlan;
}

/**
 * Finds the largest position the ladder's quoted depth can hedge to a loss
 * floor proportional to the position's value.
 *
 * Returns null when any available leg has no cap (the answer would be
 * unbounded). Otherwise doubles from 1 to find an upper bound (at most 1e9),
 * then bisects 40 times for the largest quantity q at which `optimizeHedge`
 * with maxLoss = maxLossFraction * q * spot returns `optimal` or
 * `no-hedge-needed`. Returns 0 if even tiny quantities fail.
 *
 * @param {HedgeRequest} request - The request; its exposure quantity and maxLoss are replaced.
 * @param {number} maxLossFraction - Loss limit as a fraction of position value, for example 0.02.
 * @returns {number | null} The largest hedgeable quantity, or null when depth is unlimited.
 * @throws {RangeError} If maxLossFraction is negative or not finite, or the request is invalid.
 */
export function maxHedgeableQuantity(request: HedgeRequest, maxLossFraction: number): number | null {
  if (!Number.isFinite(maxLossFraction) || maxLossFraction < 0) {
    throw new RangeError(`maxLossFraction must be a finite non-negative number, got ${maxLossFraction}`);
  }
  validateRequest(request);
  const states = buildPriceStates(request.ladder, request.stressPrice);
  const candidates = candidateLegs(request, states);
  if (candidates.some((candidate) => candidate.cap === null)) {
    return null;
  }

  /**
   * Tests whether a position of a given size can be hedged to its proportional floor.
   *
   * @param {number} quantity - Position size in units of the asset.
   * @returns {boolean} True when the plan is optimal or no hedge is needed.
   */
  const canHedge = (quantity: number): boolean => {
    const plan = optimizeHedge({
      ...request,
      exposure: { ...request.exposure, quantity },
      maxLoss: maxLossFraction * quantity * request.exposure.spot,
    });
    return plan.status === "optimal" || plan.status === "no-hedge-needed";
  };

  let low = 0;
  let high = 1;
  while (canHedge(high)) {
    low = high;
    if (high >= MAX_SEARCH_QUANTITY) {
      return MAX_SEARCH_QUANTITY;
    }
    high = Math.min(high * 2, MAX_SEARCH_QUANTITY);
  }
  for (let iteration = 0; iteration < BISECTION_ITERATIONS; iteration += 1) {
    const middle = (low + high) / 2;
    if (canHedge(middle)) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return low;
}
