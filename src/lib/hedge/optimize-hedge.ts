import { solve, type Constraint, type Model } from "yalps";
import { assertValidLadder } from "@/lib/hedge/ladder-validation";
import { buildPriceStates, legPaysAtPrice, resolveStressPrice } from "@/lib/hedge/price-states";
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

/**
 * Largest number of dollars by which a rounded plan's total cost may exceed the
 * cash limit (`maxOutlay`): floating-point noise only. Real overruns from
 * rounding quantities and fees up are repaired by tightening the limit given
 * to the solver, never tolerated.
 */
export const OUTLAY_TOLERANCE = 1e-9;

/** Most a cent-rounded fee can exceed the linear fee the solver assumed, in dollars. */
const FEE_ROUNDING_SLACK = 0.01;

/** Slack, in increments, so a quantity that is already a whole number of increments is not bumped. */
const INCREMENT_SLACK = 1e-6;

/** Digits kept when cleaning floating-point noise from derived prices and rounded quantities. */
const CLEAN_DIGITS = 10;

/**
 * How far below the best achievable worst case a `best-effort` plan may sit,
 * as a fraction of position value (quantity * spot). When the floor cannot be
 * met, the engine buys the cheapest plan within this slack of the best worst
 * case instead of the pure maximin plan, which at tight floors spends dollars
 * on near-certain contracts to gain fractions of a cent.
 */
export const BEST_EFFORT_SLACK_FRACTION = 0.001;

/**
 * Cap on the same slack as a fraction of the achievable improvement (lift =
 * t* minus the unhedged worst case). The slack used is the smaller of the two,
 * so a `best-effort` plan always keeps at least 95% of the achievable
 * improvement, even when that improvement is small next to position value.
 */
export const BEST_EFFORT_LIFT_SLACK_FRACTION = 0.05;

/** Significant digits kept for reported dollar figures, relative to position value. */
const REPORT_SIGNIFICANT_DIGITS = 12;

/** Largest position `maxHedgeableQuantity` will search to. */
const MAX_SEARCH_QUANTITY = 1e9;

/** Smallest power of two `maxHedgeableQuantity` tries (2^-14 is about 0.00006 units). */
const GRID_MIN_EXPONENT = -14;

/** Bisection steps `maxHedgeableQuantity` runs between the best grid size and the next one up. */
const BISECTION_ITERATIONS = 20;

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
 * Snaps a reported dollar figure to a grid of 12 significant digits of the
 * request's dollar scale, so floating-point noise such as -10.000000000000048
 * reads as -10 and -5120000.000000005 reads as -5120000. The grid is a power
 * of ten: 1e-9 for a position worth a few hundred dollars, 1e-4 for one worth
 * about $72 million. Negative zero becomes zero. Used only for reported
 * values, never for decisions.
 *
 * @param {number} value - Dollar amount.
 * @param {number} scale - Positive dollar scale of the request (position value).
 * @returns {number} The snapped amount.
 */
function snapDollars(value: number, scale: number): number {
  const exponent = Math.floor(Math.log10(scale)) - (REPORT_SIGNIFICANT_DIGITS - 1);
  let snapped: number;
  if (exponent < 0) {
    snapped = Number(value.toFixed(Math.min(100, -exponent)));
  } else {
    const quantum = 10 ** exponent;
    snapped = Math.round(value / quantum) * quantum;
  }
  return snapped === 0 ? 0 : snapped;
}

/**
 * Throws when a request has values the engine cannot reason about.
 *
 * @param {HedgeRequest} request - The request to validate.
 * @returns {void}
 * @throws {RangeError} If maxLoss, fee rate, exposure, depth, the cash limit (maxOutlay), an increment, a strike, a quote or a size is out of range.
 */
function validateRequest(request: HedgeRequest): void {
  const { exposure, maxLoss, takerFeeRate, assumedDepth } = request;
  assertValidLadder(request.ladder);
  if (!Number.isFinite(maxLoss) || maxLoss < 0) {
    throw new RangeError(`maxLoss must be a finite non-negative number, got ${maxLoss}`);
  }
  if (!Number.isFinite(takerFeeRate) || takerFeeRate < 0 || takerFeeRate >= 1) {
    throw new RangeError(`takerFeeRate must be in [0, 1), got ${takerFeeRate}`);
  }
  if (!Number.isFinite(exposure.quantity) || exposure.quantity <= 0) {
    throw new RangeError(
      `Exposure quantity must be a finite positive number (a long holding; zero units has nothing to hedge), got ${exposure.quantity}`,
    );
  }
  if (!Number.isFinite(exposure.spot) || exposure.spot <= 0) {
    throw new RangeError(`Exposure spot must be a finite positive price (a zero price has nothing to hedge), got ${exposure.spot}`);
  }
  if (assumedDepth !== null && (!Number.isFinite(assumedDepth) || assumedDepth < 0)) {
    throw new RangeError(`assumedDepth must be null or a finite non-negative number, got ${assumedDepth}`);
  }
  const { maxOutlay } = request;
  if (maxOutlay !== undefined && maxOutlay !== null && (!Number.isFinite(maxOutlay) || maxOutlay < 0)) {
    throw new RangeError(`maxOutlay must be null, omitted or a finite non-negative number of dollars, got ${maxOutlay}`);
  }
  request.ladder.rungs.forEach((rung) => {
    if (!Number.isFinite(rung.quantityIncrement) || rung.quantityIncrement <= 0) {
      throw new RangeError(
        `Ladder rung ${rung.instrumentSymbol} (strike ${rung.strike}): quantityIncrement must be a finite positive number, got ${rung.quantityIncrement}`,
      );
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
 * state on the leg-dependent part of hedged P&L, one cap per capped leg, and,
 * when a cash limit applies, one bound on total linear cost.
 *
 * Every state constraint carries each leg's full unit cost, so total cost
 * reduces hedged P&L in every state, not only in the objective. The cost bound
 * uses the same "cost" coefficients (unit cost, linear fee included) as the
 * stage 1 objective; with no limit it is not added at all, so unlimited models
 * are exactly the ones the engine solved before the cash limit existed.
 *
 * @param {CandidateLeg[]} candidates - Available legs.
 * @param {number[]} stateMinimums - Lower bound for state j's leg-dependent P&L.
 * @param {number | null} maxCost - Largest total linear cost in dollars, or null for no limit.
 * @returns {Map<string, Constraint>} Constraints keyed "state-j", "cap-l" and, with a limit, "cost".
 */
function sharedConstraints(
  candidates: CandidateLeg[],
  stateMinimums: number[],
  maxCost: number | null,
): Map<string, Constraint> {
  const constraints = new Map<string, Constraint>();
  stateMinimums.forEach((minimum, stateIndex) => {
    constraints.set(`state-${stateIndex}`, { min: minimum });
  });
  candidates.forEach((candidate, legIndex) => {
    if (candidate.cap !== null) {
      constraints.set(`cap-${legIndex}`, { max: candidate.cap });
    }
  });
  if (maxCost !== null) {
    constraints.set("cost", { max: maxCost });
  }
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
 * unhedged_j + sum(quantity_l * pays_lj) - totalCost >= floor, and, when a
 * cash limit applies, totalCost <= maxCost.
 *
 * @param {CandidateLeg[]} candidates - Available legs.
 * @param {number[]} unhedged - Unhedged P&L per state.
 * @param {number} floor - Required hedged P&L in every state (negative of the loss limit, plus any repair margin).
 * @param {number | null} maxCost - Largest total linear cost in dollars (the cash limit less any repair margin), or null for no limit.
 * @returns {number[] | null} Quantities per leg, or null when the floor cannot be met within the limit.
 * @throws {Error} If the solver ends in any state other than optimal or infeasible.
 */
function solveMinimumCost(
  candidates: CandidateLeg[],
  unhedged: number[],
  floor: number,
  maxCost: number | null,
): number[] | null {
  if (maxCost !== null && maxCost < 0) {
    // Costs are non-negative, so a negative limit (after a repair margin) admits no plan at all.
    return null;
  }
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
      maxCost,
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
 * t = worstCaseBefore. The lift is also capped at `maxLift` when one is given:
 * there is no value in raising the worst case past the floor (plus the
 * rounding margin), and the cap keeps the program bounded even when uncapped
 * legs form an arbitrage. A cash limit, when given, bounds total linear cost;
 * buying nothing always satisfies it, so the program stays feasible.
 *
 * @param {CandidateLeg[]} candidates - Available legs.
 * @param {number[]} unhedged - Unhedged P&L per state.
 * @param {number} worstCaseBefore - Minimum unhedged P&L across states.
 * @param {number | null} maxLift - Largest useful improvement of the worst case in dollars, or null for no cap.
 * @param {number | null} maxCost - Largest total linear cost in dollars, or null for no limit. Must not be negative.
 * @returns {{ quantities: number[]; lift: number }} Quantities per leg and the solver's improvement of the worst case; lift is Infinity (with zero quantities) when uncapped and unbounded.
 * @throws {Error} If the solver ends in any other state than optimal, or unbounded despite a cap.
 */
function solveMaximumWorstCase(
  candidates: CandidateLeg[],
  unhedged: number[],
  worstCaseBefore: number,
  maxLift: number | null,
  maxCost: number | null,
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
    maxCost,
  );
  if (maxLift !== null) {
    constraints.set("lift", { max: maxLift });
  }
  const model: Model = { direction: "maximize", objective: "lift", constraints, variables };
  const solution = solve(model);
  if (solution.status === "unbounded" && maxLift === null && maxCost === null) {
    return { quantities: new Array<number>(candidates.length).fill(0), lift: Number.POSITIVE_INFINITY };
  }
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
 * The same sum also bounds how far rounding can raise total cost above the
 * solver's linear cost: each kept leg grows by at most one increment of unit
 * cost (below $1) plus one cent of fee rounding, and dropped or rounded-down
 * legs only lower it. The cash-limit repair relies on this.
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

/** Everything the optimiser stages share for one request. */
interface SolveContext {
  request: HedgeRequest;
  states: PriceState[];
  /** Unhedged P&L per state, unrounded; decisions use these raw values. */
  unhedged: number[];
  worstCaseBefore: number;
  /** Required hedged P&L in every state: -maxLoss. */
  floor: number;
  tolerance: number;
  candidates: CandidateLeg[];
  /** Upper bound on how much rounding can lower any state's hedged P&L, or raise total cost. */
  roundingBound: number;
  /** Cash limit in dollars (request.maxOutlay), or null when there is none. */
  maxOutlay: number | null;
}

/** A plan together with whether its floor is reachable before rounding. */
interface PlanResult {
  plan: HedgePlan;
  /** True when no hedge is needed or the stage 1 program (before rounding) can meet the floor. */
  floorFeasible: boolean;
}

/** Result of searching for the cheapest rounded plan meeting a target worst case. */
interface CheapestPlanResult {
  /** Rounded legs meeting the target, or null when none was found. */
  legs: HedgeLeg[] | null;
  /** True when the target is reachable by the stage 1 program before rounding. */
  targetFeasible: boolean;
}

/**
 * Validates a request and builds the shared solver context: the stress price
 * (see `resolveStressPrice`), states, unhedged P&L, floor, tolerance and legs.
 *
 * @param {HedgeRequest} request - The request.
 * @returns {SolveContext} The context.
 * @throws {RangeError} If the request is invalid or the ladder has no rungs.
 */
function buildContext(request: HedgeRequest): SolveContext {
  validateRequest(request);
  if (request.ladder.rungs.length === 0) {
    throw new RangeError("Cannot hedge with a ladder that has no rungs");
  }
  const stressPrice = resolveStressPrice(request.ladder, request.exposure, request.stressPrice);
  const states = buildPriceStates(request.ladder, stressPrice);
  const unhedged = states.map((state) => unhedgedPnlAt(request.exposure, state.evalPrice));
  const candidates = candidateLegs(request, states);
  return {
    request,
    states,
    unhedged,
    worstCaseBefore: Math.min(...unhedged),
    floor: -request.maxLoss,
    tolerance: floorTolerance(request),
    candidates,
    roundingBound: maxRoundingLoss(candidates),
    maxOutlay: request.maxOutlay ?? null,
  };
}

/**
 * Sums the contracts of the legs that pay at a price.
 *
 * @param {HedgeLeg[]} legs - Hedge legs.
 * @param {number} price - Expiry price in dollars.
 * @returns {number} The payout in dollars.
 */
function payoutAt(legs: HedgeLeg[], price: number): number {
  return legs
    .filter((leg) => legPaysAtPrice(leg.side, leg.strike, price))
    .reduce((total, leg) => total + leg.quantity, 0);
}

/**
 * Computes the unrounded worst hedged P&L of a set of legs; used for decisions.
 *
 * @param {HedgeLeg[]} legs - Rounded legs.
 * @param {SolveContext} context - Solver context.
 * @returns {number} min over states of unhedged + payout - total cost.
 */
function worstHedgedPnl(legs: HedgeLeg[], context: SolveContext): number {
  const totalCost = legs.reduce((total, leg) => total + leg.cost, 0);
  const hedged = context.states.map(
    (state, stateIndex) => context.unhedged[stateIndex] + payoutAt(legs, state.evalPrice) - totalCost,
  );
  return Math.min(...hedged);
}

/**
 * Sums the cost of rounded legs exactly as `assemblePlan` reports it.
 *
 * @param {HedgeLeg[]} legs - Rounded legs.
 * @returns {number} Total cost in dollars, fees included.
 */
function totalCostOf(legs: HedgeLeg[]): number {
  return clean(legs.reduce((total, leg) => total + leg.cost, 0));
}

/**
 * Says whether rounded legs fit a cash limit. The reported total must not
 * exceed the limit; only floating-point noise of at most OUTLAY_TOLERANCE is
 * allowed, and rounded costs are whole cents plus prices in cents, so in
 * practice the comparison is exact.
 *
 * @param {HedgeLeg[]} legs - Rounded legs.
 * @param {number | null} maxOutlay - Cash limit in dollars, or null for none.
 * @returns {boolean} True when there is no limit or the legs cost no more than it.
 */
function withinOutlay(legs: HedgeLeg[], maxOutlay: number | null): boolean {
  return maxOutlay === null || totalCostOf(legs) <= maxOutlay + OUTLAY_TOLERANCE;
}

/**
 * Assembles a plan, recomputing cost, every outcome, the worst case and the
 * expected payout from the given (already rounded) legs. Reported P&L and
 * payout figures are snapped to 12 significant digits of position value (see
 * `snapDollars`).
 *
 * @param {HedgeStatus} status - Plan status.
 * @param {HedgeLeg[]} legs - Rounded legs.
 * @param {SolveContext} context - Solver context.
 * @returns {HedgePlan} The plan.
 */
function assemblePlan(status: HedgeStatus, legs: HedgeLeg[], context: SolveContext): HedgePlan {
  const scale = context.request.exposure.quantity * context.request.exposure.spot;
  const totalCost = totalCostOf(legs);
  const outcomes: StateOutcome[] = context.states.map((state, stateIndex) => {
    const unhedgedPnl = snapDollars(context.unhedged[stateIndex], scale);
    const hedgePayout = clean(payoutAt(legs, state.evalPrice));
    return {
      ...state,
      unhedgedPnl,
      hedgePayout,
      hedgedPnl: snapDollars(unhedgedPnl + hedgePayout - totalCost, scale),
    };
  });
  const worstCaseAfter = Math.min(...outcomes.map((outcome) => outcome.hedgedPnl));
  const expectedHedgePayout = snapDollars(
    outcomes.reduce((total, outcome) => total + outcome.probability * outcome.hedgePayout, 0),
    scale,
  );
  return {
    status,
    legs,
    totalCost,
    outcomes,
    worstCaseBefore: snapDollars(context.worstCaseBefore, scale),
    worstCaseAfter,
    expectedHedgePayout,
    requestedMaxLoss: context.request.maxLoss,
    stressPrice: context.states[0].evalPrice,
  };
}

/**
 * Finds the cheapest rounded plan whose worst hedged P&L is at least `target`
 * and, when `maxOutlay` is given, whose rounded total cost is at most it.
 *
 * Solves stage 1 with the target as the floor (and the limit as a cost
 * bound), rounds and prices the legs with the real fee, and repairs what
 * rounding breaks:
 * - if the worst case falls below the target, the floor is raised by the
 *   shortfall;
 * - if the total cost rises above the limit, the cost bound given to the
 *   solver is lowered by the overrun.
 * Each margin grows geometrically, and the final attempt uses the provable
 * rounding bound for both, which guarantees the rounded plan meets the target
 * and the limit whenever that tightened program is feasible. With no limit
 * this is exactly the floor repair loop the engine always used.
 *
 * @param {SolveContext} context - Solver context.
 * @param {number} target - Required worst hedged P&L in dollars.
 * @param {number | null} maxOutlay - Cash limit in dollars, or null for none.
 * @returns {CheapestPlanResult} The legs, or null when no rounded plan was found, and whether the target is reachable within the limit before rounding.
 * @throws {Error} If the solver fails unexpectedly.
 */
function cheapestPlanMeeting(context: SolveContext, target: number, maxOutlay: number | null): CheapestPlanResult {
  let margin = 0;
  let step = REPAIR_MIN_STEP;
  let outlayMargin = 0;
  let outlayStep = REPAIR_MIN_STEP;
  let targetFeasible = false;
  for (let attempt = 0; attempt < MAX_REPAIR_ATTEMPTS; attempt += 1) {
    if (attempt === MAX_REPAIR_ATTEMPTS - 1) {
      margin = Math.max(margin, context.roundingBound);
      if (maxOutlay !== null) {
        outlayMargin = Math.max(outlayMargin, context.roundingBound);
      }
    }
    const maxCost = maxOutlay === null ? null : maxOutlay - outlayMargin;
    const quantities = solveMinimumCost(context.candidates, context.unhedged, target + margin, maxCost);
    if (quantities === null) {
      break;
    }
    if (attempt === 0) {
      targetFeasible = true;
    }
    const legs = roundLegs(context.candidates, quantities, context.request.takerFeeRate);
    const shortfall = target - worstHedgedPnl(legs, context);
    const overrun = maxOutlay === null ? 0 : totalCostOf(legs) - maxOutlay;
    if (shortfall <= context.tolerance && overrun <= OUTLAY_TOLERANCE) {
      return { legs, targetFeasible: true };
    }
    if (shortfall > context.tolerance) {
      margin += Math.max(shortfall, step);
      step *= 2;
    }
    if (overrun > OUTLAY_TOLERANCE) {
      outlayMargin += Math.max(overrun, outlayStep);
      outlayStep *= 2;
    }
  }
  return { legs: null, targetFeasible };
}

/**
 * Rounds the stage 2 (maximin) quantities into legs that fit the cash limit.
 * When rounding quantities and fees up pushes the cost over the limit, stage
 * 2 is solved again with the limit lowered by the overrun (growing
 * geometrically, like the floor repair); the final attempt lowers it by the
 * provable rounding bound, which keeps the rounded cost within the limit.
 *
 * @param {SolveContext} context - Solver context.
 * @param {number[]} quantities - Stage 2 solver quantities, solved within the full limit.
 * @param {number | null} maxLift - Lift cap passed to stage 2.
 * @returns {HedgeLeg[]} Rounded legs within the limit; empty when none were found.
 * @throws {Error} If the solver fails unexpectedly.
 */
function affordableMaximinLegs(context: SolveContext, quantities: number[], maxLift: number | null): HedgeLeg[] {
  const { maxOutlay } = context;
  let legs = roundLegs(context.candidates, quantities, context.request.takerFeeRate);
  if (maxOutlay === null) {
    return legs;
  }
  let outlayMargin = 0;
  let step = REPAIR_MIN_STEP;
  for (let attempt = 0; attempt < MAX_REPAIR_ATTEMPTS; attempt += 1) {
    if (withinOutlay(legs, maxOutlay)) {
      return legs;
    }
    outlayMargin += Math.max(totalCostOf(legs) - maxOutlay, step);
    step *= 2;
    if (attempt === MAX_REPAIR_ATTEMPTS - 1) {
      outlayMargin = Math.max(outlayMargin, context.roundingBound);
    }
    const tightened = maxOutlay - outlayMargin;
    if (tightened <= 0) {
      return [];
    }
    const retry = solveMaximumWorstCase(context.candidates, context.unhedged, context.worstCaseBefore, maxLift, tightened);
    legs = roundLegs(context.candidates, retry.quantities, context.request.takerFeeRate);
  }
  return withinOutlay(legs, maxOutlay) ? legs : [];
}

/**
 * Returns how far below the best achievable worst case t* a `best-effort`
 * plan may sit: the smaller of BEST_EFFORT_SLACK_FRACTION of position value
 * and BEST_EFFORT_LIFT_SLACK_FRACTION of the achievable lift. Because the lift
 * term is always below the lift, the resulting target stays above the
 * unhedged worst case, so the cheapest plan meeting it is never "buy nothing".
 *
 * @param {HedgeRequest} request - The request.
 * @param {number} lift - t* minus the unhedged worst case, in dollars (positive).
 * @returns {number} The slack in dollars.
 */
function bestEffortSlack(request: HedgeRequest, lift: number): number {
  const valueSlack = BEST_EFFORT_SLACK_FRACTION * request.exposure.quantity * request.exposure.spot;
  return Math.min(valueSlack, BEST_EFFORT_LIFT_SLACK_FRACTION * lift);
}

/**
 * Runs stage 1, stage 2 and the best-effort search for a request that needs a
 * hedge and has at least one candidate leg, with `context.maxOutlay` (when not
 * null) as a hard bound on total cost in every program and on the rounded plan.
 *
 * @param {SolveContext} context - Solver context; its maxOutlay is the limit applied.
 * @returns {PlanResult} The plan and whether the floor is reachable within the limit before rounding.
 * @throws {Error} If the solver fails unexpectedly.
 */
function solveWithinOutlay(context: SolveContext): PlanResult {
  const { request, floor, tolerance, worstCaseBefore, maxOutlay } = context;

  const stageOne = cheapestPlanMeeting(context, floor, maxOutlay);
  if (stageOne.legs !== null) {
    return { plan: assemblePlan("optimal", stageOne.legs, context), floorFeasible: true };
  }
  const floorFeasible = stageOne.targetFeasible;

  const maxLift = floor + context.roundingBound - worstCaseBefore;
  const { quantities, lift } = solveMaximumWorstCase(
    context.candidates,
    context.unhedged,
    worstCaseBefore,
    maxLift,
    maxOutlay,
  );
  if (lift <= EPSILON) {
    return { plan: assemblePlan("unhedgeable", [], context), floorFeasible };
  }
  const maximinLegs = affordableMaximinLegs(context, quantities, maxLift);
  if (worstHedgedPnl(maximinLegs, context) >= floor - tolerance) {
    // Only reachable when the floor is reachable before rounding but the repair loop gave up.
    return { plan: assemblePlan("optimal", maximinLegs, context), floorFeasible };
  }

  const slack = bestEffortSlack(request, lift);
  const relaxed = cheapestPlanMeeting(context, worstCaseBefore + lift - slack, maxOutlay);
  let legs = maximinLegs;
  if (relaxed.legs !== null && worstHedgedPnl(relaxed.legs, context) > worstCaseBefore + EPSILON) {
    legs = relaxed.legs;
  }
  const worstAfter = worstHedgedPnl(legs, context);
  if (worstAfter <= worstCaseBefore + EPSILON) {
    return { plan: assemblePlan("unhedgeable", [], context), floorFeasible };
  }
  const status: HedgeStatus = worstAfter >= floor - tolerance ? "optimal" : "best-effort";
  return { plan: assemblePlan(status, legs, context), floorFeasible };
}

/**
 * Runs the full optimiser and also reports whether the floor is reachable
 * within the cash limit before rounding (which `maxHedgeableQuantity` uses to
 * stop its search).
 *
 * With a cash limit, the plan is first computed without it. When that plan
 * already fits the limit it is returned unchanged, so a limit that does not
 * bind never changes the plan, whatever its status. Otherwise the plan is
 * computed again with the limit as a hard bound on total cost.
 *
 * @param {HedgeRequest} request - The request.
 * @returns {PlanResult} The plan and the feasibility flag.
 * @throws {RangeError} If the request is invalid.
 * @throws {Error} If the solver fails unexpectedly.
 */
function planHedge(request: HedgeRequest): PlanResult {
  const context = buildContext(request);
  const { floor, tolerance, worstCaseBefore, maxOutlay } = context;

  if (worstCaseBefore >= floor - tolerance) {
    return { plan: assemblePlan("no-hedge-needed", [], context), floorFeasible: true };
  }
  if (context.candidates.length === 0) {
    return { plan: assemblePlan("unhedgeable", [], context), floorFeasible: false };
  }
  if (maxOutlay === null) {
    return solveWithinOutlay(context);
  }
  const unlimited = solveWithinOutlay({ ...context, maxOutlay: null });
  if (withinOutlay(unlimited.plan.legs, maxOutlay)) {
    return unlimited;
  }
  return solveWithinOutlay(context);
}

/**
 * Computes the cheapest basket of ladder contracts that keeps the holder's
 * hedged P&L at or above -maxLoss in every price state.
 *
 * - The stress price for state 0 is `request.stressPrice` when given, else
 *   `resolveStressPrice` (the lower of the ladder default and one gap below spot).
 * - Stage 1 minimises cost subject to the floor. Its quantities are rounded to
 *   tradable increments and priced with the real cent-rounded fee; if rounding
 *   leaves the worst case below the floor, stage 1 is re-solved with the floor
 *   raised by the shortfall until the rounded plan meets it.
 * - If the floor cannot be met, stage 2 finds the best achievable worst case
 *   t* and its lift over the unhedged worst case. The plan returned is the
 *   cheapest rounded plan whose worst case is at least t* - slack, where slack
 *   is the smaller of BEST_EFFORT_SLACK_FRACTION * quantity * spot and
 *   BEST_EFFORT_LIFT_SLACK_FRACTION * lift (`best-effort`). It therefore keeps
 *   at least 95% of the achievable improvement. If that search finds no
 *   rounded plan, the rounded maximin plan is returned instead. A stage 2
 *   plan that meets the floor after rounding is labelled `optimal`; one that
 *   does not improve the worst case gives `unhedgeable`.
 * - A plan labelled `optimal` always meets the floor after rounding, within
 *   `floorTolerance` (at most FLOOR_TOLERANCE dollars of floating-point noise).
 * - Cash limit: when `request.maxOutlay` is a number, total cost (fees
 *   included) is bounded by it in stage 1, stage 2 and the best-effort search,
 *   and the reported, rounded `totalCost` never exceeds it (beyond
 *   OUTLAY_TOLERANCE of floating-point noise): a rounding overrun is repaired
 *   by lowering the bound given to the solver. A limit at or above the cost of
 *   the plan computed without a limit returns that same plan, whatever its
 *   status (so a limit that does not bind changes nothing). When the floor is
 *   reachable but not within the limit, the result is `best-effort` (the
 *   cheapest plan within the usual slack of the best worst case reachable
 *   inside the limit) or `unhedgeable` when nothing affordable improves the
 *   worst case. A limit of 0 buys nothing. `no-hedge-needed` does not depend
 *   on the limit.
 * - Every number in the returned plan describes the rounded legs; P&L figures
 *   are snapped to 12 significant digits of position value.
 *
 * @param {HedgeRequest} request - Ladder, exposure, loss limit, stress price, fee rate, assumed depth and optional cash limit.
 * @returns {HedgePlan} The plan.
 * @throws {RangeError} If the request has out-of-range values (including a non-positive quantity or spot, or a negative or non-finite maxOutlay), unsorted strikes, invalid quotes, or the ladder has no rungs.
 * @throws {Error} If the linear programming solver fails unexpectedly.
 */
export function optimizeHedge(request: HedgeRequest): HedgePlan {
  return planHedge(request).plan;
}

/**
 * Returns the best worst-case hedged P&L the ladder can achieve for a request,
 * before rounding: the stage 2 optimum t*, with no cap on the lift. When the
 * request carries a cash limit (`maxOutlay`), t* is the best worst case
 * reachable within it. Useful for showing how close a `best-effort` plan
 * comes to the best possible.
 *
 * @param {HedgeRequest} request - The request.
 * @returns {number} t* in dollars; the unhedged worst case when no leg is available; Infinity when uncapped legs form an arbitrage and there is no cash limit.
 * @throws {RangeError} If the request is invalid.
 * @throws {Error} If the solver fails unexpectedly.
 */
export function bestAchievableWorstCase(request: HedgeRequest): number {
  const context = buildContext(request);
  if (context.candidates.length === 0) {
    return context.worstCaseBefore;
  }
  const { lift } = solveMaximumWorstCase(
    context.candidates,
    context.unhedged,
    context.worstCaseBefore,
    null,
    context.maxOutlay,
  );
  return context.worstCaseBefore + lift;
}

/**
 * Finds a large position size the ladder's quoted depth can hedge to a loss
 * floor proportional to the position's value (maxLoss = maxLossFraction * q * spot).
 *
 * - Returns Infinity when no position needs a hedge at this floor. Both the
 *   worst case and the floor scale with size, so a one-unit check decides it.
 * - Returns null when any usable leg has no cap (the answer would be unbounded).
 * - Otherwise tries sizes 2^-14, 2^-13, ... up to 1e9, takes the largest that
 *   `optimizeHedge` reports as `optimal` or `no-hedge-needed`, and bisects 20
 *   times between it and the next size up. The scan stops early once the floor
 *   is unreachable even before rounding, because then every larger size fails
 *   too. Rounding (whole increments and cent fees) makes success non-monotone
 *   in size, so the answer is a size that can be hedged near the top of the
 *   feasible range, not a sharp threshold. Returns 0 when no size tried succeeds.
 * - With `maxOutlayFraction`, each size tried also gets a cash limit that
 *   scales with it, like the floor: maxOutlay = maxOutlayFraction * q * spot.
 *   A size then counts as hedged only when the floor is met within that limit.
 *   Without it, no cash limit applies and `request.maxOutlay` is ignored.
 *
 * @param {HedgeRequest} request - The request; its exposure quantity, maxLoss and maxOutlay are replaced.
 * @param {number} maxLossFraction - Loss limit as a fraction of position value, for example 0.02.
 * @param {number} [maxOutlayFraction] - Cash limit as a fraction of position value, for example 0.1; omit for no limit.
 * @returns {number | null} The size, Infinity when no hedge is needed at any size, or null when depth is unlimited.
 * @throws {RangeError} If maxLossFraction or maxOutlayFraction is negative or not finite, or the request is invalid.
 * @throws {Error} If the solver fails unexpectedly.
 */
export function maxHedgeableQuantity(
  request: HedgeRequest,
  maxLossFraction: number,
  maxOutlayFraction?: number,
): number | null {
  if (!Number.isFinite(maxLossFraction) || maxLossFraction < 0) {
    throw new RangeError(`maxLossFraction must be a finite non-negative number, got ${maxLossFraction}`);
  }
  if (maxOutlayFraction !== undefined && (!Number.isFinite(maxOutlayFraction) || maxOutlayFraction < 0)) {
    throw new RangeError(`maxOutlayFraction must be a finite non-negative number, got ${maxOutlayFraction}`);
  }
  // request.maxOutlay is ignored here: the cash limit, if any, comes from maxOutlayFraction.
  const baseRequest: HedgeRequest = { ...request, maxOutlay: null };
  const context = buildContext(baseRequest);

  /**
   * Runs the optimiser at a given position size with the proportional floor
   * and, when a fraction is given, the proportional cash limit.
   *
   * @param {number} quantity - Position size in units of the asset.
   * @returns {PlanResult} The plan and whether the floor is reachable within the limit before rounding.
   */
  const resultAt = (quantity: number): PlanResult =>
    planHedge({
      ...baseRequest,
      exposure: { ...request.exposure, quantity },
      maxLoss: maxLossFraction * quantity * request.exposure.spot,
      maxOutlay: maxOutlayFraction === undefined ? null : maxOutlayFraction * quantity * request.exposure.spot,
    });

  /**
   * Decides whether a plan counts as hedged to its floor.
   *
   * @param {HedgePlan} plan - The plan.
   * @returns {boolean} True when the plan is optimal or no hedge is needed.
   */
  const isHedged = (plan: HedgePlan): boolean => plan.status === "optimal" || plan.status === "no-hedge-needed";

  if (resultAt(1).plan.status === "no-hedge-needed") {
    return Number.POSITIVE_INFINITY;
  }
  if (context.candidates.some((candidate) => candidate.cap === null)) {
    return null;
  }

  const grid: number[] = [];
  for (let exponent = GRID_MIN_EXPONENT; 2 ** exponent < MAX_SEARCH_QUANTITY; exponent += 1) {
    grid.push(2 ** exponent);
  }
  grid.push(MAX_SEARCH_QUANTITY);

  let bestIndex = -1;
  for (let index = 0; index < grid.length; index += 1) {
    const result = resultAt(grid[index]);
    if (isHedged(result.plan)) {
      bestIndex = index;
    } else if (!result.floorFeasible) {
      break;
    }
  }
  if (bestIndex === -1) {
    return 0;
  }
  if (bestIndex === grid.length - 1) {
    return MAX_SEARCH_QUANTITY;
  }

  let low = grid[bestIndex];
  let high = grid[bestIndex + 1];
  for (let iteration = 0; iteration < BISECTION_ITERATIONS; iteration += 1) {
    const middle = (low + high) / 2;
    if (isHedged(resultAt(middle).plan)) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return low;
}
