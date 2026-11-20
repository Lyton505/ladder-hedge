import type { HedgeLeg, HedgeReceipt, Ladder, LadderRung, LadderSummary, PaperFill } from "@/lib/hedge/types";
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
 * any snapshot, then the first ladder listed.
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

/**
 * Finds the on-chain receipts whose memo matches a paper fill saved in this browser:
 * same event ticker and the same plan-hash prefix.
 *
 * @param {readonly PaperFill[]} fills - Fills saved locally.
 * @param {readonly HedgeReceipt[]} receipts - Receipts read from chain.
 * @returns {string[]} Signatures of the matching receipts.
 */
export function matchVerifiedSignatures(
  fills: readonly PaperFill[],
  receipts: readonly HedgeReceipt[],
): string[] {
  const verified: string[] = [];
  for (const receipt of receipts) {
    const parsed = parseReceiptMemo(receipt.memo);
    if (parsed === null) {
      continue;
    }
    const matches = fills.some(
      (fill) =>
        fill.eventTicker === parsed.eventTicker &&
        fill.planHash.slice(0, MEMO_HASH_PREFIX_LENGTH) === parsed.planHash,
    );
    if (matches) {
      verified.push(receipt.signature);
    }
  }
  return verified;
}
