import { describe, expect, it } from "vitest";
import type { HedgePlan, Ladder, LadderSummary, PaperFill } from "@/lib/hedge/types";
import { SOL_FIXTURE_LADDER } from "@/lib/hedge/test-fixtures";
import {
  chooseDefaultLadder,
  countTwoSidedRungs,
  ladderDepthBasis,
  ladderHorizon,
  matchVerifiedSignatures,
  planDepthBasis,
  spotPosition,
} from "./workbench-model";

const NOW_MS = Date.parse("2026-11-20T05:30:00Z");

/**
 * Builds a ladder summary for tests.
 *
 * @param {Partial<LadderSummary> & { eventTicker: string }} fields - Fields to override.
 * @returns {LadderSummary} The summary.
 */
function summary(fields: Partial<LadderSummary> & { eventTicker: string }): LadderSummary {
  return {
    title: "SOL price on November 20",
    asset: "SOL",
    expiry: "2026-11-20T22:00:00.000Z",
    rungCount: 10,
    quotedRungCount: 10,
    source: "live",
    ...fields,
  };
}

const HOURLY = summary({
  eventTicker: "SOL2611200600",
  title: "SOL price today at 1am EST",
  expiry: "2026-11-20T06:00:00.000Z",
});
const DAILY = summary({ eventTicker: "SOL2611202200" });
const MONTHLY = summary({
  eventTicker: "SOL2611302200",
  title: "SOL price on November 30",
  expiry: "2026-11-30T22:00:00.000Z",
});
const SNAP_EXPIRED = summary({
  eventTicker: "SOL2611200500-SNAPSHOT",
  expiry: "2026-11-20T05:00:00.000Z",
  source: "snapshot",
});
const SNAP_OPEN = summary({ eventTicker: "SOL2611202200-SNAPSHOT", source: "snapshot" });

describe("ladderHorizon", () => {
  it("classifies hourly, daily and month-end ladders", () => {
    expect(ladderHorizon(HOURLY)).toBe("hourly");
    expect(ladderHorizon(DAILY)).toBe("daily");
    expect(ladderHorizon(MONTHLY)).toBe("month-end");
  });
});

describe("chooseDefaultLadder", () => {
  it("prefers the live ladder with the most two-sided rungs over the soonest expiry", () => {
    const counts = new Map([
      ["SOL2611200600", 1],
      ["SOL2611202200", 12],
      ["SOL2611302200", 10],
    ]);
    expect(chooseDefaultLadder([HOURLY, DAILY, MONTHLY, SNAP_OPEN], counts, NOW_MS)).toBe("SOL2611202200");
  });

  it("breaks ties on the later expiry", () => {
    const counts = new Map([
      ["SOL2611202200", 10],
      ["SOL2611302200", 10],
    ]);
    expect(chooseDefaultLadder([DAILY, MONTHLY], counts, NOW_MS)).toBe("SOL2611302200");
  });

  it("falls back to the first unexpired snapshot when no live ladder is well quoted", () => {
    const counts = new Map([["SOL2611200600", 1]]);
    expect(chooseDefaultLadder([HOURLY, SNAP_EXPIRED, SNAP_OPEN], counts, NOW_MS)).toBe(
      "SOL2611202200-SNAPSHOT",
    );
  });

  it("uses an expired snapshot only when nothing else exists, and null for an empty list", () => {
    expect(chooseDefaultLadder([SNAP_EXPIRED], new Map(), NOW_MS)).toBe("SOL2611200500-SNAPSHOT");
    expect(chooseDefaultLadder([], new Map(), NOW_MS)).toBeNull();
  });
});

describe("depth basis", () => {
  it("reports assumed for the fixture, whose sizes are all unknown", () => {
    expect(countTwoSidedRungs(SOL_FIXTURE_LADDER)).toBe(3);
    expect(ladderDepthBasis(SOL_FIXTURE_LADDER)).toBe("assumed");
  });

  it("reports mixed and measured from the sides a plan lifts", () => {
    const sized: Ladder = {
      ...SOL_FIXTURE_LADDER,
      rungs: SOL_FIXTURE_LADDER.rungs.map((rung) =>
        rung.strike === 72 ? { ...rung, yesBidSize: 25, yesAskSize: null } : rung,
      ),
    };
    const legAt = (strike: number, side: "yes" | "no") => {
      const rung = sized.rungs.find((candidate) => candidate.strike === strike);
      if (rung === undefined) {
        throw new Error(`no rung ${strike}`);
      }
      return { instrumentSymbol: rung.instrumentSymbol, strike, side, quantity: 1, price: 0.3, fee: 0, cost: 0.3 };
    };
    expect(ladderDepthBasis(sized)).toBe("mixed");
    expect(planDepthBasis(sized, [legAt(72, "no")])).toBe("measured");
    expect(planDepthBasis(sized, [legAt(72, "no"), legAt(71, "no")])).toBe("mixed");
    expect(planDepthBasis(sized, [legAt(72, "yes")])).toBe("assumed");
    expect(planDepthBasis(sized, [])).toBe("none");
  });
});

describe("spotPosition", () => {
  it("places spot below, inside or above the strikes", () => {
    expect(spotPosition(SOL_FIXTURE_LADDER, 60)).toBe("below");
    expect(spotPosition(SOL_FIXTURE_LADDER, 72.12)).toBe("inside");
    expect(spotPosition(SOL_FIXTURE_LADDER, 80)).toBe("above");
  });
});

describe("matchVerifiedSignatures", () => {
  const plan: HedgePlan = {
    status: "optimal",
    legs: [],
    totalCost: 2.4,
    outcomes: [],
    worstCaseBefore: -51.2,
    worstCaseAfter: -10,
    expectedHedgePayout: 1,
    requestedMaxLoss: 10,
    stressPrice: 67,
  };
  const hash = "a".repeat(64);
  const fill: PaperFill = {
    id: "f1",
    createdAt: "2026-11-20T05:00:00.000Z",
    eventTicker: "SOL2611202200",
    exposure: { asset: "SOL", quantity: 10, spot: 72 },
    plan,
    planHash: hash,
    memo: "",
    signature: "sig-1",
  };

  it("matches receipts by ticker and hash prefix, ignoring unrelated memos", () => {
    const receipts = [
      { signature: "sig-1", memo: `LH1|SOL2611202200|q=10|floor=10|cost=2.40|legs=0|h=${"a".repeat(32)}`, blockTime: null, slot: 2 },
      { signature: "sig-2", memo: `LH1|SOL2611202200|q=10|floor=10|cost=2.40|legs=0|h=${"b".repeat(32)}`, blockTime: null, slot: 1 },
      { signature: "sig-3", memo: `LH1|BTC2611202200|q=10|floor=10|cost=2.40|legs=0|h=${"a".repeat(32)}`, blockTime: null, slot: 0 },
      { signature: "sig-4", memo: "hello", blockTime: null, slot: 0 },
    ];
    expect(matchVerifiedSignatures([fill], receipts)).toEqual(["sig-1"]);
  });
});
