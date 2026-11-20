import type { Exposure, Ladder, LadderRung } from "@/lib/hedge/types";

/** Quote columns for one fixture rung: strike, YES bid, YES ask. */
type FixtureQuote = [strike: number, yesBid: number | null, yesAsk: number | null];

/** The canonical SOL ladder quotes from the plan, one row per rung. */
const SOL_FIXTURE_QUOTES: FixtureQuote[] = [
  [68, 0.95, 0.99],
  [69, 0.98, 0.99],
  [70, 0.96, null],
  [71, 0.95, null],
  [72, 0.7, 0.77],
  [73, null, 0.04],
  [74, null, 0.05],
  [75, null, 0.05],
];

/**
 * Builds a ladder rung with unknown sizes and a 0.01 contract increment.
 *
 * @param {number} strike - Strike price in dollars.
 * @param {number | null} yesBid - Best YES bid, or null when unquoted.
 * @param {number | null} yesAsk - Best YES ask, or null when unquoted.
 * @returns {LadderRung} A rung for the SOL fixture ladder.
 */
export function makeFixtureRung(strike: number, yesBid: number | null, yesAsk: number | null): LadderRung {
  return {
    instrumentSymbol: `SOL-FIXTURE-${strike}`,
    label: `$${strike} or above`,
    strike,
    yesBid,
    yesAsk,
    yesBidSize: null,
    yesAskSize: null,
    quantityIncrement: 0.01,
  };
}

/** Canonical eight-rung SOL ladder used by the engine tests. */
export const SOL_FIXTURE_LADDER: Ladder = {
  eventTicker: "SOL-FIXTURE",
  title: "SOL price today at 12am EST (fixture)",
  asset: "SOL",
  expiry: "2026-11-20T05:00:00.000Z",
  rungs: SOL_FIXTURE_QUOTES.map(([strike, yesBid, yesAsk]) => makeFixtureRung(strike, yesBid, yesAsk)),
  fetchedAt: "2026-11-19T20:00:00.000Z",
  source: "snapshot",
  referenceSpot: 72.12,
};

/** Canonical exposure: 10 SOL valued at 72.12 dollars each. */
export const SOL_FIXTURE_EXPOSURE: Exposure = { asset: "SOL", quantity: 10, spot: 72.12 };

/**
 * Returns a copy of the fixture ladder with its rungs transformed.
 *
 * @param {(rung: LadderRung) => LadderRung} transform - Applied to a copy of each rung.
 * @returns {Ladder} A new ladder; the fixture itself is not modified.
 */
export function withFixtureRungs(transform: (rung: LadderRung) => LadderRung): Ladder {
  return {
    ...SOL_FIXTURE_LADDER,
    rungs: SOL_FIXTURE_LADDER.rungs.map((rung) => transform({ ...rung })),
  };
}
