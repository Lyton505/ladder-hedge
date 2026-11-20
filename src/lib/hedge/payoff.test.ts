import { describe, expect, it } from "vitest";
import { optimizeHedge } from "@/lib/hedge/optimize-hedge";
import { evaluatePayoffAt, payoffCurve } from "@/lib/hedge/payoff";
import { legPaysAtPrice } from "@/lib/hedge/price-states";
import { SOL_FIXTURE_EXPOSURE, SOL_FIXTURE_LADDER } from "@/lib/hedge/test-fixtures";
import type { HedgeLeg, HedgePlan } from "@/lib/hedge/types";

/** One NO leg at strike 71, quantity 10, total cost 0.5, as in the plan's example. */
const NO_71_LEG: HedgeLeg = {
  instrumentSymbol: "SOL-FIXTURE-71",
  strike: 71,
  side: "no",
  quantity: 10,
  price: 0.05,
  fee: 0,
  cost: 0.5,
};

/**
 * Solves the fixture's $10 floor request with zero fees.
 *
 * @returns {HedgePlan} The fixture plan.
 */
function fixturePlan(): HedgePlan {
  return optimizeHedge({
    ladder: SOL_FIXTURE_LADDER,
    exposure: SOL_FIXTURE_EXPOSURE,
    maxLoss: 10,
    stressPrice: null,
    takerFeeRate: 0,
    assumedDepth: null,
  });
}

describe("evaluatePayoffAt", () => {
  it("adds the paying legs and subtracts the total cost", () => {
    const point = evaluatePayoffAt(70.5, SOL_FIXTURE_EXPOSURE, [NO_71_LEG], 0.5);

    expect(point.price).toBe(70.5);
    expect(Math.abs(point.unhedged - -16.2)).toBeLessThan(1e-9);
    expect(Math.abs(point.hedged - -6.7)).toBeLessThan(1e-9);
  });

  it("stops the NO payout at the strike itself", () => {
    const atStrike = evaluatePayoffAt(71, SOL_FIXTURE_EXPOSURE, [NO_71_LEG], 0.5);
    expect(Math.abs(atStrike.hedged - (atStrike.unhedged - 0.5))).toBeLessThan(1e-9);
  });

  it("follows the plan's leg payment rule", () => {
    expect(legPaysAtPrice("yes", 72, 72)).toBe(true);
    expect(legPaysAtPrice("no", 72, 72)).toBe(false);
  });
});

describe("payoffCurve", () => {
  it("is sorted, hits every strike, and has strictly increasing unhedged values", () => {
    const plan = fixturePlan();
    const curve = payoffCurve(plan, SOL_FIXTURE_EXPOSURE, SOL_FIXTURE_LADDER, 50);

    for (let index = 1; index < curve.length; index += 1) {
      expect(curve[index].price).toBeGreaterThan(curve[index - 1].price);
      expect(curve[index].unhedged).toBeGreaterThan(curve[index - 1].unhedged);
    }
    SOL_FIXTURE_LADDER.rungs.forEach((rung) => {
      expect(curve.some((point) => point.price === rung.strike)).toBe(true);
      expect(curve.some((point) => point.price < rung.strike && point.price > rung.strike - 1e-3)).toBe(true);
    });
    expect(curve[0].price).toBeCloseTo(plan.stressPrice - 1, 9);
    expect(curve[curve.length - 1].price).toBeCloseTo(76, 9);
  });

  it("agrees with evaluatePayoffAt at every point", () => {
    const plan = fixturePlan();
    const curve = payoffCurve(plan, SOL_FIXTURE_EXPOSURE, SOL_FIXTURE_LADDER, 25);

    curve.forEach((point) => {
      const expected = evaluatePayoffAt(point.price, SOL_FIXTURE_EXPOSURE, plan.legs, plan.totalCost);
      expect(point.hedged).toBeCloseTo(expected.hedged, 12);
      expect(point.unhedged).toBeCloseTo(expected.unhedged, 12);
    });
  });

  it("does not duplicate prices when the even grid lands on strikes", () => {
    const plan = fixturePlan();
    const curve = payoffCurve(plan, SOL_FIXTURE_EXPOSURE, SOL_FIXTURE_LADDER, 11);
    const prices = curve.map((point) => point.price);

    expect(new Set(prices).size).toBe(prices.length);
    expect(prices.filter((price) => price === 68)).toHaveLength(1);
  });

  it("matches the plan's worst case at each state's evaluation price", () => {
    const plan = fixturePlan();
    plan.outcomes.forEach((outcome) => {
      const point = evaluatePayoffAt(outcome.evalPrice, SOL_FIXTURE_EXPOSURE, plan.legs, plan.totalCost);
      expect(point.hedged).toBeCloseTo(outcome.hedgedPnl, 9);
    });
  });

  it("rejects fewer than two points", () => {
    expect(() => payoffCurve(fixturePlan(), SOL_FIXTURE_EXPOSURE, SOL_FIXTURE_LADDER, 1)).toThrow(RangeError);
  });
});
