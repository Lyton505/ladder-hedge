import type {
  HedgeLeg,
  HedgePlan,
  HedgeReceipt,
  Ladder,
  LadderRung,
  LadderSummary,
  PaperFill,
} from "@/lib/hedge/types";
import { BEST_EFFORT_LIFT_SLACK_FRACTION, BEST_EFFORT_SLACK_FRACTION } from "@/lib/hedge";
import { MEMO_HASH_PREFIX_LENGTH, parseReceiptMemo } from "@/lib/solana/receipt-memo";
import { formatStrike, formatUsd } from "@/components/format";

/**
 * Pure decisions the hedge workbench makes about ladders, depth and receipts.
 * Kept free of React so they can be unit tested.
 */

/** A live ladder needs at least this many two-sided rungs to be chosen by default. */
export const MIN_TWO_SIDED_RUNGS = 3;

/** How far ahead a ladder expires, in words a holder recognises. */
export type LadderHorizon = "hourly" | "daily" | "month-end";

/** Where the depth limits in a plan came from. */
export type DepthBasis = "measured" | "assumed" | "mixed" | "none";

/** Where spot sits relative to the ladder's strikes. */
export type SpotPosition = "below" | "inside" | "above";

/**
 * Counts rungs quoted on both sides (a YES bid and a YES ask).
 *
 * @param {Ladder} ladder - The ladder.
 * @returns {number} Number of two-sided rungs.
 */
export function countTwoSidedRungs(ladder: Ladder): number {
  return ladder.rungs.filter((rung) => rung.yesBid !== null && rung.yesAsk !== null).length;
}

/**
 * Classifies a ladder's horizon from its title and expiry. Gemini titles hourly
 * ladders "price today at 1am EST"; daily and monthly ladders both expire at
 * 22:00 UTC, and the monthly one settles on the last day of the month.
 *
 * @param {LadderSummary} summary - The ladder summary.
 * @returns {LadderHorizon} The horizon.
 */
export function ladderHorizon(summary: LadderSummary): LadderHorizon {
  if (/\btoday at\b/i.test(summary.title)) {
    return "hourly";
  }
  const expiryMs = Date.parse(summary.expiry);
  if (!Number.isNaN(expiryMs)) {
    const expiry = new Date(expiryMs);
    const nextDay = new Date(expiryMs + 24 * 60 * 60 * 1000);
    if (nextDay.getUTCMonth() !== expiry.getUTCMonth()) {
      return "month-end";
    }
  }
  return "daily";
}

/**
 * Words for a horizon, shown in the ladder picker.
 *
 * @param {LadderHorizon} horizon - The horizon.
 * @returns {string} A short label.
 */
export function horizonLabel(horizon: LadderHorizon): string {
  switch (horizon) {
    case "hourly":
      return "Hourly";
    case "daily":
      return "Daily";
    case "month-end":
      return "Month end";
  }
}

/**
 * Picks the ladder to show first for an asset.
 *
 * Among live ladders that have not expired, the one with the most two-sided rungs wins
 * (ties go to the later expiry), provided it has at least {@link MIN_TWO_SIDED_RUNGS}.
 * Hourly ladders are often quoted on one side only, so the soonest expiry is not used.
 * When no live ladder qualifies, the first snapshot that has not expired is used, then
 * any snapshot, then the first ladder listed. The server lists snapshots in preference
 * order (unexpired first, by most two-sided rungs, then later expiry), so the first
 * unexpired snapshot is the asset's default snapshot.
 *
 * @param {LadderSummary[]} ladders - Summaries in the server's order (live first, snapshots in preference order).
 * @param {ReadonlyMap<string, number>} twoSidedByTicker - Two-sided rung counts for the live ladders that could be loaded.
 * @param {number} nowMs - Current time in epoch milliseconds.
 * @returns {string | null} The chosen event ticker, or null when the list is empty.
 */
export function chooseDefaultLadder(
  ladders: readonly LadderSummary[],
  twoSidedByTicker: ReadonlyMap<string, number>,
  nowMs: number,
): string | null {
  let best: { ticker: string; twoSided: number; expiryMs: number } | null = null;
  for (const ladder of ladders) {
    const expiryMs = Date.parse(ladder.expiry);
    if (ladder.source !== "live" || Number.isNaN(expiryMs) || expiryMs <= nowMs) {
      continue;
    }
    const twoSided = twoSidedByTicker.get(ladder.eventTicker);
    if (twoSided === undefined || twoSided < MIN_TWO_SIDED_RUNGS) {
      continue;
    }
    const better =
      best === null || twoSided > best.twoSided || (twoSided === best.twoSided && expiryMs > best.expiryMs);
    if (better) {
      best = { ticker: ladder.eventTicker, twoSided, expiryMs };
    }
  }
  if (best !== null) {
    return best.ticker;
  }

  const snapshots = ladders.filter((ladder) => ladder.source === "snapshot");
  const unexpired = snapshots.find((ladder) => Date.parse(ladder.expiry) > nowMs);
  if (unexpired !== undefined) {
    return unexpired.eventTicker;
  }
  if (snapshots.length > 0) {
    return snapshots[0].eventTicker;
  }
  return ladders.length > 0 ? ladders[0].eventTicker : null;
}

/**
 * Says whether the size on one quoted side of a rung is known.
 *
 * @param {LadderRung} rung - The rung.
 * @param {"yes" | "no"} side - YES lifts the YES ask; NO lifts the YES bid.
 * @returns {boolean | null} True when measured, false when unknown, null when that side is not quoted.
 */
function sideSizeKnown(rung: LadderRung, side: "yes" | "no"): boolean | null {
  if (side === "yes") {
    return rung.yesAsk === null ? null : rung.yesAskSize !== null;
  }
  return rung.yesBid === null ? null : rung.yesBidSize !== null;
}

/**
 * Summarises a list of known/unknown flags.
 *
 * @param {boolean[]} flags - One entry per quoted side; true when its size is measured.
 * @returns {DepthBasis} measured, assumed, mixed, or none for an empty list.
 */
function basisOf(flags: boolean[]): DepthBasis {
  if (flags.length === 0) {
    return "none";
  }
  const known = flags.filter((flag) => flag).length;
  if (known === flags.length) {
    return "measured";
  }
  return known === 0 ? "assumed" : "mixed";
}

/**
 * Where the ladder's depth comes from across every quoted side.
 *
 * @param {Ladder} ladder - The ladder.
 * @returns {DepthBasis} measured when every quoted side has a size, assumed when none
 *   has, mixed otherwise, none when nothing is quoted.
 */
export function ladderDepthBasis(ladder: Ladder): DepthBasis {
  const flags: boolean[] = [];
  for (const rung of ladder.rungs) {
    for (const side of ["yes", "no"] as const) {
      const known = sideSizeKnown(rung, side);
      if (known !== null) {
        flags.push(known);
      }
    }
  }
  return basisOf(flags);
}

/**
 * Where the size caps on a plan's legs came from.
 *
 * @param {Ladder} ladder - The ladder the plan was built on.
 * @param {HedgeLeg[]} legs - The plan's legs.
 * @returns {DepthBasis} measured when every leg's side has a published size, assumed when
 *   none has, mixed otherwise, none when there are no legs.
 */
export function planDepthBasis(ladder: Ladder, legs: readonly HedgeLeg[]): DepthBasis {
  const flags: boolean[] = [];
  for (const leg of legs) {
    const rung = ladder.rungs.find((candidate) => candidate.instrumentSymbol === leg.instrumentSymbol);
    if (rung === undefined) {
      flags.push(false);
      continue;
    }
    flags.push(sideSizeKnown(rung, leg.side) === true);
  }
  return basisOf(flags);
}

/**
 * Locates spot against the ladder's strikes.
 *
 * @param {Ladder} ladder - The ladder.
 * @param {number} spot - Spot price.
 * @returns {SpotPosition | null} below the lowest strike, above the highest, inside, or null for an empty ladder.
 */
export function spotPosition(ladder: Ladder, spot: number): SpotPosition | null {
  if (ladder.rungs.length === 0) {
    return null;
  }
  const lowest = ladder.rungs[0].strike;
  const highest = ladder.rungs[ladder.rungs.length - 1].strike;
  if (spot < lowest) {
    return "below";
  }
  if (spot > highest) {
    return "above";
  }
  return "inside";
}

/** Why the engine must not be called yet: no usable quantity, or no usable spot. */
export type HedgeInputBlocker = "quantity" | "spot";

/** Prompt shown in place of the plan while the quantity field is blank, zero or invalid. */
export const QUANTITY_PROMPT = "Enter a position size above zero to see a hedge.";

/**
 * Decides whether the holding is complete enough to call the engine. The engine throws a
 * RangeError for a quantity or spot that is zero, negative or not finite, so the page
 * must not call it with one.
 *
 * @param {number | null} quantity - Quantity from the field, or null while the field is blank or invalid.
 * @param {number | null} spot - Spot price in dollars, or null while it is loading or unavailable.
 * @returns {HedgeInputBlocker | null} What is missing, or null when the engine can be called.
 */
export function hedgeInputBlocker(quantity: number | null, spot: number | null): HedgeInputBlocker | null {
  if (quantity === null || !Number.isFinite(quantity) || quantity <= 0) {
    return "quantity";
  }
  if (spot === null || !Number.isFinite(spot) || spot <= 0) {
    return "spot";
  }
  return null;
}

/** How the largest hedgeable quantity should be shown. */
export type MaxHedgeableDisplay =
  /** No position size needs a hedge at this floor (the engine returned Infinity). */
  | { kind: "any-size" }
  /** A finite, non-negative size. */
  | { kind: "quantity"; quantity: number }
  /** Not known: depth is unlimited somewhere, or the value is not computed yet (null). */
  | { kind: "unknown" }
  /** A value the engine should never return (NaN, negative, -Infinity). */
  | { kind: "invalid" };

/**
 * Classifies the largest hedgeable quantity for display, so that Infinity and other
 * non-finite values never reach a number formatter.
 *
 * @param {number | null} value - The value from `maxHedgeableQuantity`, or null.
 * @returns {MaxHedgeableDisplay} How to show it.
 */
export function classifyMaxHedgeable(value: number | null): MaxHedgeableDisplay {
  if (value === null) {
    return { kind: "unknown" };
  }
  if (value === Number.POSITIVE_INFINITY) {
    return { kind: "any-size" };
  }
  if (!Number.isFinite(value) || value < 0) {
    return { kind: "invalid" };
  }
  return { kind: "quantity", quantity: value };
}

/** Default cash limit: the most the page lets a plan pay up front, as a share of position value. */
export const DEFAULT_MAX_OUTLAY_FRACTION = 0.1;

/** Smallest cash limit the control offers, as a share of position value. */
export const MIN_MAX_OUTLAY_FRACTION = 0.01;

/** Largest cash limit the control offers, as a share of position value (beyond it, "No limit"). */
export const MAX_MAX_OUTLAY_FRACTION = 0.5;

/**
 * Why a plan that falls short of the floor falls short, when a cash limit is set and
 * makes a difference.
 */
export type CashLimitNote =
  /** The floor is reachable on this ladder, but only for more cash than the limit. */
  | { kind: "needs-more-cash"; neededOutlay: number; maxOutlay: number }
  /** The floor is out of reach at any price, and the limit also cuts what the ladder could do. */
  | { kind: "floor-unreachable"; maxOutlay: number; unlimitedWorstCase: number; unlimitedOutlay: number }
  /** The plan without a limit could not be computed, so the cause is not known. */
  | { kind: "unknown"; maxOutlay: number };

/**
 * Explains a `best-effort` or `unhedgeable` plan computed under a cash limit, by comparing
 * it with the plan the same inputs give with no limit.
 *
 * @param {HedgePlan} plan - The plan computed with the limit.
 * @param {number | null} maxOutlay - The limit in dollars, or null when none is set.
 * @param {HedgePlan | null} unlimitedPlan - The plan with no limit, or null when it could not be computed.
 * @returns {CashLimitNote | null} The cause, or null when no limit is set, when the plan meets the
 *   floor or needs no hedge, or when the limit does not change the plan.
 */
export function cashLimitNote(
  plan: HedgePlan,
  maxOutlay: number | null,
  unlimitedPlan: HedgePlan | null,
): CashLimitNote | null {
  if (maxOutlay === null || (plan.status !== "best-effort" && plan.status !== "unhedgeable")) {
    return null;
  }
  if (unlimitedPlan === null) {
    return { kind: "unknown", maxOutlay };
  }
  if (unlimitedPlan.status === "optimal") {
    return { kind: "needs-more-cash", neededOutlay: unlimitedPlan.totalCost, maxOutlay };
  }
  // The engine returns the unlimited plan unchanged whenever it fits the limit, so a plan
  // that fits means the limit changed nothing and needs no mention.
  if (unlimitedPlan.totalCost <= maxOutlay) {
    return null;
  }
  return {
    kind: "floor-unreachable",
    maxOutlay,
    unlimitedWorstCase: unlimitedPlan.worstCaseAfter,
    unlimitedOutlay: unlimitedPlan.totalCost,
  };
}

/** Inputs to {@link bestEffortExplanation}. */
export interface BestEffortInput {
  /** The floor as a non-positive dollar amount (minus the plan's requested maximum loss). */
  floor: number;
  /** Worst case without a hedge, in dollars. */
  worstCaseBefore: number;
  /** Worst case with this basket, in dollars. */
  worstCaseAfter: number;
  /**
   * Best worst case any basket could reach within the current limits, before rounding
   * (`bestAchievableWorstCase` on the same request, cash limit included); null when unknown.
   */
  bestReachable: number | null;
  /** Position value in dollars (quantity times spot). */
  positionValue: number;
  /** Cash limit in dollars, or null when none is set. */
  cashLimit: number | null;
}

/** Half a cent: figures closer than this read the same once formatted to the cent. */
const HALF_CENT = 0.005;

/**
 * Explains a `best-effort` plan in plain words: the best worst case any basket could reach
 * within the current limits, the worst case this basket reaches, and why it stops short
 * (the engine deliberately gives up as much as the smaller of 0.1% of position value and 5%
 * of the improvement over no hedge, because the last part of the protection costs
 * disproportionately more). It never says the basket is the best possible.
 *
 * @param {BestEffortInput} input - The plan's figures and the best reachable worst case.
 * @returns {string} Two to four sentences.
 */
export function bestEffortExplanation(input: BestEffortInput): string {
  const { floor, worstCaseBefore, worstCaseAfter, positionValue, cashLimit } = input;
  const best = input.bestReachable !== null && Number.isFinite(input.bestReachable) ? input.bestReachable : null;
  const within = cashLimit === null ? "" : ` within your cash limit of ${formatUsd(cashLimit)}`;
  const reaches = `This basket reaches ${formatUsd(worstCaseAfter)}`;
  const why = "the last part of the protection costs disproportionately more";
  const rule = "the smaller of 0.1% of the position's value and 5% of the improvement over no hedge";
  const inversion =
    "For the same reason, a slightly looser floor that can be met may show a better worst case than this basket.";

  if (best === null) {
    return `${reaches}. It stops short of the best reachable worst case on purpose: ${why}, so the engine gives up as much as ${rule}. ${inversion}`;
  }
  const gap = Math.max(0, best - worstCaseAfter);
  const giveUp = `the engine can also give up as much as ${rule} on purpose, because ${why}`;
  if (best >= floor - HALF_CENT) {
    return `Before rounding, a basket${within} could reach ${formatUsd(best)}, which meets your floor; with sizes rounded to tradable steps and each leg's fee rounded up to the cent, none was found that does. ${reaches}, ${formatUsd(gap)} short of ${formatUsd(best)}: rounding causes part of the gap, and ${giveUp}. ${inversion}`;
  }
  const reach = `The best worst case any basket of these quotes could reach${within} is ${formatUsd(best)}.`;
  const slack = Math.min(BEST_EFFORT_SLACK_FRACTION * positionValue, BEST_EFFORT_LIFT_SLACK_FRACTION * (best - worstCaseBefore));
  if (gap <= slack + HALF_CENT) {
    return `${reach} ${reaches}, ${formatUsd(gap)} short of that on purpose: ${why}, so it gives up at most ${rule} (here ${formatUsd(slack)}). ${inversion}`;
  }
  return `${reach} ${reaches}, ${formatUsd(gap)} short of that. Rounding to tradable sizes and cent fees can cause part of the gap, and ${giveUp}. ${inversion}`;
}

/** The three cost figures under the headline, rounded to the cent as displayed. */
export interface CostFigures {
  /** Paid up front, rounded to the cent. */
  paid: number;
  /** Expected payout, rounded to the cent. */
  expected: number;
  /** paid minus expected, so the three displayed figures always agree. */
  net: number;
}

/**
 * Formatter used only to round to the cent exactly as `formatUsd` does. `toFixed` is not
 * used because it rounds the exact binary value (0.015 becomes 0.01) while
 * `Intl.NumberFormat` rounds the shortest decimal form (0.015 becomes 0.02).
 */
const CENT_ROUNDER = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: false,
});

/**
 * Rounds a dollar amount to the cent the way `formatUsd` displays it.
 *
 * @param {number} value - Dollars.
 * @returns {number} Dollars rounded to the cent (never -0); non-finite values are returned unchanged.
 */
function roundToCents(value: number): number {
  if (!Number.isFinite(value)) {
    return value;
  }
  const rounded = Number(CENT_ROUNDER.format(value));
  return rounded === 0 ? 0 : rounded;
}

/**
 * Builds the displayed cost figures so that net equals paid minus expected as shown:
 * paid and expected are each rounded to the cent first, then net is their difference.
 * Without this, tiny plans can read "paid $0.03, expected $0.02, net $0.02".
 *
 * @param {number} totalCost - Paid up front, in dollars.
 * @param {number} expectedPayout - Expected payout, in dollars.
 * @returns {CostFigures} The rounded figures.
 */
export function costFigures(totalCost: number, expectedPayout: number): CostFigures {
  const paid = roundToCents(totalCost);
  const expected = roundToCents(expectedPayout);
  return { paid, expected, net: roundToCents(paid - expected) };
}

/** Title and body of a notice about where spot sits against the strikes. */
export interface SpotNoticeCopy {
  id: "spot-below" | "spot-above";
  title: string;
  body: string;
}

/** Inputs to {@link spotPositionNotice}. */
export interface SpotNoticeInput {
  position: SpotPosition | null;
  asset: string;
  /** Spot price in dollars. */
  spot: number;
  /** Units held. */
  quantity: number;
  lowestStrike: number;
  highestStrike: number;
  /** The stress price the displayed plan used (`plan.stressPrice`), or null when there is no plan yet. */
  stressPrice: number | null;
}

/**
 * Builds the notice shown when spot sits outside the ladder's strikes, or null when it
 * sits inside them.
 *
 * Below the ladder, every price under spot falls in the ladder's bottom range, so the
 * basket can pay only a fixed amount there: the plan is still real, but it is measured
 * down to the plan's stress price and is flat below the lowest strike. Above the
 * ladder, no contract can tell a settlement just under spot from one at the highest
 * strike or above.
 *
 * @param {SpotNoticeInput} input - Spot, the strikes and the plan's stress price.
 * @returns {SpotNoticeCopy | null} The notice, or null when spot is inside the strikes or unknown.
 */
export function spotPositionNotice(input: SpotNoticeInput): SpotNoticeCopy | null {
  const { position, asset, spot, quantity, lowestStrike, highestStrike, stressPrice } = input;
  if (position === "below") {
    const measured =
      stressPrice !== null && Number.isFinite(stressPrice)
        ? ` The plan's worst case is measured down to ${formatUsd(stressPrice)}; below that, every further dollar of decline is your loss.`
        : " Below the price the plan is measured at, every further dollar of decline is your loss.";
    return {
      id: "spot-below",
      title: "Spot is below every strike on this ladder",
      body: `${asset} is at ${formatUsd(spot)}, under the lowest strike of ${formatStrike(lowestStrike)}. Every price below spot falls in the ladder's bottom range, where each contract pays the same fixed amount however far ${asset} falls.${measured} A ladder whose strikes surround spot can protect in steps.`,
    };
  }
  if (position === "above") {
    const gapLoss = (spot - highestStrike) * quantity;
    return {
      id: "spot-above",
      title: "Spot is above every strike on this ladder",
      body: `${asset} is at ${formatUsd(spot)}, over the highest strike of ${formatStrike(highestStrike)}. Every contract pays the same whether ${asset} settles just under spot or at ${formatStrike(highestStrike)}, so the ladder cannot tell those apart. The worst case already counts a fall to ${formatStrike(highestStrike)}, a loss of ${formatUsd(gapLoss)}. A ladder whose strikes surround spot can protect in steps.`,
    };
  }
  return null;
}

/** How the on-chain receipts compare with the paper fills saved in this browser. */
export interface ReceiptMatches {
  /**
   * Signatures of receipts this browser recorded: a saved fill stores the same signature,
   * and the memo's event ticker and plan-hash prefix match that fill.
   */
  verified: string[];
  /**
   * Signatures of receipts whose memo matches a saved fill's event ticker and plan-hash
   * prefix, but which no saved fill recorded. Anyone can copy a public memo into a
   * transaction that mentions the wallet, so these are not verified.
   */
  unrecorded: string[];
}

/**
 * Compares on-chain receipts with the paper fills saved in this browser. A receipt is
 * verified only when a saved fill recorded that very transaction (`fill.signature` equals
 * the receipt's signature) and the memo's event ticker and plan-hash prefix match that fill.
 * A memo that matches a saved plan under another signature is reported as unrecorded.
 *
 * @param {readonly PaperFill[]} fills - Fills saved locally.
 * @param {readonly HedgeReceipt[]} receipts - Receipts read from chain.
 * @returns {ReceiptMatches} Verified and unrecorded-but-matching signatures.
 */
export function matchReceipts(fills: readonly PaperFill[], receipts: readonly HedgeReceipt[]): ReceiptMatches {
  const verified: string[] = [];
  const unrecorded: string[] = [];
  for (const receipt of receipts) {
    const parsed = parseReceiptMemo(receipt.memo);
    if (parsed === null) {
      continue;
    }
    /**
     * Says whether the receipt's memo names this fill's ladder and plan-hash prefix.
     *
     * @param {PaperFill} fill - A saved fill.
     * @returns {boolean} True when ticker and hash prefix match.
     */
    const memoMatches = (fill: PaperFill): boolean =>
      fill.eventTicker === parsed.eventTicker && fill.planHash.slice(0, MEMO_HASH_PREFIX_LENGTH) === parsed.planHash;
    if (fills.some((fill) => fill.signature === receipt.signature && memoMatches(fill))) {
      verified.push(receipt.signature);
    } else if (fills.some(memoMatches)) {
      unrecorded.push(receipt.signature);
    }
  }
  return { verified, unrecorded };
}
