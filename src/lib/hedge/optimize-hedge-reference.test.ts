import { describe, expect, it } from "vitest";
import {
  BEST_EFFORT_LIFT_SLACK_FRACTION,
  BEST_EFFORT_SLACK_FRACTION,
  FLOOR_TOLERANCE,
  OUTLAY_TOLERANCE,
  optimizeHedge,
} from "@/lib/hedge/optimize-hedge";
import {
  buildReferenceModel,
  referenceMaximumWorstCase,
  referenceMinimumCost,
} from "@/lib/hedge/test-reference-solver";
import type { HedgeRequest, Ladder, LadderRung } from "@/lib/hedge/types";

/** Number of random requests compared with the reference solver. */
const REFERENCE_TRIALS = 1000;

/** Number of random requests compared with the reference solver under a cash limit. */
const LIMITED_REFERENCE_TRIALS = 2000;

/** Fewest limited best-effort plans that must get the per-case pin (rarer than without a limit). */
const MIN_LIMITED_PIN_CHECKS = 40;

/** Time allowed for the limited reference test, which runs two engine and several reference solves per trial. */
const LIMITED_TEST_TIMEOUT_MS = 60_000;

/** Largest acceptable median of (rounded optimal cost - continuous minimum) on 0.01-increment ladders, in dollars. */
const MEDIAN_EXCESS_LIMIT = 0.01;

/** Largest acceptable 90th percentile of the same excess, in dollars. */
const NINETIETH_EXCESS_LIMIT = 0.06;

/** Fewest best-effort plans that must get the per-case cost check, so the check is not vacuous. */
const MIN_BEST_EFFORT_COST_CHECKS = 50;

/** The contract increment Gemini uses on every captured ladder. */
const CENT_INCREMENT = 0.01;

/** Dollar tolerance for comparisons between the two solvers. */
const SOLVER_TOLERANCE = 1e-6;

/** Seed of the second generator that draws cash limits, so the requests match the unlimited test. */
const LIMIT_SEED = 7331;

/** Share of limited trials whose cash limit is zero. */
const ZERO_LIMIT_SHARE = 0.1;

/**
 * Deterministic 32-bit pseudo-random generator (mulberry32), so failures reproduce.
 *
 * @param {number} seed - Integer seed.
 * @returns {() => number} A function returning uniform numbers in [0, 1).
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Draws a price in whole cents in [0.01, 0.99].
 *
 * @param {() => number} random - Uniform generator.
 * @returns {number} The price.
 */
function randomCents(random: () => number): number {
  return (1 + Math.floor(random() * 99)) / 100;
}

/**
 * Builds a random request on a ladder of 1 to 3 rungs, sometimes with spot below the ladder.
 *
 * @param {() => number} random - Uniform generator.
 * @returns {HedgeRequest} The request.
 */
function randomSmallRequest(random: () => number): HedgeRequest {
  const rungCount = 1 + Math.floor(random() * 3);
  const baseStrike = 50 + Math.floor(random() * 50);
  const spacing = [0.5, 1, 2, 5][Math.floor(random() * 4)];
  const increment = [0.01, 0.1, 1][Math.floor(random() * 3)];
  const rungs: LadderRung[] = [];
  for (let index = 0; index < rungCount; index += 1) {
    const bid = random() < 0.75 ? randomCents(random) : null;
    let ask = random() < 0.75 ? randomCents(random) : null;
    if (bid !== null && ask !== null && ask <= bid && random() < 0.8) {
      ask = Math.min(0.99, bid + 0.01);
    }
    rungs.push({
      instrumentSymbol: `REF-${index}`,
      label: `rung ${index}`,
      strike: baseStrike + index * spacing,
      yesBid: bid,
      yesAsk: ask,
      yesBidSize: random() < 0.4 ? Math.round(random() * 300) / 10 : null,
      yesAskSize: random() < 0.4 ? Math.round(random() * 300) / 10 : null,
      quantityIncrement: increment,
    });
  }
  const ladder: Ladder = {
    eventTicker: "REF",
    title: "reference",
    asset: "X",
    expiry: "2026-11-20T05:00:00.000Z",
    rungs,
    fetchedAt: "2026-11-19T20:00:00.000Z",
    source: "snapshot",
    referenceSpot: null,
  };
  const spot =
    random() < 0.15
      ? baseStrike - spacing * (1 + 3 * random())
      : baseStrike + (random() * (rungCount + 1) - 0.5) * spacing;
  const quantity = Math.max(0.1, Math.round(random() * 200) / 10);
  const stressGuess = Math.min(baseStrike - spacing, spot - spacing);
  const worstExposure = Math.max(0, quantity * (spot - stressGuess));
  return {
    ladder,
    exposure: { asset: "X", quantity, spot },
    maxLoss: Math.round(random() * worstExposure * 100) / 100,
    stressPrice: null,
    takerFeeRate: random() < 0.5 ? 0 : 0.07,
    assumedDepth: random() < 0.5 ? null : Math.round(random() * 300) / 10,
  };
}

describe("optimizeHedge against an independent vertex-enumeration solver", () => {
  it("agrees on feasibility, cost and worst case for seeded random 1 to 3 rung ladders", () => {
    const random = mulberry32(5150);
    const statusCounts: Record<string, number> = {};
    const centIncrementExcess: number[] = [];
    let bestEffortCostChecks = 0;
    for (let trial = 0; trial < REFERENCE_TRIALS; trial += 1) {
      const request = randomSmallRequest(random);
      const plan = optimizeHedge(request);
      const model = buildReferenceModel(request);
      const context = `trial ${trial}: ${JSON.stringify({ request, status: plan.status, legs: plan.legs, cost: plan.totalCost, worst: plan.worstCaseAfter })}`;
      statusCounts[plan.status] = (statusCounts[plan.status] ?? 0) + 1;

      const bound = model.roundingBound;
      const continuousMinimum = referenceMinimumCost(model, 0);
      const continuousBest = referenceMaximumWorstCase(model).worstCase;

      expect(plan.stressPrice, context).toBeCloseTo(model.evalPrices[0], 9);
      expect(plan.worstCaseBefore, context).toBeCloseTo(model.worstCaseBefore, 6);
      expect(plan.worstCaseAfter, context).toBeLessThanOrEqual(continuousBest + SOLVER_TOLERANCE);

      if (plan.status === "no-hedge-needed") {
        expect(model.worstCaseBefore, context).toBeGreaterThanOrEqual(model.floor - FLOOR_TOLERANCE);
      } else {
        expect(model.worstCaseBefore, context).toBeLessThan(model.floor + SOLVER_TOLERANCE);
      }

      if (plan.status === "optimal") {
        expect(continuousMinimum, context).not.toBeNull();
        expect(plan.worstCaseAfter, context).toBeGreaterThanOrEqual(model.floor - FLOOR_TOLERANCE);
        const lowerBound = continuousMinimum?.cost ?? Number.NaN;
        expect(plan.totalCost, context).toBeGreaterThanOrEqual(lowerBound - SOLVER_TOLERANCE);
        // The engine's repair margin never exceeds 2 * bound + 0.005, and rounding adds at most `bound` of cost.
        const marginedMinimum = referenceMinimumCost(model, 2 * bound + 0.01);
        if (marginedMinimum !== null) {
          expect(plan.totalCost, context).toBeLessThanOrEqual(marginedMinimum.cost + bound + SOLVER_TOLERANCE);
        }
        if (request.ladder.rungs[0].quantityIncrement === CENT_INCREMENT) {
          centIncrementExcess.push(plan.totalCost - lowerBound);
        }
      }

      if (continuousMinimum === null) {
        expect(["best-effort", "unhedgeable"], context).toContain(plan.status);
      } else if (plan.status === "best-effort" || plan.status === "unhedgeable") {
        // The floor is reachable before rounding, but only just: no rounded repair could reach it.
        expect(continuousBest - model.floor, context).toBeLessThanOrEqual(2 * bound + 0.01);
      }

      if (plan.status === "best-effort") {
        const lift = continuousBest - model.worstCaseBefore;
        const slack = Math.min(
          BEST_EFFORT_SLACK_FRACTION * request.exposure.quantity * request.exposure.spot,
          BEST_EFFORT_LIFT_SLACK_FRACTION * lift,
        );
        const target = continuousBest - slack;
        expect(plan.worstCaseAfter, context).toBeGreaterThan(plan.worstCaseBefore);
        expect(plan.worstCaseAfter, context).toBeLessThan(model.floor);
        expect(plan.worstCaseAfter, context).toBeGreaterThanOrEqual(
          continuousBest - Math.max(slack, bound) - SOLVER_TOLERANCE,
        );
        // Any rounded plan costs at least the continuous minimum for the worst case it achieves.
        const achievedMinimum = referenceMinimumCost(model, plan.worstCaseAfter - model.floor);
        if (achievedMinimum !== null) {
          expect(plan.totalCost, context).toBeGreaterThanOrEqual(achievedMinimum.cost - SOLVER_TOLERANCE);
        }
        // The slack-adjusted target is always reachable before rounding.
        expect(referenceMinimumCost(model, target - model.floor), context).not.toBeNull();
        // Finding 4 pin: when the slack leaves room for the full repair margin (2 * bound + 0.005),
        // the cheapest-plan search must succeed, so the cost is at most the reference minimum at
        // that margin plus the rounding bound. The pure maximin plan breaks this (for example
        // $17.21 against a limit of $14.75 on trial 10 when the fix is reverted).
        const marginedTarget = referenceMinimumCost(model, target + 2 * bound + 0.01 - model.floor);
        if (marginedTarget !== null) {
          bestEffortCostChecks += 1;
          expect(plan.totalCost, context).toBeLessThanOrEqual(marginedTarget.cost + bound + SOLVER_TOLERANCE);
        }
      }

      if (plan.status === "unhedgeable") {
        expect(plan.legs, context).toEqual([]);
        expect(continuousBest - model.worstCaseBefore, context).toBeLessThanOrEqual(bound + SOLVER_TOLERANCE);
      }
    }
    expect(statusCounts.optimal ?? 0).toBeGreaterThan(30);
    expect(statusCounts["best-effort"] ?? 0).toBeGreaterThan(30);

    // Optimality pin: per case the bound above is loose, so also require the typical
    // rounded cost to sit within cents of the continuous minimum. A plan that skipped
    // stage 1 and used the maximin plan instead shows a median near $0.035 and a
    // 90th percentile near $0.21 here; the engine shows about $0.003 and $0.02.
    centIncrementExcess.sort((left, right) => left - right);
    expect(centIncrementExcess.length).toBeGreaterThan(50);
    const median = centIncrementExcess[Math.floor((centIncrementExcess.length - 1) / 2)];
    const ninetieth = centIncrementExcess[Math.floor(0.9 * (centIncrementExcess.length - 1))];
    expect(median).toBeLessThan(MEDIAN_EXCESS_LIMIT);
    expect(ninetieth).toBeLessThan(NINETIETH_EXCESS_LIMIT);

    expect(bestEffortCostChecks).toBeGreaterThan(MIN_BEST_EFFORT_COST_CHECKS);
  });

  it("agrees on feasibility, cost and worst case within a cash limit, and never exceeds the limit", () => {
    // Same requests as the test above (same seed), each given a cash limit drawn from a second generator.
    const random = mulberry32(5150);
    const limitRandom = mulberry32(LIMIT_SEED);
    const statusCounts: Record<string, number> = {};
    let limitBindsCount = 0;
    let bestEffortCostChecks = 0;
    let tightAllowanceChecks = 0;
    const limitedExcess: number[] = [];
    for (let trial = 0; trial < LIMITED_REFERENCE_TRIALS; trial += 1) {
      const base = randomSmallRequest(random);
      const unlimitedModel = buildReferenceModel(base);
      const unlimitedMinimum = referenceMinimumCost(unlimitedModel, 0);
      const maximin = referenceMaximumWorstCase(unlimitedModel);
      const maximinCost = maximin.quantities.reduce(
        (total, quantity, legIndex) => total + quantity * unlimitedModel.legs[legIndex].unitCost,
        0,
      );
      // Draw limits around what the plan would cost without one, so the limit often binds.
      const scale = 1.5 * (unlimitedMinimum?.cost ?? maximinCost) + 0.05;
      const maxOutlay = limitRandom() < ZERO_LIMIT_SHARE ? 0 : Math.round(limitRandom() * scale * 100) / 100;
      const request: HedgeRequest = { ...base, maxOutlay };
      const plan = optimizeHedge(request);
      const model = buildReferenceModel(request);
      const context = `trial ${trial}: ${JSON.stringify({ request, status: plan.status, legs: plan.legs, cost: plan.totalCost, worst: plan.worstCaseAfter })}`;
      statusCounts[plan.status] = (statusCounts[plan.status] ?? 0) + 1;

      const bound = model.roundingBound;
      const limitedMinimum = referenceMinimumCost(model, 0);
      const bestWithinLimit = referenceMaximumWorstCase(model).worstCase;
      if (unlimitedMinimum !== null && limitedMinimum === null) {
        limitBindsCount += 1;
      }

      // The limit is never exceeded, by any status.
      expect(plan.totalCost, context).toBeLessThanOrEqual(maxOutlay + OUTLAY_TOLERANCE);
      // A limit the plan without a limit already fits changes nothing (that plan is checked
      // against the reference in the test above); the slack checks below apply when it binds.
      const unlimitedPlan = optimizeHedge(base);
      const limitBinds = unlimitedPlan.totalCost > maxOutlay + OUTLAY_TOLERANCE;
      if (!limitBinds) {
        expect(plan, context).toEqual(unlimitedPlan);
      }
      expect(plan.stressPrice, context).toBeCloseTo(model.evalPrices[0], 9);
      expect(plan.worstCaseBefore, context).toBeCloseTo(model.worstCaseBefore, 6);
      expect(plan.worstCaseAfter, context).toBeLessThanOrEqual(bestWithinLimit + SOLVER_TOLERANCE);

      if (plan.status === "no-hedge-needed") {
        expect(model.worstCaseBefore, context).toBeGreaterThanOrEqual(model.floor - FLOOR_TOLERANCE);
      } else {
        expect(model.worstCaseBefore, context).toBeLessThan(model.floor + SOLVER_TOLERANCE);
      }

      if (plan.status === "optimal") {
        expect(limitedMinimum, context).not.toBeNull();
        expect(plan.worstCaseAfter, context).toBeGreaterThanOrEqual(model.floor - FLOOR_TOLERANCE);
        expect(plan.totalCost, context).toBeGreaterThanOrEqual((limitedMinimum?.cost ?? Number.NaN) - SOLVER_TOLERANCE);
        // Same bound as without a limit: the limit only cuts off dearer plans.
        const marginedMinimum = referenceMinimumCost(unlimitedModel, 2 * bound + 0.01);
        if (marginedMinimum !== null) {
          expect(plan.totalCost, context).toBeLessThanOrEqual(marginedMinimum.cost + bound + SOLVER_TOLERANCE);
        }
      }

      if (limitedMinimum === null) {
        expect(["best-effort", "unhedgeable"], context).toContain(plan.status);
      } else if (plan.status === "best-effort" || plan.status === "unhedgeable") {
        // Reachable before rounding, but only just: either the floor or the limit leaves no room
        // for the repair margins (each below 2 * bound + 0.005).
        expect(referenceMinimumCost(model, 2 * bound + 0.01, 2 * bound + 0.01), context).toBeNull();
      }

      if (plan.status === "best-effort" && limitBinds) {
        const lift = bestWithinLimit - model.worstCaseBefore;
        const slack = Math.min(
          BEST_EFFORT_SLACK_FRACTION * request.exposure.quantity * request.exposure.spot,
          BEST_EFFORT_LIFT_SLACK_FRACTION * lift,
        );
        const target = bestWithinLimit - slack;
        expect(plan.worstCaseAfter, context).toBeGreaterThan(plan.worstCaseBefore);
        expect(plan.worstCaseAfter, context).toBeLessThan(model.floor);
        // Any rounded plan costs at least the continuous minimum for the worst case it achieves.
        const achievedMinimum = referenceMinimumCost(unlimitedModel, plan.worstCaseAfter - model.floor);
        if (achievedMinimum !== null) {
          expect(plan.totalCost, context).toBeGreaterThanOrEqual(achievedMinimum.cost - SOLVER_TOLERANCE);
        }
        const targetMinimum = referenceMinimumCost(model, target - model.floor);
        if (targetMinimum !== null && request.ladder.rungs[0].quantityIncrement === CENT_INCREMENT) {
          limitedExcess.push(plan.totalCost - targetMinimum.cost);
        }
        // Slack rule against the best worst case inside the limit: whenever the reference can meet the
        // target with room for both repair margins, the engine's search must succeed, so the plan
        // reaches the target and costs at most that reference minimum plus the rounding bound.
        const marginedTarget = referenceMinimumCost(model, target + 2 * bound + 0.01 - model.floor, 2 * bound + 0.01);
        if (marginedTarget !== null) {
          bestEffortCostChecks += 1;
          expect(plan.worstCaseAfter, context).toBeGreaterThanOrEqual(target - SOLVER_TOLERANCE);
          expect(plan.totalCost, context).toBeLessThanOrEqual(marginedTarget.cost + bound + SOLVER_TOLERANCE);
        }
        // In every case the plan comes within the slack of the best worst case reachable within the
        // limit, or, when it falls back to the maximin plan, within the rounding bound plus what
        // lowering the limit by the repair margin (under 2 * bound + 0.005) can cost. The best worst
        // case is concave in the limit, so that cost is at most margin / limit * lift. With limits of
        // a few cents this allowance is large: the cent-rounded fee is a fixed cost per leg that the
        // linear programs cannot see.
        const repairAllowance = maxOutlay > 0 ? ((2 * bound + 0.01) / maxOutlay) * lift : Number.POSITIVE_INFINITY;
        expect(plan.worstCaseAfter, context).toBeGreaterThanOrEqual(
          bestWithinLimit - Math.max(slack, bound + repairAllowance) - SOLVER_TOLERANCE,
        );
        if (maxOutlay > 0 && repairAllowance < bound) {
          tightAllowanceChecks += 1;
        }
      }

      if (plan.status === "unhedgeable") {
        expect(plan.legs, context).toEqual([]);
        expect(plan.totalCost, context).toBe(0);
        // Nothing affordable helps by more than rounding can take away, unless the limit itself is
        // below the rounding bound (a cent or two, where the cent-rounded fee alone can use it up).
        // This is an observed property of the engine on these seeds, not a proven bound.
        if (maxOutlay > bound) {
          expect(bestWithinLimit - model.worstCaseBefore, context).toBeLessThanOrEqual(bound + SOLVER_TOLERANCE);
        }
      }
    }
    // Cheapness pin for limited best-effort plans on 0.01-increment ladders: the typical cost sits
    // within cents of the reference minimum for the slack target inside the limit (median about
    // $0.004 and 90th percentile about $0.026 on 307 plans with these seeds).
    limitedExcess.sort((left, right) => left - right);
    expect(limitedExcess.length).toBeGreaterThan(50);
    expect(limitedExcess[Math.floor((limitedExcess.length - 1) / 2)]).toBeLessThan(MEDIAN_EXCESS_LIMIT);
    expect(limitedExcess[Math.floor(0.9 * (limitedExcess.length - 1))]).toBeLessThan(NINETIETH_EXCESS_LIMIT);
    // With these seeds (2,000 trials): 254 optimal, 1,121 best-effort, 438 unhedgeable and 187
    // no-hedge-needed; the limit makes a reachable floor unreachable in 522 trials; 49 best-effort
    // plans get the per-case pin and 175 get a repair allowance below the rounding bound.
    expect(statusCounts.optimal ?? 0).toBeGreaterThan(30);
    expect(statusCounts["best-effort"] ?? 0).toBeGreaterThan(30);
    expect(statusCounts.unhedgeable ?? 0).toBeGreaterThan(30);
    expect(limitBindsCount).toBeGreaterThan(30);
    expect(bestEffortCostChecks).toBeGreaterThan(MIN_LIMITED_PIN_CHECKS);
    expect(tightAllowanceChecks).toBeGreaterThan(MIN_BEST_EFFORT_COST_CHECKS);
  }, LIMITED_TEST_TIMEOUT_MS);
});
