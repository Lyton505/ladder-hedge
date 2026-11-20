import { describe, expect, it } from "vitest";
import { impliedDistribution, medianStrikeGap } from "@/lib/hedge/implied-distribution";
import { SOL_FIXTURE_LADDER, makeFixtureRung, withFixtureRungs } from "@/lib/hedge/test-fixtures";
import type { Ladder } from "@/lib/hedge/types";

/**
 * Sums a list of numbers.
 *
 * @param {number[]} values - Numbers to add.
 * @returns {number} Their sum.
 */
function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

describe("impliedDistribution", () => {
  it("matches the hand-worked survival and bucket probabilities for the fixture", () => {
    const distribution = impliedDistribution(SOL_FIXTURE_LADDER);
    const expectedSurvival = [0.978333, 0.978333, 0.978333, 0.975, 0.735, 0.023333, 0.023333, 0.023333];
    const expectedBuckets = [0.021667, 0, 0, 0.003333, 0.24, 0.711667, 0, 0, 0.023333];

    expect(distribution.strikes).toEqual([68, 69, 70, 71, 72, 73, 74, 75]);
    expect(distribution.survival).toHaveLength(expectedSurvival.length);
    distribution.survival.forEach((value, index) => {
      expect(value).toBeCloseTo(expectedSurvival[index], 5);
    });
    expect(distribution.bucketProbabilities).toHaveLength(expectedBuckets.length);
    distribution.bucketProbabilities.forEach((value, index) => {
      expect(value).toBeCloseTo(expectedBuckets[index], 5);
    });
    expect(Math.abs(sum(distribution.bucketProbabilities) - 1)).toBeLessThan(1e-9);
  });

  it("interpolates a fully unquoted middle rung between its neighbours", () => {
    const ladder: Ladder = {
      ...SOL_FIXTURE_LADDER,
      rungs: [makeFixtureRung(100, 0.8, 0.9), makeFixtureRung(110, null, null), makeFixtureRung(120, 0.2, 0.3)],
    };
    const distribution = impliedDistribution(ladder);

    expect(distribution.survival[0]).toBeCloseTo(0.85, 9);
    expect(distribution.survival[1]).toBeCloseTo(0.55, 9);
    expect(distribution.survival[2]).toBeCloseTo(0.25, 9);
    expect(Math.abs(sum(distribution.bucketProbabilities) - 1)).toBeLessThan(1e-9);
  });

  it("does not throw on a ladder with no quotes and still sums to 1", () => {
    const ladder = withFixtureRungs((rung) => ({ ...rung, yesBid: null, yesAsk: null }));
    const distribution = impliedDistribution(ladder);

    expect(distribution.bucketProbabilities).toHaveLength(9);
    expect(Math.abs(sum(distribution.bucketProbabilities) - 1)).toBeLessThan(1e-9);
    distribution.bucketProbabilities.forEach((value) => {
      expect(value).toBeGreaterThanOrEqual(0);
    });
    for (let index = 1; index < distribution.survival.length; index += 1) {
      expect(distribution.survival[index]).toBeLessThanOrEqual(distribution.survival[index - 1]);
    }
  });

  it("returns a single bucket of probability 1 for a ladder with no rungs", () => {
    const distribution = impliedDistribution({ ...SOL_FIXTURE_LADDER, rungs: [] });

    expect(distribution.strikes).toEqual([]);
    expect(distribution.survival).toEqual([]);
    expect(distribution.bucketProbabilities).toEqual([1]);
  });
});

describe("medianStrikeGap", () => {
  it("is 1 for the fixture and 1 percent of the strike for a one-rung ladder", () => {
    expect(medianStrikeGap([68, 69, 70, 71, 72, 73, 74, 75])).toBe(1);
    expect(medianStrikeGap([200])).toBeCloseTo(2, 12);
    expect(medianStrikeGap([10, 11, 13, 16])).toBe(2);
  });
});
