import { describe, expect, it } from "vitest";
import { buildPriceStates, defaultStressPrice, legPaysAtPrice } from "@/lib/hedge/price-states";
import { SOL_FIXTURE_LADDER, makeFixtureRung } from "@/lib/hedge/test-fixtures";

describe("defaultStressPrice", () => {
  it("is the lowest strike minus the median gap", () => {
    expect(defaultStressPrice(SOL_FIXTURE_LADDER)).toBe(67);
  });

  it("is 0.99 of the strike for a one-rung ladder", () => {
    const ladder = { ...SOL_FIXTURE_LADDER, rungs: [makeFixtureRung(200, 0.5, 0.6)] };
    expect(defaultStressPrice(ladder)).toBeCloseTo(198, 9);
  });

  it("throws a RangeError for a ladder with no rungs", () => {
    expect(() => defaultStressPrice({ ...SOL_FIXTURE_LADDER, rungs: [] })).toThrow(RangeError);
  });
});

describe("buildPriceStates", () => {
  it("builds n + 1 states with the expected bounds and evaluation prices", () => {
    const states = buildPriceStates(SOL_FIXTURE_LADDER, null);

    expect(states).toHaveLength(9);
    expect(states[0]).toMatchObject({ index: 0, lower: null, upper: 68, evalPrice: 67 });
    expect(states[5]).toMatchObject({ index: 5, lower: 72, upper: 73, evalPrice: 72 });
    expect(states[8]).toMatchObject({ index: 8, lower: 75, upper: null, evalPrice: 75 });
    const total = states.reduce((sum, state) => sum + state.probability, 0);
    expect(Math.abs(total - 1)).toBeLessThan(1e-9);
    expect(states[5].probability).toBeCloseTo(0.711667, 5);
  });

  it("uses a supplied stress price below the lowest strike", () => {
    const states = buildPriceStates(SOL_FIXTURE_LADDER, 60);
    expect(states[0].evalPrice).toBe(60);
  });

  it("throws a RangeError for a stress price at or above the lowest strike", () => {
    expect(() => buildPriceStates(SOL_FIXTURE_LADDER, 68)).toThrow(RangeError);
    expect(() => buildPriceStates(SOL_FIXTURE_LADDER, 70)).toThrow(RangeError);
    expect(() => buildPriceStates(SOL_FIXTURE_LADDER, Number.NaN)).toThrow(RangeError);
  });

  it("builds states for a ladder with no quotes at all", () => {
    const ladder = {
      ...SOL_FIXTURE_LADDER,
      rungs: SOL_FIXTURE_LADDER.rungs.map((rung) => ({ ...rung, yesBid: null, yesAsk: null })),
    };
    expect(buildPriceStates(ladder, null)).toHaveLength(9);
  });
});

describe("legPaysAtPrice", () => {
  it("pays YES at or above the strike and NO strictly below it", () => {
    expect(legPaysAtPrice("yes", 72, 72)).toBe(true);
    expect(legPaysAtPrice("no", 72, 72)).toBe(false);
    expect(legPaysAtPrice("yes", 72, 71.99)).toBe(false);
    expect(legPaysAtPrice("no", 72, 71.99)).toBe(true);
  });
});
