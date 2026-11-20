import { describe, expect, it } from "vitest";
import type { HedgePlan, Ladder, LadderSummary, PaperFill } from "@/lib/hedge/types";
import { SOL_FIXTURE_LADDER } from "@/lib/hedge/test-fixtures";
import { optimizeHedge } from "@/lib/hedge";
import { SOL_FIXTURE_EXPOSURE } from "@/lib/hedge/test-fixtures";
import { formatUsd } from "@/components/format";
import {
  cashLimitNote,
  chooseDefaultLadder,
  classifyMaxHedgeable,
  costFigures,
  DEFAULT_MAX_OUTLAY_FRACTION,
  hedgeInputBlocker,
  countTwoSidedRungs,
  ladderDepthBasis,
  ladderHorizon,
  matchVerifiedSignatures,
  planDepthBasis,
  spotPosition,
  spotPositionNotice,
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

describe("hedgeInputBlocker", () => {
  it("blocks the engine while the quantity is blank, zero, negative or not finite", () => {
    expect(hedgeInputBlocker(null, 72.5)).toBe("quantity");
    expect(hedgeInputBlocker(0, 72.5)).toBe("quantity");
    expect(hedgeInputBlocker(-1, 72.5)).toBe("quantity");
    expect(hedgeInputBlocker(Number.NaN, 72.5)).toBe("quantity");
    expect(hedgeInputBlocker(Number.POSITIVE_INFINITY, 72.5)).toBe("quantity");
  });

  it("blocks the engine while spot is missing or unusable", () => {
    expect(hedgeInputBlocker(10, null)).toBe("spot");
    expect(hedgeInputBlocker(10, 0)).toBe("spot");
    expect(hedgeInputBlocker(10, -3)).toBe("spot");
    expect(hedgeInputBlocker(10, Number.NaN)).toBe("spot");
  });

  it("lets the engine run with a positive quantity and spot", () => {
    expect(hedgeInputBlocker(0.01, 72.5)).toBeNull();
    expect(hedgeInputBlocker(10, 61773)).toBeNull();
  });
});

describe("classifyMaxHedgeable", () => {
  it("shows Infinity as any size, never as a number", () => {
    expect(classifyMaxHedgeable(Number.POSITIVE_INFINITY)).toEqual({ kind: "any-size" });
  });

  it("keeps null as unknown and finite sizes as quantities", () => {
    expect(classifyMaxHedgeable(null)).toEqual({ kind: "unknown" });
    expect(classifyMaxHedgeable(0)).toEqual({ kind: "quantity", quantity: 0 });
    expect(classifyMaxHedgeable(54.13)).toEqual({ kind: "quantity", quantity: 54.13 });
  });

  it("marks values the engine should never return as invalid", () => {
    expect(classifyMaxHedgeable(Number.NaN)).toEqual({ kind: "invalid" });
    expect(classifyMaxHedgeable(Number.NEGATIVE_INFINITY)).toEqual({ kind: "invalid" });
    expect(classifyMaxHedgeable(-1)).toEqual({ kind: "invalid" });
  });
});

describe("spotPositionNotice", () => {
  const strikes = { lowestStrike: 68, highestStrike: 75 };

  it("returns no notice when spot is inside the strikes", () => {
    expect(
      spotPositionNotice({ position: "inside", asset: "SOL", spot: 72.12, quantity: 10, ...strikes, stressPrice: 67 }),
    ).toBeNull();
  });

  it("describes a real plan, measured to its stress price, when spot is below the ladder", () => {
    const plan = optimizeHedge({
      ladder: SOL_FIXTURE_LADDER,
      exposure: { asset: "SOL", quantity: 10, spot: 60 },
      maxLoss: 1,
      stressPrice: null,
      takerFeeRate: 0.07,
      assumedDepth: 100,
    });
    expect(plan.status).toBe("optimal");
    expect(plan.stressPrice).toBe(59);
    const notice = spotPositionNotice({
      position: spotPosition(SOL_FIXTURE_LADDER, 60),
      asset: "SOL",
      spot: 60,
      quantity: 10,
      ...strikes,
      stressPrice: plan.stressPrice,
    });
    expect(notice?.id).toBe("spot-below");
    expect(notice?.title).toBe("Spot is below every strike on this ladder");
    expect(notice?.body).toContain("SOL is at $60.00, under the lowest strike of $68.");
    expect(notice?.body).toContain("measured down to $59.00");
    expect(notice?.body).not.toContain("cannot protect");
  });

  it("still reads correctly below the ladder before a plan exists", () => {
    const notice = spotPositionNotice({ position: "below", asset: "SOL", spot: 60, quantity: 10, ...strikes, stressPrice: null });
    expect(notice?.body).toContain("Below the price the plan is measured at");
    expect(notice?.body).not.toContain("NaN");
  });

  it("states the loss of a fall to the highest strike when spot is above the ladder", () => {
    const notice = spotPositionNotice({
      position: spotPosition(SOL_FIXTURE_LADDER, 80),
      asset: "SOL",
      spot: 80,
      quantity: 10,
      ...strikes,
      stressPrice: 67,
    });
    expect(notice?.id).toBe("spot-above");
    expect(notice?.title).toBe("Spot is above every strike on this ladder");
    expect(notice?.body).toContain("SOL is at $80.00, over the highest strike of $75.");
    expect(notice?.body).toContain("a fall to $75, a loss of $50.00");
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

describe("cashLimitNote", () => {
  /**
   * Runs the engine on the fee-0.07 fixture (10 SOL, $10 floor, unlimited depth).
   *
   * @param {number | null} maxOutlay - Cash limit in dollars, or null.
   * @param {number} [maxLoss] - Loss floor in dollars; defaults to 10.
   * @returns {HedgePlan} The plan.
   */
  const planWith = (maxOutlay: number | null, maxLoss = 10): HedgePlan =>
    optimizeHedge({
      ladder: SOL_FIXTURE_LADDER,
      exposure: SOL_FIXTURE_EXPOSURE,
      maxLoss,
      stressPrice: null,
      takerFeeRate: 0.07,
      assumedDepth: null,
      maxOutlay,
    });

  it("defaults the limit to 10 percent of position value", () => {
    expect(DEFAULT_MAX_OUTLAY_FRACTION).toBe(0.1);
  });

  it("says nothing when no limit is set or the plan meets the floor", () => {
    expect(cashLimitNote(planWith(null), null, null)).toBeNull();
    expect(cashLimitNote(planWith(72.12), 72.12, null)).toBeNull();
    expect(cashLimitNote(planWith(1.5, 0), null, planWith(null, 0))).toBeNull();
  });

  it("says how much cash the floor needs when only the limit stands in the way", () => {
    const limited = planWith(1.5);
    expect(limited.status).toBe("best-effort");
    expect(cashLimitNote(limited, 1.5, planWith(null))).toEqual({
      kind: "needs-more-cash",
      neededOutlay: 2.6,
      maxOutlay: 1.5,
    });
  });

  it("says the floor is out of reach at any price, with what the ladder could do, when the limit also binds", () => {
    // A $0 floor is out of reach on the fixture: the best is -$6.45 for $4.23 up front.
    const unlimited = planWith(null, 0);
    expect(unlimited.status).toBe("best-effort");
    const limited = planWith(1.5, 0);
    expect(cashLimitNote(limited, 1.5, unlimited)).toEqual({
      kind: "floor-unreachable",
      maxOutlay: 1.5,
      unlimitedWorstCase: unlimited.worstCaseAfter,
      unlimitedOutlay: unlimited.totalCost,
    });
  });

  it("says nothing when the floor is out of reach at any price but the limit changes nothing", () => {
    const unlimited = planWith(null, 0);
    expect(cashLimitNote(planWith(50, 0), 50, unlimited)).toBeNull();
  });

  it("admits the cause is unknown when the plan without a limit is missing", () => {
    expect(cashLimitNote(planWith(1.5), 1.5, null)).toEqual({ kind: "unknown", maxOutlay: 1.5 });
  });
});

describe("costFigures", () => {
  it("makes net equal paid minus expected as displayed on tiny plans", () => {
    const figures = costFigures(0.034, 0.0151);
    expect(formatUsd(figures.paid)).toBe("$0.03");
    expect(formatUsd(figures.expected)).toBe("$0.02");
    expect(formatUsd(figures.net)).toBe("$0.01");
  });

  it("rounds each figure exactly as formatUsd displays it", () => {
    [0.005, 0.015, 1.005, 2.675, 0.125, 340.925, 12.3449999, -0.005, -1.235, 0].forEach((value) => {
      expect(formatUsd(costFigures(value, 0).paid)).toBe(formatUsd(value));
      expect(formatUsd(costFigures(0, value).expected)).toBe(formatUsd(value));
    });
  });

  it("keeps the identity for many random pairs", () => {
    for (let index = 0; index < 2000; index += 1) {
      const paid = (index * 7.31) % 400;
      const expected = (index * 3.17) % 380;
      const figures = costFigures(paid, expected);
      expect(formatUsd(figures.paid)).toBe(formatUsd(paid));
      expect(formatUsd(figures.expected)).toBe(formatUsd(expected));
      const shownNet = Number(formatUsd(figures.net).replace(/[$,]/g, ""));
      const shownPaid = Number(formatUsd(figures.paid).replace(/[$,]/g, ""));
      const shownExpected = Number(formatUsd(figures.expected).replace(/[$,]/g, ""));
      expect(shownNet).toBeCloseTo(shownPaid - shownExpected, 9);
    }
  });
});
