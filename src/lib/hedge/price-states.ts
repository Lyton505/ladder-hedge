import { impliedDistribution, medianStrikeGap } from "@/lib/hedge/implied-distribution";
import { assertValidLadder } from "@/lib/hedge/ladder-validation";
import type { Exposure, Ladder, LegSide, PriceState } from "@/lib/hedge/types";

/**
 * Returns the default evaluation price for state 0 (below the lowest strike):
 * the lowest strike minus the median gap between adjacent strikes, or
 * 0.99 * K1 for a one-rung ladder.
 *
 * Warning: this is the ladder default only. `optimizeHedge` uses
 * `resolveStressPrice`, which goes lower when spot is near or below the
 * ladder. Display code should use `plan.stressPrice` or `resolveStressPrice`.
 *
 * @param {Ladder} ladder - The ladder, rungs sorted ascending by strike.
 * @returns {number} The default stress price in dollars.
 * @throws {RangeError} If the ladder has no rungs.
 */
export function defaultStressPrice(ladder: Ladder): number {
  if (ladder.rungs.length === 0) {
    throw new RangeError("Cannot derive a stress price from a ladder with no rungs");
  }
  const strikes = ladder.rungs.map((rung) => rung.strike);
  return strikes[0] - medianStrikeGap(strikes);
}

/**
 * Resolves the evaluation price for state 0 that the optimiser uses.
 *
 * A supplied stress price is used as given. Otherwise the stress price is the
 * lower of `defaultStressPrice(ladder)` and one median strike gap below spot,
 * with the spot term never below zero (a price cannot go negative).
 * The second term matters when spot is already below the ladder: without it
 * every evaluation price would sit above spot and the holder would wrongly
 * appear to gain in every state.
 *
 * @param {Ladder} ladder - The ladder, rungs sorted ascending by strike.
 * @param {Exposure} exposure - The holding; only its spot is used.
 * @param {number | null} stressPrice - The requested stress price, or null for the default.
 * @returns {number} The stress price to pass to `buildPriceStates`.
 * @throws {RangeError} If the ladder has no rungs.
 */
export function resolveStressPrice(ladder: Ladder, exposure: Exposure, stressPrice: number | null): number {
  if (stressPrice !== null) {
    return stressPrice;
  }
  const strikes = ladder.rungs.map((rung) => rung.strike);
  const spotTerm = Math.max(0, exposure.spot - medianStrikeGap(strikes));
  return Math.min(defaultStressPrice(ladder), spotTerm);
}

/**
 * Decides whether a contract leg pays $1 at a given expiry price.
 *
 * @param {LegSide} side - "yes" pays at or above the strike; "no" pays strictly below it.
 * @param {number} strike - The rung's strike in dollars.
 * @param {number} price - The expiry price in dollars.
 * @returns {boolean} True when the leg pays at that price.
 */
export function legPaysAtPrice(side: LegSide, strike: number, price: number): boolean {
  if (side === "yes") {
    return price >= strike;
  }
  return price < strike;
}

/**
 * Splits the expiry price into the ladder's n + 1 intervals.
 *
 * State 0 is below the lowest strike and is evaluated at the stress price.
 * State i (i >= 1) is [K_i, K_{i+1}) and is evaluated at its lower bound K_i,
 * which is where a long holder's loss within the interval is worst.
 * Probabilities come from `impliedDistribution`.
 *
 * Warning: passing null uses the ladder default (`defaultStressPrice`), which
 * can differ from the stress price `optimizeHedge` uses when spot is near or
 * below the ladder. Display code should pass `plan.stressPrice` or the result
 * of `resolveStressPrice`.
 *
 * @param {Ladder} ladder - The ladder, rungs sorted ascending by strike.
 * @param {number | null} stressPrice - Evaluation price for state 0, or null for the ladder default.
 * @returns {PriceState[]} One state per interval, indexed 0..n.
 * @throws {RangeError} If the ladder has no rungs, strikes are not strictly increasing, a quote is invalid, or the stress price is not finite or is at or above the lowest strike.
 */
export function buildPriceStates(ladder: Ladder, stressPrice: number | null): PriceState[] {
  if (ladder.rungs.length === 0) {
    throw new RangeError("Cannot build price states for a ladder with no rungs");
  }
  assertValidLadder(ladder);
  const strikes = ladder.rungs.map((rung) => rung.strike);
  const lowestStrike = strikes[0];
  const resolvedStress = stressPrice === null ? defaultStressPrice(ladder) : stressPrice;
  if (!Number.isFinite(resolvedStress)) {
    throw new RangeError(`Stress price must be a finite number, got ${resolvedStress}`);
  }
  if (resolvedStress >= lowestStrike) {
    throw new RangeError(
      `Stress price ${resolvedStress} must be below the lowest strike ${lowestStrike}`,
    );
  }

  const probabilities = impliedDistribution(ladder).bucketProbabilities;
  const states: PriceState[] = [
    { index: 0, lower: null, upper: lowestStrike, evalPrice: resolvedStress, probability: probabilities[0] },
  ];
  for (let rungIndex = 0; rungIndex < strikes.length; rungIndex += 1) {
    const isTop = rungIndex === strikes.length - 1;
    states.push({
      index: rungIndex + 1,
      lower: strikes[rungIndex],
      upper: isTop ? null : strikes[rungIndex + 1],
      evalPrice: strikes[rungIndex],
      probability: probabilities[rungIndex + 1],
    });
  }
  return states;
}
