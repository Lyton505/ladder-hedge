import { describe, expect, it } from "vitest";
import {
  BEST_EFFORT_LIFT_SLACK_FRACTION,
  BEST_EFFORT_SLACK_FRACTION,
  FLOOR_TOLERANCE,
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
});
