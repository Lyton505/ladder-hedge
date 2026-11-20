import { assertValidLadder } from "@/lib/hedge/ladder-validation";
import type { ImpliedDistribution, Ladder, LadderRung } from "@/lib/hedge/types";

/** Fraction of the strike used as the gap for a one-rung ladder (so the stress price is 0.99 * K1). */
export const SINGLE_RUNG_GAP_FRACTION = 0.01;

/**
 * Returns the median gap between adjacent strikes.
 *
 * For an even number of gaps the two middle gaps are averaged. A one-rung
 * ladder has no gaps, so 1 percent of its strike is used instead, which keeps
 * the default stress price at 0.99 * K1 as the plan requires.
 *
 * @param {number[]} strikes - Strikes sorted ascending, unique.
 * @returns {number} The median strike spacing in dollars.
 * @throws {RangeError} If `strikes` is empty.
 */
export function medianStrikeGap(strikes: number[]): number {
  if (strikes.length === 0) {
    throw new RangeError("medianStrikeGap needs at least one strike");
  }
  if (strikes.length === 1) {
    return Math.abs(strikes[0]) * SINGLE_RUNG_GAP_FRACTION;
  }
  const gaps: number[] = [];
  for (let index = 1; index < strikes.length; index += 1) {
    gaps.push(strikes[index] - strikes[index - 1]);
  }
  gaps.sort((left, right) => left - right);
  const middle = Math.floor(gaps.length / 2);
  if (gaps.length % 2 === 1) {
    return gaps[middle];
  }
  return (gaps[middle - 1] + gaps[middle]) / 2;
}

/**
 * Reads the raw survival estimate a rung's own quotes imply.
 *
 * Both quotes: the mid. Bid only: halfway between the bid and 1. Ask only:
 * halfway between 0 and the ask. Neither: null (filled by interpolation).
 *
 * @param {LadderRung} rung - The rung to read.
 * @returns {number | null} The quoted survival estimate, or null when the rung is unquoted.
 */
function quotedSurvival(rung: LadderRung): number | null {
  if (rung.yesBid !== null && rung.yesAsk !== null) {
    return (rung.yesBid + rung.yesAsk) / 2;
  }
  if (rung.yesBid !== null) {
    return (rung.yesBid + 1) / 2;
  }
  if (rung.yesAsk !== null) {
    return rung.yesAsk / 2;
  }
  return null;
}

/** A known survival value at a strike, used as an interpolation anchor. */
interface SurvivalAnchor {
  strike: number;
  survival: number;
}

/**
 * Fills unquoted rungs by linear interpolation in strike between the nearest
 * quoted rungs on each side. Below the ladder the anchor is survival 1 one
 * median gap under K1; above it the anchor is survival 0 one median gap over Kn.
 *
 * @param {number[]} strikes - Strikes sorted ascending.
 * @param {(number | null)[]} quoted - Quoted survival per rung, null where unquoted.
 * @param {number} gap - Median strike spacing.
 * @returns {number[]} Raw survival per rung with every gap filled.
 */
function interpolateUnquoted(strikes: number[], quoted: (number | null)[], gap: number): number[] {
  const lowAnchor: SurvivalAnchor = { strike: strikes[0] - gap, survival: 1 };
  const highAnchor: SurvivalAnchor = { strike: strikes[strikes.length - 1] + gap, survival: 0 };

  return quoted.map((value, index) => {
    if (value !== null) {
      return value;
    }
    let left = lowAnchor;
    for (let scan = index - 1; scan >= 0; scan -= 1) {
      const candidate = quoted[scan];
      if (candidate !== null) {
        left = { strike: strikes[scan], survival: candidate };
        break;
      }
    }
    let right = highAnchor;
    for (let scan = index + 1; scan < quoted.length; scan += 1) {
      const candidate = quoted[scan];
      if (candidate !== null) {
        right = { strike: strikes[scan], survival: candidate };
        break;
      }
    }
    const weight = (strikes[index] - left.strike) / (right.strike - left.strike);
    return left.survival + weight * (right.survival - left.survival);
  });
}

/**
 * Projects a sequence onto the non-increasing sequences with the unweighted
 * pool-adjacent-violators algorithm: any adjacent run that increases is
 * replaced by its mean until the whole sequence is non-increasing.
 *
 * @param {number[]} values - The raw sequence.
 * @returns {number[]} The non-increasing least-squares fit, same length.
 */
export function poolAdjacentViolators(values: number[]): number[] {
  const blockSums: number[] = [];
  const blockCounts: number[] = [];
  for (const value of values) {
    blockSums.push(value);
    blockCounts.push(1);
    while (blockSums.length > 1) {
      const last = blockSums.length - 1;
      const lastMean = blockSums[last] / blockCounts[last];
      const previousMean = blockSums[last - 1] / blockCounts[last - 1];
      if (previousMean >= lastMean) {
        break;
      }
      blockSums[last - 1] += blockSums[last];
      blockCounts[last - 1] += blockCounts[last];
      blockSums.pop();
      blockCounts.pop();
    }
  }
  const result: number[] = [];
  blockSums.forEach((blockSum, blockIndex) => {
    const mean = blockSum / blockCounts[blockIndex];
    for (let repeat = 0; repeat < blockCounts[blockIndex]; repeat += 1) {
      result.push(mean);
    }
  });
  return result;
}

/**
 * Clamps a number to the closed interval [0, 1].
 *
 * @param {number} value - Number to clamp.
 * @returns {number} The clamped value.
 */
function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Derives the ladder's market-implied distribution of the expiry price.
 *
 * Each rung's quotes give a raw survival estimate (see `quotedSurvival`),
 * unquoted rungs are interpolated, the sequence is made non-increasing with
 * pool-adjacent-violators and clamped to [0, 1], and adjacent differences
 * give the probability of each price interval. Never throws on missing quotes.
 *
 * @param {Ladder} ladder - The ladder, rungs sorted ascending by strike.
 * @returns {ImpliedDistribution} Survival per strike and n + 1 bucket probabilities summing to 1.
 * @throws {RangeError} If strikes are not strictly increasing or a quote or size is not a valid number.
 */
export function impliedDistribution(ladder: Ladder): ImpliedDistribution {
  assertValidLadder(ladder);
  const strikes = ladder.rungs.map((rung) => rung.strike);
  if (strikes.length === 0) {
    return { strikes: [], survival: [], bucketProbabilities: [1] };
  }
  const gap = medianStrikeGap(strikes);
  const quoted = ladder.rungs.map(quotedSurvival);
  const raw = interpolateUnquoted(strikes, quoted, gap);
  const survival = poolAdjacentViolators(raw).map(clampUnit);

  const bucketProbabilities: number[] = [1 - survival[0]];
  for (let index = 1; index < survival.length; index += 1) {
    bucketProbabilities.push(survival[index - 1] - survival[index]);
  }
  bucketProbabilities.push(survival[survival.length - 1]);

  return { strikes, survival, bucketProbabilities };
}
