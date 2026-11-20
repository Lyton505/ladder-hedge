import { describe, expect, it } from "vitest";
import { parseLadder } from "@/lib/gemini/parse-ladder";
import {
  BEST_EFFORT_SLACK_FRACTION,
  FLOOR_TOLERANCE,
  GEMINI_TAKER_FEE_RATE,
  bestAchievableWorstCase,
  maxHedgeableQuantity,
  optimizeHedge,
} from "@/lib/hedge/optimize-hedge";
import { legPaysAtPrice } from "@/lib/hedge/price-states";
import {
  SOL_FIXTURE_EXPOSURE,
  SOL_FIXTURE_LADDER,
  makeFixtureRung,
  withFixtureRungs,
} from "@/lib/hedge/test-fixtures";
import type { HedgePlan, HedgeRequest, Ladder, LadderRung } from "@/lib/hedge/types";
import btcEvent from "../../../fixtures/gemini/btc-2611200500.json";
import solEvent from "../../../fixtures/gemini/sol-2611202200.json";

/** Spot recorded with the BTC2611200500 snapshot (fixtures/gemini/snapshot-meta.json). */
const BTC_SNAPSHOT_SPOT = 61497.87;

/** Spot recorded with the default SOL2611202200 snapshot (fixtures/gemini/snapshot-meta.json). */
const SOL_SNAPSHOT_SPOT = 71.8915;

/**
 * Builds a request on the fixture ladder with zero fees and unlimited depth, then applies overrides.
 *
 * @param {Partial<HedgeRequest>} overrides - Fields to replace.
 * @returns {HedgeRequest} The request.
 */
function fixtureRequest(overrides: Partial<HedgeRequest> = {}): HedgeRequest {
  return {
    ladder: SOL_FIXTURE_LADDER,
    exposure: SOL_FIXTURE_EXPOSURE,
    maxLoss: 10,
    stressPrice: null,
    takerFeeRate: 0,
    assumedDepth: null,
    ...overrides,
  };
}

/**
 * Asserts that every outcome satisfies hedgedPnl = unhedgedPnl + hedgePayout - totalCost
 * and that the reported worst case is the minimum hedged outcome.
 *
 * @param {HedgePlan} plan - The plan to check.
 * @returns {void}
 */
function expectConsistentOutcomes(plan: HedgePlan): void {
  plan.outcomes.forEach((outcome) => {
    expect(Math.abs(outcome.hedgedPnl - (outcome.unhedgedPnl + outcome.hedgePayout - plan.totalCost))).toBeLessThan(1e-9);
  });
  const minimum = Math.min(...plan.outcomes.map((outcome) => outcome.hedgedPnl));
  expect(Math.abs(plan.worstCaseAfter - minimum)).toBeLessThan(1e-9);
  const legCostSum = plan.legs.reduce((total, leg) => total + leg.cost, 0);
  expect(Math.abs(plan.totalCost - legCostSum)).toBeLessThan(1e-9);
}

describe("optimizeHedge on the fixture", () => {
  it("exports Gemini's published taker rate", () => {
    expect(GEMINI_TAKER_FEE_RATE).toBe(0.07);
  });

  it("finds the cheapest NO basket for a $10 floor", () => {
    const plan = optimizeHedge(fixtureRequest());

    expect(plan.status).toBe("optimal");
    expect(plan.worstCaseBefore).toBeCloseTo(-51.2, 2);
    expect(plan.totalCost).toBeGreaterThanOrEqual(2.37);
    expect(plan.totalCost).toBeLessThanOrEqual(2.4);
    expect(plan.worstCaseAfter).toBeGreaterThanOrEqual(-10.02);
    expect(plan.worstCaseAfter).toBeGreaterThanOrEqual(-10 - 1e-9);
    plan.legs.forEach((leg) => {
      expect(leg.side).toBe("no");
    });
    expect(plan.legs.some((leg) => leg.strike === 68)).toBe(false);
    expectConsistentOutcomes(plan);
    expect(plan.requestedMaxLoss).toBe(10);
    expect(plan.stressPrice).toBe(67);
  });

  it("matches the hand-solved basket: NO 69 x20, NO 70 x10, NO 71 x10, NO 72 x3.58", () => {
    const plan = optimizeHedge(fixtureRequest());
    const quantities = new Map(plan.legs.map((leg) => [leg.strike, leg.quantity]));

    expect(plan.legs).toHaveLength(4);
    expect(quantities.get(69)).toBeCloseTo(20, 9);
    expect(quantities.get(70)).toBeCloseTo(10, 9);
    expect(quantities.get(71)).toBeCloseTo(10, 9);
    expect(quantities.get(72)).toBeCloseTo(3.58, 9);
    expect(plan.totalCost).toBeCloseTo(2.374, 9);
    expect(plan.worstCaseAfter).toBeCloseTo(-9.994, 9);
  });

  it("reports the expected hedge payout as the probability-weighted payout", () => {
    const plan = optimizeHedge(fixtureRequest());
    const expected = plan.outcomes.reduce((total, outcome) => total + outcome.probability * outcome.hedgePayout, 0);
    expect(Math.abs(plan.expectedHedgePayout - expected)).toBeLessThan(1e-9);
  });

  it("falls back to best-effort when the floor is zero loss", () => {
    const plan = optimizeHedge(fixtureRequest({ maxLoss: 0 }));

    expect(plan.status).toBe("best-effort");
    expect(plan.worstCaseAfter).toBeGreaterThan(plan.worstCaseBefore);
    expect(plan.worstCaseAfter).toBeLessThan(0);
    expectConsistentOutcomes(plan);
  });

  it("falls back to best-effort when depth is capped at 5 contracts per leg", () => {
    const plan = optimizeHedge(fixtureRequest({ assumedDepth: 5 }));

    expect(plan.status).toBe("best-effort");
    expect(plan.legs.length).toBeGreaterThan(0);
    plan.legs.forEach((leg) => {
      expect(leg.quantity).toBeLessThanOrEqual(5);
    });
    expect(plan.worstCaseAfter).toBeGreaterThan(plan.worstCaseBefore);
    expectConsistentOutcomes(plan);
  });

  it("needs no hedge when the floor is already met", () => {
    const plan = optimizeHedge(fixtureRequest({ maxLoss: 100 }));

    expect(plan.status).toBe("no-hedge-needed");
    expect(plan.legs).toEqual([]);
    expect(plan.totalCost).toBe(0);
    expect(plan.worstCaseAfter).toBeCloseTo(plan.worstCaseBefore, 12);
    expectConsistentOutcomes(plan);
  });

  it("is unhedgeable when no NO side is quoted", () => {
    const ladder = withFixtureRungs((rung) => ({ ...rung, yesBid: null }));
    const plan = optimizeHedge(fixtureRequest({ ladder }));

    expect(plan.status).toBe("unhedgeable");
    expect(plan.legs).toEqual([]);
    expect(plan.totalCost).toBe(0);
    expect(plan.worstCaseAfter).toBe(plan.worstCaseBefore);
  });

  it("charges Gemini's rounded-up taker fee per leg", () => {
    const zeroFeePlan = optimizeHedge(fixtureRequest());
    const feePlan = optimizeHedge(fixtureRequest({ takerFeeRate: 0.07 }));

    expect(feePlan.status).toBe("optimal");
    expect(feePlan.totalCost).toBeGreaterThan(zeroFeePlan.totalCost);
    feePlan.legs.forEach((leg) => {
      const expectedFee = Math.ceil(0.07 * leg.quantity * leg.price * (1 - leg.price) * 100 - 1e-9) / 100;
      expect(leg.fee).toBeCloseTo(expectedFee, 12);
      expect(leg.cost).toBeCloseTo(leg.quantity * leg.price + leg.fee, 12);
    });
    expectConsistentOutcomes(feePlan);
    expect(feePlan.worstCaseAfter).toBeGreaterThanOrEqual(-10 - FLOOR_TOLERANCE);
    zeroFeePlan.legs.forEach((leg) => {
      expect(leg.fee).toBe(0);
    });
  });

  it("uses the supplied stress price for state 0", () => {
    const plan = optimizeHedge(fixtureRequest({ stressPrice: 60, maxLoss: 200 }));
    expect(plan.stressPrice).toBe(60);
    expect(plan.worstCaseBefore).toBeCloseTo(10 * (60 - 72.12), 9);
  });

  it("rejects invalid inputs with a RangeError", () => {
    expect(() => optimizeHedge(fixtureRequest({ maxLoss: -1 }))).toThrow(RangeError);
    expect(() => optimizeHedge(fixtureRequest({ takerFeeRate: -0.1 }))).toThrow(RangeError);
    expect(() =>
      optimizeHedge(fixtureRequest({ exposure: { ...SOL_FIXTURE_EXPOSURE, quantity: -1 } })),
    ).toThrow(RangeError);
    expect(() => optimizeHedge(fixtureRequest({ stressPrice: 68 }))).toThrow(RangeError);
  });
});

describe("optimizeHedge with sizes and increments", () => {
  it("respects quoted sizes over assumed depth and never rounds past a cap", () => {
    const ladder: Ladder = {
      ...SOL_FIXTURE_LADDER,
      rungs: [
        { ...makeFixtureRung(100, 0.9, 0.95), yesBidSize: 7.5, quantityIncrement: 1 },
        { ...makeFixtureRung(110, 0.5, 0.55), yesBidSize: 2.4, quantityIncrement: 1 },
      ],
    };
    const plan = optimizeHedge({
      ladder,
      exposure: { asset: "SOL", quantity: 1, spot: 110 },
      maxLoss: 0,
      stressPrice: null,
      takerFeeRate: 0,
      assumedDepth: 1000,
    });

    plan.legs.forEach((leg) => {
      expect(leg.side).toBe("no");
      const cap = leg.strike === 100 ? 7.5 : 2.4;
      expect(leg.quantity).toBeLessThanOrEqual(cap);
      expect(Number.isInteger(leg.quantity)).toBe(true);
    });
    expectConsistentOutcomes(plan);
  });
});

describe("maxHedgeableQuantity", () => {
  it("is null when some leg has unlimited depth", () => {
    expect(maxHedgeableQuantity(fixtureRequest({ assumedDepth: null }), 0.02)).toBeNull();
  });

  it("finds the largest position the quotes can hedge at a 2 percent floor", () => {
    const request = fixtureRequest({ assumedDepth: 50 });
    const quantity = maxHedgeableQuantity(request, 0.02);

    expect(quantity).not.toBeNull();
    const q = quantity ?? 0;
    expect(q).toBeGreaterThan(0);
    expect(Number.isFinite(q)).toBe(true);

    /**
     * Runs the optimiser at a given position size with the proportional floor.
     *
     * @param {number} size - Position size in SOL.
     * @returns {HedgePlan} The resulting plan.
     */
    const planAt = (size: number): HedgePlan =>
      optimizeHedge({
        ...request,
        exposure: { ...request.exposure, quantity: size },
        maxLoss: 0.02 * size * request.exposure.spot,
      });

    expect(planAt(0.99 * q).status).toBe("optimal");
    expect(planAt(1.05 * q).status).not.toBe("optimal");
  });

  it("returns 0 when even tiny positions cannot be hedged", () => {
    const ladder = withFixtureRungs((rung) => ({ ...rung, yesBid: null }));
    expect(maxHedgeableQuantity(fixtureRequest({ ladder, assumedDepth: 50 }), 0.02)).toBe(0);
  });

  it("returns Infinity when no position size needs a hedge at the floor", () => {
    // Stress 67 vs spot 72.12 loses 7.1 percent of value, so a 10 percent floor never binds.
    expect(maxHedgeableQuantity(fixtureRequest({ assumedDepth: 100, takerFeeRate: 0.07 }), 0.1)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(maxHedgeableQuantity(fixtureRequest({ assumedDepth: null }), 0.1)).toBe(Number.POSITIVE_INFINITY);
  });

  it("returns Infinity on the BTC snapshot at a 1.5 percent floor instead of 1e9", () => {
    const ladder = parseLadder(btcEvent, "snapshot", "2026-11-20T04:44:00Z", BTC_SNAPSHOT_SPOT);
    expect(ladder).not.toBeNull();
    if (ladder === null) {
      return;
    }
    const request: HedgeRequest = {
      ladder,
      exposure: { asset: "BTC", quantity: 1, spot: BTC_SNAPSHOT_SPOT },
      maxLoss: 0,
      stressPrice: null,
      takerFeeRate: GEMINI_TAKER_FEE_RATE,
      assumedDepth: 100,
    };
    expect(maxHedgeableQuantity(request, 0.015)).toBe(Number.POSITIVE_INFINITY);
  });

  it("finds a hedgeable size above small sizes that fail on fee rounding (fee 0.07, depth 100, 0.8 percent)", () => {
    const request = fixtureRequest({ takerFeeRate: GEMINI_TAKER_FEE_RATE, assumedDepth: 100 });

    /**
     * Runs the optimiser at a size with the 0.8 percent proportional floor.
     *
     * @param {number} size - Position size in SOL.
     * @returns {HedgePlan} The plan.
     */
    const planAt = (size: number): HedgePlan =>
      optimizeHedge({
        ...request,
        exposure: { ...request.exposure, quantity: size },
        maxLoss: 0.008 * size * request.exposure.spot,
      });

    // Rounding makes success non-monotone in size: small sizes fail, mid sizes pass.
    expect(planAt(1).status).not.toBe("optimal");
    expect(planAt(8).status).toBe("optimal");
    expect(planAt(50).status).toBe("optimal");

    const quantity = maxHedgeableQuantity(request, 0.008) ?? 0;
    expect(quantity).toBeGreaterThanOrEqual(50);
    expect(Number.isFinite(quantity)).toBe(true);
    expect(planAt(quantity).status).toBe("optimal");
    expect(planAt(2 * quantity).status).not.toBe("optimal");
  });

  it("returns a size that is actually hedgeable at fee 0.07 for several floors", () => {
    const request = fixtureRequest({ takerFeeRate: GEMINI_TAKER_FEE_RATE, assumedDepth: 50 });
    [0.015, 0.02, 0.03].forEach((fraction) => {
      const quantity = maxHedgeableQuantity(request, fraction) ?? 0;
      expect(quantity).toBeGreaterThan(0);
      const plan = optimizeHedge({
        ...request,
        exposure: { ...request.exposure, quantity },
        maxLoss: fraction * quantity * request.exposure.spot,
      });
      expect(plan.status).toBe("optimal");
    });
  });
});

describe("optimizeHedge when spot is below the ladder", () => {
  it.each([
    [60, 59],
    [66.5, 65.5],
  ])("hedges a holder at spot %s with stress price %s instead of reporting no hedge needed", (spot, stress) => {
    const plan = optimizeHedge(fixtureRequest({ exposure: { ...SOL_FIXTURE_EXPOSURE, spot }, maxLoss: 1 }));

    expect(plan.status).not.toBe("no-hedge-needed");
    expect(plan.stressPrice).toBeCloseTo(stress, 12);
    expect(plan.worstCaseBefore).toBeCloseTo(10 * (stress - spot), 9);
    expect(plan.worstCaseBefore).toBeLessThan(0);
    expect(plan.status).toBe("optimal");
    expect(plan.legs.length).toBeGreaterThan(0);
    plan.legs.forEach((leg) => {
      expect(leg.side).toBe("no");
    });
    expect(plan.worstCaseAfter).toBeGreaterThanOrEqual(-1 - FLOOR_TOLERANCE);
    expectConsistentOutcomes(plan);
  });

  it("keeps the ladder default stress price when spot is inside the ladder", () => {
    const plan = optimizeHedge(fixtureRequest());
    expect(plan.stressPrice).toBe(67);
    expect(plan.worstCaseBefore).toBe(-51.2);
  });
});

describe("best-effort plans at tight floors", () => {
  it("does not spend dollars for cents on the default SOL snapshot at a 0.5 percent floor", () => {
    const ladder = parseLadder(solEvent, "snapshot", "2026-11-20T05:09:28Z", SOL_SNAPSHOT_SPOT);
    expect(ladder).not.toBeNull();
    if (ladder === null) {
      return;
    }
    const positionValue = 10 * SOL_SNAPSHOT_SPOT;
    const request: HedgeRequest = {
      ladder,
      exposure: { asset: "SOL", quantity: 10, spot: SOL_SNAPSHOT_SPOT },
      maxLoss: 0.005 * positionValue,
      stressPrice: null,
      takerFeeRate: GEMINI_TAKER_FEE_RATE,
      assumedDepth: 100,
    };
    const plan = optimizeHedge(request);
    const bestWorstCase = bestAchievableWorstCase(request);

    expect(plan.status).toBe("best-effort");
    // The pure maximin plan cost $130.55 for a worst case of -9.465 (review A, finding 4).
    expect(plan.totalCost).toBeLessThan(70);
    expect(plan.worstCaseAfter).toBeLessThanOrEqual(bestWorstCase + FLOOR_TOLERANCE);
    expect(plan.worstCaseAfter).toBeGreaterThanOrEqual(
      bestWorstCase - BEST_EFFORT_SLACK_FRACTION * positionValue - FLOOR_TOLERANCE,
    );
    expectConsistentOutcomes(plan);
  });

  it("exports the best-effort slack as 0.1 percent of position value", () => {
    expect(BEST_EFFORT_SLACK_FRACTION).toBe(0.001);
  });
});

describe("reported numbers", () => {
  it("snaps floating-point noise out of dollar figures", () => {
    const feePlan = optimizeHedge(fixtureRequest({ takerFeeRate: 0.07 }));

    expect(feePlan.worstCaseBefore).toBe(-51.2);
    expect(feePlan.worstCaseAfter).toBe(-10);
    expect(feePlan.totalCost).toBe(2.6);
    feePlan.outcomes.forEach((outcome) => {
      expect(Number(outcome.hedgedPnl.toFixed(9))).toBe(outcome.hedgedPnl);
      expect(Number(outcome.unhedgedPnl.toFixed(9))).toBe(outcome.unhedgedPnl);
    });
  });
});

describe("input validation", () => {
  it.each([
    ["yesBid", Number.NaN],
    ["yesBid", 1.2],
    ["yesAsk", -0.1],
    ["yesAsk", Number.POSITIVE_INFINITY],
    ["yesBidSize", Number.NaN],
    ["yesAskSize", -5],
  ] as const)("rejects %s = %s with a RangeError naming the rung and field", (field, value) => {
    const ladder = withFixtureRungs((rung) => (rung.strike === 70 ? { ...rung, [field]: value } : rung));
    expect(() => optimizeHedge(fixtureRequest({ ladder }))).toThrow(RangeError);
    expect(() => optimizeHedge(fixtureRequest({ ladder }))).toThrow(new RegExp(`strike 70\\): ${field} must be`));
    expect(() => maxHedgeableQuantity(fixtureRequest({ ladder, assumedDepth: 50 }), 0.02)).toThrow(RangeError);
  });

  it("rejects non-finite exposure and loss values", () => {
    expect(() => optimizeHedge(fixtureRequest({ maxLoss: Number.NaN }))).toThrow(RangeError);
    expect(() =>
      optimizeHedge(fixtureRequest({ exposure: { ...SOL_FIXTURE_EXPOSURE, spot: Number.NaN } })),
    ).toThrow(RangeError);
    expect(() =>
      optimizeHedge(fixtureRequest({ exposure: { ...SOL_FIXTURE_EXPOSURE, quantity: Number.POSITIVE_INFINITY } })),
    ).toThrow(RangeError);
  });

  it("rejects unsorted, duplicate and empty ladders with a RangeError", () => {
    const duplicate: Ladder = {
      ...SOL_FIXTURE_LADDER,
      rungs: [makeFixtureRung(70, 0.9, 0.95), makeFixtureRung(70, 0.8, 0.85)],
    };
    const reversed: Ladder = { ...SOL_FIXTURE_LADDER, rungs: [...SOL_FIXTURE_LADDER.rungs].reverse() };
    const empty: Ladder = { ...SOL_FIXTURE_LADDER, rungs: [] };

    [duplicate, reversed, empty].forEach((ladder) => {
      expect(() => optimizeHedge(fixtureRequest({ ladder }))).toThrow(RangeError);
      expect(() => maxHedgeableQuantity(fixtureRequest({ ladder, assumedDepth: 50 }), 0.02)).toThrow(RangeError);
      expect(() => bestAchievableWorstCase(fixtureRequest({ ladder }))).toThrow(RangeError);
    });
    expect(() => optimizeHedge(fixtureRequest({ ladder: reversed }))).toThrow(/strictly increasing/);
  });
});

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
 * Draws a price in whole cents strictly between 0 and 1.
 *
 * @param {() => number} random - Uniform generator.
 * @returns {number} A price in [0.01, 0.99].
 */
function randomCents(random: () => number): number {
  return (1 + Math.floor(random() * 99)) / 100;
}

/**
 * Builds a random small ladder and request for the property test.
 *
 * @param {() => number} random - Uniform generator.
 * @returns {HedgeRequest} A random but valid request.
 */
function randomRequest(random: () => number): HedgeRequest {
  const rungCount = 1 + Math.floor(random() * 6);
  const baseStrike = 50 + Math.floor(random() * 100);
  const spacing = [0.5, 1, 2, 5][Math.floor(random() * 4)];
  const increment = [0.01, 0.1, 1][Math.floor(random() * 3)];
  const rungs: LadderRung[] = [];
  for (let index = 0; index < rungCount; index += 1) {
    const hasBid = random() < 0.7;
    const hasAsk = random() < 0.7;
    const bid = hasBid ? randomCents(random) : null;
    let ask = hasAsk ? randomCents(random) : null;
    if (bid !== null && ask !== null && ask <= bid && random() < 0.8) {
      ask = Math.min(0.99, bid + 0.01);
    }
    rungs.push({
      instrumentSymbol: `RAND-${index}`,
      label: `rung ${index}`,
      strike: baseStrike + index * spacing,
      yesBid: bid,
      yesAsk: ask,
      yesBidSize: random() < 0.5 ? Math.round(random() * 400) / 10 : null,
      yesAskSize: random() < 0.5 ? Math.round(random() * 400) / 10 : null,
      quantityIncrement: increment,
    });
  }
  const ladder: Ladder = { ...SOL_FIXTURE_LADDER, eventTicker: "RAND", rungs };
  const spot = baseStrike + (random() * (rungCount + 1) - 0.5) * spacing;
  const quantity = Math.round(random() * 200) / 10;
  const worstExposure = Math.max(0, quantity * (spot - (baseStrike - spacing)));
  return {
    ladder,
    exposure: { asset: "SOL", quantity, spot },
    maxLoss: Math.round(random() * worstExposure * 100) / 100,
    stressPrice: null,
    takerFeeRate: random() < 0.5 ? 0 : GEMINI_TAKER_FEE_RATE,
    assumedDepth: random() < 0.5 ? null : Math.round(random() * 500) / 10,
  };
}

/**
 * Returns the cap the plan rules give a leg: the lifted side's size, else assumed depth, else none.
 *
 * @param {LadderRung} rung - The leg's rung.
 * @param {"yes" | "no"} side - The leg's side.
 * @param {number | null} assumedDepth - Depth assumed when the size is unknown.
 * @returns {number} The cap, or Infinity when unlimited.
 */
function capFor(rung: LadderRung, side: "yes" | "no", assumedDepth: number | null): number {
  const size = side === "yes" ? rung.yesAskSize : rung.yesBidSize;
  if (size !== null) {
    return size;
  }
  return assumedDepth ?? Number.POSITIVE_INFINITY;
}

/** Number of random requests the property test checks. */
const PROPERTY_TRIALS = 2000;

describe("optimizeHedge randomized properties", () => {
  it("keeps every invariant across seeded random ladders", () => {
    const random = mulberry32(20261119);
    const statusCounts: Record<string, number> = {};
    for (let trial = 0; trial < PROPERTY_TRIALS; trial += 1) {
      const request = randomRequest(random);
      let plan: HedgePlan;
      try {
        plan = optimizeHedge(request);
      } catch (error) {
        throw new Error(`trial ${trial} threw ${String(error)} for request ${JSON.stringify(request)}`);
      }
      const context = `trial ${trial}: ${JSON.stringify({ request, plan: { status: plan.status, legs: plan.legs } })}`;
      statusCounts[plan.status] = (statusCounts[plan.status] ?? 0) + 1;

      expect(plan.outcomes, context).toHaveLength(request.ladder.rungs.length + 1);
      plan.outcomes.forEach((outcome) => {
        const unhedged = request.exposure.quantity * (outcome.evalPrice - request.exposure.spot);
        expect(Math.abs(outcome.unhedgedPnl - unhedged), context).toBeLessThan(1e-9);
        const payout = plan.legs
          .filter((leg) => legPaysAtPrice(leg.side, leg.strike, outcome.evalPrice))
          .reduce((total, leg) => total + leg.quantity, 0);
        expect(Math.abs(outcome.hedgePayout - payout), context).toBeLessThan(1e-9);
        expect(
          Math.abs(outcome.hedgedPnl - (outcome.unhedgedPnl + outcome.hedgePayout - plan.totalCost)),
          context,
        ).toBeLessThan(1e-9);
      });
      expectConsistentOutcomes(plan);

      plan.legs.forEach((leg) => {
        const rung = request.ladder.rungs.find((candidate) => candidate.strike === leg.strike);
        expect(rung, context).toBeDefined();
        if (rung === undefined) {
          return;
        }
        if (leg.side === "yes") {
          expect(rung.yesAsk, context).not.toBeNull();
          expect(leg.price, context).toBeCloseTo(rung.yesAsk ?? Number.NaN, 9);
        } else {
          expect(rung.yesBid, context).not.toBeNull();
          expect(leg.price, context).toBeCloseTo(1 - (rung.yesBid ?? Number.NaN), 9);
        }
        expect(leg.quantity, context).toBeGreaterThan(0);
        expect(leg.quantity, context).toBeLessThanOrEqual(capFor(rung, leg.side, request.assumedDepth) + 1e-9);
        const steps = leg.quantity / rung.quantityIncrement;
        expect(Math.abs(steps - Math.round(steps)), context).toBeLessThan(1e-6);
        expect(leg.fee, context).toBeGreaterThanOrEqual(0);
      });

      if (plan.status === "optimal") {
        expect(plan.worstCaseAfter, context).toBeGreaterThanOrEqual(-request.maxLoss - FLOOR_TOLERANCE);
        expect(plan.legs.length, context).toBeGreaterThan(0);
      }
      if (plan.status === "no-hedge-needed") {
        expect(plan.worstCaseBefore, context).toBeGreaterThanOrEqual(-request.maxLoss - FLOOR_TOLERANCE);
        expect(plan.legs, context).toEqual([]);
      }
      if (plan.status === "best-effort") {
        expect(plan.worstCaseAfter, context).toBeGreaterThan(plan.worstCaseBefore);
        expect(plan.worstCaseAfter, context).toBeLessThan(-request.maxLoss);
      }
      if (plan.status === "unhedgeable") {
        expect(plan.legs, context).toEqual([]);
        expect(plan.worstCaseAfter, context).toBe(plan.worstCaseBefore);
      }
    }
    expect(statusCounts.optimal ?? 0).toBeGreaterThan(20);
    expect(statusCounts["best-effort"] ?? 0).toBeGreaterThan(20);
  });
});
