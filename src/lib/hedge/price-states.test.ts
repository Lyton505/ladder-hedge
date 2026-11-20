import { describe, expect, it } from "vitest";
import { buildPriceStates, defaultStressPrice, legPaysAtPrice, resolveStressPrice } from "@/lib/hedge/price-states";
import { SOL_FIXTURE_EXPOSURE, SOL_FIXTURE_LADDER, makeFixtureRung } from "@/lib/hedge/test-fixtures";

describe("resolveStressPrice", () => {
  it("keeps the ladder default when spot is inside the ladder", () => {
    expect(resolveStressPrice(SOL_FIXTURE_LADDER, SOL_FIXTURE_EXPOSURE, null)).toBe(67);
  });

  it("moves one gap below spot when spot is below the ladder", () => {
    expect(resolveStressPrice(SOL_FIXTURE_LADDER, { ...SOL_FIXTURE_EXPOSURE, spot: 60 }, null)).toBe(59);
    expect(resolveStressPrice(SOL_FIXTURE_LADDER, { ...SOL_FIXTURE_EXPOSURE, spot: 66.5 }, null)).toBe(65.5);
  });

  it("uses a supplied stress price as given", () => {
    expect(resolveStressPrice(SOL_FIXTURE_LADDER, { ...SOL_FIXTURE_EXPOSURE, spot: 60 }, 64)).toBe(64);
  });

  it("never goes below zero when spot is smaller than one strike gap", () => {
    expect(resolveStressPrice(SOL_FIXTURE_LADDER, { ...SOL_FIXTURE_EXPOSURE, spot: 0.5 }, null)).toBe(0);
    expect(resolveStressPrice(SOL_FIXTURE_LADDER, { ...SOL_FIXTURE_EXPOSURE, spot: 1 }, null)).toBe(0);
    expect(resolveStressPrice(SOL_FIXTURE_LADDER, { ...SOL_FIXTURE_EXPOSURE, spot: 1.5 }, null)).toBe(0.5);
  });

  it("never goes below zero when the lowest strike is below the median gap", () => {
    const ladder = {
      ...SOL_FIXTURE_LADDER,
      rungs: [makeFixtureRung(1, 0.9, 0.95), makeFixtureRung(5, 0.5, 0.6), makeFixtureRung(9, 0.1, 0.2)],
    };
    // The ladder default alone is 1 - 4 = -3; spot 6 gives a spot term of 2.
    expect(defaultStressPrice(ladder)).toBe(-3);
    const stress = resolveStressPrice(ladder, { ...SOL_FIXTURE_EXPOSURE, spot: 6 }, null);
    expect(stress).toBe(0);
    expect(buildPriceStates(ladder, stress)[0].evalPrice).toBe(0);
  });
});

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

  it("throws a RangeError unless strikes are strictly increasing", () => {
    const duplicate = { ...SOL_FIXTURE_LADDER, rungs: [makeFixtureRung(70, 0.9, 0.95), makeFixtureRung(70, 0.8, 0.85)] };
    const reversed = { ...SOL_FIXTURE_LADDER, rungs: [makeFixtureRung(75, 0.1, 0.2), makeFixtureRung(70, 0.8, 0.85)] };
    expect(() => buildPriceStates(duplicate, null)).toThrow(RangeError);
    expect(() => buildPriceStates(reversed, null)).toThrow(/strictly increasing/);
  });

  it("throws a RangeError for an empty ladder or a non-finite quote", () => {
    expect(() => buildPriceStates({ ...SOL_FIXTURE_LADDER, rungs: [] }, null)).toThrow(RangeError);
    const nanAsk = { ...SOL_FIXTURE_LADDER, rungs: [makeFixtureRung(70, 0.5, Number.NaN)] };
    expect(() => buildPriceStates(nanAsk, null)).toThrow(/yesAsk/);
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
