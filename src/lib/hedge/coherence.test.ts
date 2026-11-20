import { describe, expect, it } from "vitest";
import { checkCoherence } from "@/lib/hedge/coherence";
import { SOL_FIXTURE_LADDER, makeFixtureRung } from "@/lib/hedge/test-fixtures";
import type { Ladder } from "@/lib/hedge/types";

describe("checkCoherence", () => {
  it("finds exactly the 68/69 bid inversion and the 73/74 ask inversion on the fixture", () => {
    const findings = checkCoherence(SOL_FIXTURE_LADDER);

    expect(findings).toHaveLength(2);
    expect(findings.some((finding) => finding.kind === "arbitrage")).toBe(false);

    const bidInversion = findings.find((finding) => finding.kind === "bid-inversion");
    expect(bidInversion).toMatchObject({ lowerStrike: 68, higherStrike: 69 });
    expect(bidInversion?.edge).toBeCloseTo(0.03, 9);

    const askInversion = findings.find((finding) => finding.kind === "ask-inversion");
    expect(askInversion).toMatchObject({ lowerStrike: 73, higherStrike: 74 });
    expect(askInversion?.edge).toBeCloseTo(0.01, 9);

    expect(findings[0].edge).toBeGreaterThanOrEqual(findings[1].edge);
    findings.forEach((finding) => {
      expect(finding.detail.length).toBeGreaterThan(0);
      expect(finding.detail).toContain(String(finding.lowerStrike));
      expect(finding.detail).toContain(String(finding.higherStrike));
    });
  });

  it("reports an executable arbitrage first, with the edge net of taker fees", () => {
    const ladder: Ladder = {
      ...SOL_FIXTURE_LADDER,
      rungs: [makeFixtureRung(100, 0.3, 0.4), makeFixtureRung(110, 0.45, 0.5)],
    };
    const findings = checkCoherence(ladder);
    const arbitrages = findings.filter((finding) => finding.kind === "arbitrage");

    expect(arbitrages).toHaveLength(1);
    expect(findings[0].kind).toBe("arbitrage");
    expect(findings[0]).toMatchObject({ lowerStrike: 100, higherStrike: 110 });
    // Gross 0.45 - 0.40 = 0.05; fees 0.07 * 0.40 * 0.60 = 0.0168 (YES) and 0.07 * 0.55 * 0.45 = 0.017325 (NO).
    expect(findings[0].edge).toBeCloseTo(0.015875, 9);
    expect(findings[0].detail).toContain("$0.0500");
    expect(findings[0].detail).toContain("$0.0159");
  });

  it("reports the gross edge when the fee rate is zero", () => {
    const ladder: Ladder = {
      ...SOL_FIXTURE_LADDER,
      rungs: [makeFixtureRung(100, 0.3, 0.4), makeFixtureRung(110, 0.45, 0.5)],
    };
    const findings = checkCoherence(ladder, 0);

    expect(findings[0].kind).toBe("arbitrage");
    expect(findings[0].edge).toBeCloseTo(0.05, 9);
  });

  it("does not report a one-cent gross edge near 50 cents that fees wipe out", () => {
    const ladder: Ladder = {
      ...SOL_FIXTURE_LADDER,
      rungs: [makeFixtureRung(100, 0.45, 0.5), makeFixtureRung(110, 0.51, 0.6)],
    };
    // Gross 0.51 - 0.50 = 0.01; fees 0.07 * 0.5 * 0.5 + 0.07 * 0.49 * 0.51 = 0.034993, so net is negative.
    expect(checkCoherence(ladder).filter((finding) => finding.kind === "arbitrage")).toEqual([]);
    expect(checkCoherence(ladder, 0).filter((finding) => finding.kind === "arbitrage")).toHaveLength(1);
  });

  it("reports a crossed book on a single rung as arbitrage at that strike", () => {
    const ladder: Ladder = {
      ...SOL_FIXTURE_LADDER,
      rungs: [makeFixtureRung(100, 0.6, 0.5), makeFixtureRung(110, 0.2, 0.25)],
    };
    const arbitrages = checkCoherence(ladder).filter((finding) => finding.kind === "arbitrage");

    expect(arbitrages).toHaveLength(1);
    expect(arbitrages[0]).toMatchObject({ lowerStrike: 100, higherStrike: 100 });
    // Gross 0.60 - 0.50 = 0.10; fees 0.07 * 0.5 * 0.5 + 0.07 * 0.4 * 0.6 = 0.0343.
    expect(arbitrages[0].edge).toBeCloseTo(0.0657, 9);
    expect(arbitrages[0].detail).toContain("crossed");
  });

  it("rejects invalid quotes and unsorted strikes with a RangeError", () => {
    const nanBid: Ladder = { ...SOL_FIXTURE_LADDER, rungs: [makeFixtureRung(100, Number.NaN, 0.5)] };
    expect(() => checkCoherence(nanBid)).toThrow(RangeError);
    const unsorted: Ladder = {
      ...SOL_FIXTURE_LADDER,
      rungs: [makeFixtureRung(110, 0.5, 0.6), makeFixtureRung(100, 0.7, 0.8)],
    };
    expect(() => checkCoherence(unsorted)).toThrow(RangeError);
    expect(() => checkCoherence(SOL_FIXTURE_LADDER, -0.1)).toThrow(RangeError);
  });

  it("checks arbitrage across non-adjacent rungs and returns nothing for a coherent ladder", () => {
    const arbitrageLadder: Ladder = {
      ...SOL_FIXTURE_LADDER,
      rungs: [makeFixtureRung(100, 0.5, 0.6), makeFixtureRung(105, 0.5, 0.55), makeFixtureRung(110, 0.62, 0.7)],
    };
    const arbitrages = checkCoherence(arbitrageLadder, 0).filter((finding) => finding.kind === "arbitrage");
    expect(arbitrages.map((finding) => [finding.lowerStrike, finding.higherStrike])).toEqual([
      [105, 110],
      [100, 110],
    ]);

    const coherent: Ladder = {
      ...SOL_FIXTURE_LADDER,
      rungs: [makeFixtureRung(100, 0.8, 0.85), makeFixtureRung(105, 0.5, 0.55), makeFixtureRung(110, 0.1, null)],
    };
    expect(checkCoherence(coherent)).toEqual([]);
  });

  it("does not throw on unquoted rungs or an empty ladder", () => {
    const unquoted: Ladder = {
      ...SOL_FIXTURE_LADDER,
      rungs: [makeFixtureRung(100, null, null), makeFixtureRung(110, null, null)],
    };
    expect(checkCoherence(unquoted)).toEqual([]);
    expect(checkCoherence({ ...SOL_FIXTURE_LADDER, rungs: [] })).toEqual([]);
  });
});
