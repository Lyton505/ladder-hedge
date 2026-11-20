import { medianStrikeGap } from "@/lib/hedge/implied-distribution";
import { legPaysAtPrice } from "@/lib/hedge/price-states";
import type { Exposure, HedgeLeg, HedgePlan, Ladder, PayoffPoint } from "@/lib/hedge/types";

/** Offset below each strike, as a fraction of the median gap, for the point that draws the step. */
const STEP_OFFSET_FRACTION = 1e-6;

/** Prices closer than this fraction of the gap are treated as the same point. */
const DUPLICATE_FRACTION = 1e-9;

/**
 * Evaluates the holder's profit and loss at one expiry price, with and without the hedge.
 *
 * @param {number} price - Expiry price in dollars.
 * @param {Exposure} exposure - The long holding.
 * @param {HedgeLeg[]} legs - Hedge legs; each pays its quantity in dollars when it pays.
 * @param {number} totalCost - Total hedge cost in dollars, fees included.
 * @returns {PayoffPoint} Unhedged P&L, and hedged P&L = unhedged + payout - totalCost.
 */
export function evaluatePayoffAt(price: number, exposure: Exposure, legs: HedgeLeg[], totalCost: number): PayoffPoint {
  const unhedged = exposure.quantity * (price - exposure.spot);
  const payout = legs
    .filter((leg) => legPaysAtPrice(leg.side, leg.strike, price))
    .reduce((total, leg) => total + leg.quantity, 0);
  return { price, unhedged, hedged: unhedged + payout - totalCost };
}

/** A price to evaluate, marked when it must survive de-duplication (a strike or a just-below-strike point). */
interface CurvePrice {
  price: number;
  isAnchor: boolean;
}

/**
 * Samples the before and after payoff for charting.
 *
 * Uses `pointCount` evenly spaced prices from `plan.stressPrice - gap` to
 * `Kn + gap` (gap = median strike spacing), plus a point at each strike and
 * one just below it so the hedge's steps render as steps. Points are sorted by
 * price and near-duplicates are merged, keeping the strike points exact.
 *
 * @param {HedgePlan} plan - The plan whose legs, cost and stress price are drawn.
 * @param {Exposure} exposure - The long holding.
 * @param {Ladder} ladder - The ladder the plan was built on.
 * @param {number} pointCount - Number of evenly spaced points, at least 2.
 * @returns {PayoffPoint[]} Points sorted ascending by price.
 * @throws {RangeError} If pointCount is not an integer of at least 2, or the ladder has no rungs.
 */
export function payoffCurve(plan: HedgePlan, exposure: Exposure, ladder: Ladder, pointCount: number): PayoffPoint[] {
  if (!Number.isInteger(pointCount) || pointCount < 2) {
    throw new RangeError(`pointCount must be an integer of at least 2, got ${pointCount}`);
  }
  if (ladder.rungs.length === 0) {
    throw new RangeError("Cannot draw a payoff curve for a ladder with no rungs");
  }
  const strikes = ladder.rungs.map((rung) => rung.strike);
  const gap = medianStrikeGap(strikes);
  const start = plan.stressPrice - gap;
  const end = strikes[strikes.length - 1] + gap;

  const prices: CurvePrice[] = [];
  for (let index = 0; index < pointCount; index += 1) {
    prices.push({ price: start + ((end - start) * index) / (pointCount - 1), isAnchor: false });
  }
  strikes.forEach((strike) => {
    prices.push({ price: strike, isAnchor: true });
    prices.push({ price: strike - STEP_OFFSET_FRACTION * gap, isAnchor: true });
  });
  prices.sort((left, right) => left.price - right.price);

  const merged: CurvePrice[] = [];
  const duplicateDistance = DUPLICATE_FRACTION * gap;
  prices.forEach((candidate) => {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && candidate.price - previous.price <= duplicateDistance) {
      if (candidate.isAnchor && !previous.isAnchor) {
        merged[merged.length - 1] = candidate;
      }
      return;
    }
    merged.push(candidate);
  });

  return merged.map((entry) => evaluatePayoffAt(entry.price, exposure, plan.legs, plan.totalCost));
}
