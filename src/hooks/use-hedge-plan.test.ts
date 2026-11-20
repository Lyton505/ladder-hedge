// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SOL_FIXTURE_EXPOSURE, SOL_FIXTURE_LADDER, withFixtureRungs } from "@/lib/hedge/test-fixtures";
import type { Exposure, Ladder } from "@/lib/hedge/types";
import { MAX_HEDGEABLE_DEBOUNCE_MS, useHedgePlan, type HedgePlanInputs } from "./use-hedge-plan";

/**
 * Builds hook inputs for the fixture ladder.
 *
 * @param {Partial<HedgePlanInputs>} [overrides] - Fields to replace.
 * @returns {HedgePlanInputs} The inputs.
 */
function inputs(overrides: Partial<HedgePlanInputs> = {}): HedgePlanInputs {
  return {
    ladder: SOL_FIXTURE_LADDER,
    exposure: SOL_FIXTURE_EXPOSURE,
    maxLossFraction: 0.015,
    takerFeeRate: 0.07,
    assumedDepth: 100,
    ...overrides,
  };
}

/** A fixture ladder with one invalid quote, which every engine entry point rejects with a RangeError. */
const BAD_LADDER: Ladder = withFixtureRungs((rung) => (rung.strike === 70 ? { ...rung, yesBid: Number.NaN } : rung));

/**
 * Lets the debounced largest-hedgeable computation run.
 *
 * @returns {void}
 */
function flushMaxHedgeable(): void {
  act(() => {
    vi.advanceTimersByTime(MAX_HEDGEABLE_DEBOUNCE_MS + 50);
  });
}

describe("useHedgePlan", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("turns engine RangeErrors into readable messages instead of throwing", () => {
    const { result } = renderHook(() => useHedgePlan(inputs({ ladder: BAD_LADDER })));
    expect(result.current.plan).toBeNull();
    expect(result.current.error).toMatch(/^The optimiser could not price this ladder: .*strike 70.*yesBid/);
    expect(result.current.states).toEqual([]);
    expect(result.current.payoff).toEqual([]);
    expect(result.current.coherence).toEqual([]);
    expect(result.current.coherenceError).toMatch(/^The quotes could not be checked against each other: .*strike 70/);
    flushMaxHedgeable();
    expect(result.current.maxHedgeableStatus).toBe("error");
    expect(result.current.maxHedgeable).toBeNull();
  });

  it("does not call the engine with a zero or negative quantity or spot", () => {
    for (const exposure of [
      { asset: "SOL", quantity: 0, spot: 72.12 },
      { asset: "SOL", quantity: -1, spot: 72.12 },
      { asset: "SOL", quantity: 10, spot: 0 },
    ]) {
      const { result } = renderHook(() => useHedgePlan(inputs({ exposure })));
      expect(result.current.plan).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.maxHedgeableStatus).toBe("idle");
    }
  });

  it("reports Infinity as the largest hedgeable quantity when no hedge is needed at the floor", () => {
    const { result } = renderHook(() => useHedgePlan(inputs({ maxLossFraction: 0.1 })));
    expect(result.current.plan?.status).toBe("no-hedge-needed");
    flushMaxHedgeable();
    expect(result.current.maxHedgeableStatus).toBe("ready");
    expect(result.current.maxHedgeable).toBe(Number.POSITIVE_INFINITY);
  });

  it("draws the distribution and payoff from the stress price the plan used when spot is below the ladder", () => {
    const exposure: Exposure = { asset: "SOL", quantity: 10, spot: 60 };
    const { result } = renderHook(() => useHedgePlan(inputs({ exposure, maxLossFraction: 1 / 600 })));
    const plan = result.current.plan;
    expect(plan?.status).toBe("optimal");
    expect(plan?.stressPrice).toBe(59);
    expect(result.current.states[0].evalPrice).toBe(59);
    // payoffCurve starts one median strike gap ($1) below the plan's stress price.
    expect(result.current.payoff[0].price).toBe(58);
  });
});
