import type { CoherenceFinding, CoherenceKind, Ladder } from "@/lib/hedge/types";

/** Digits kept when removing floating-point noise from price differences. */
const EDGE_DIGITS = 9;

/**
 * Formats a dollar price for a finding's sentence, for example 0.4 as "$0.40".
 *
 * @param {number} price - Price in dollars.
 * @returns {string} The formatted price.
 */
function formatPrice(price: number): string {
  return `$${price.toFixed(2)}`;
}

/**
 * Formats a strike for a finding's sentence without trailing zeros.
 *
 * @param {number} strike - Strike in dollars.
 * @returns {string} The strike, for example "68" or "119.5".
 */
function formatStrike(strike: number): string {
  return String(strike);
}

/**
 * Rounds a price difference to remove floating-point noise.
 *
 * @param {number} value - Difference in dollars.
 * @returns {number} The rounded difference.
 */
function cleanEdge(value: number): number {
  return Number(value.toFixed(EDGE_DIGITS));
}

/**
 * Builds a finding record.
 *
 * @param {CoherenceKind} kind - Finding kind.
 * @param {number} lowerStrike - The lower strike of the pair.
 * @param {number} higherStrike - The higher strike of the pair.
 * @param {number} edge - Dollars per contract pair.
 * @param {string} detail - One plain sentence describing the finding.
 * @returns {CoherenceFinding} The finding.
 */
function finding(kind: CoherenceKind, lowerStrike: number, higherStrike: number, edge: number, detail: string): CoherenceFinding {
  return { kind, lowerStrike, higherStrike, edge: cleanEdge(edge), detail };
}

/**
 * Flags quotes on a ladder that contradict each other.
 *
 * - `arbitrage`: for any rungs i < k with yesAsk_i < yesBid_k, buying YES at
 *   the lower strike and NO at the higher strike costs under $1 before fees
 *   and pays at least $1 at every expiry price. Edge: yesBid_k - yesAsk_i.
 * - `bid-inversion`: adjacent rungs where the higher strike's YES bid exceeds
 *   the lower strike's. Edge: the difference.
 * - `ask-inversion`: the same for YES asks.
 *
 * Inversions alone are not executable. Missing quotes are skipped. Results are
 * sorted with arbitrage first, then by edge, largest first.
 *
 * @param {Ladder} ladder - The ladder, rungs sorted ascending by strike.
 * @returns {CoherenceFinding[]} The findings; empty when the quotes are coherent.
 */
export function checkCoherence(ladder: Ladder): CoherenceFinding[] {
  const findings: CoherenceFinding[] = [];
  const rungs = ladder.rungs;

  for (let lowerIndex = 0; lowerIndex < rungs.length; lowerIndex += 1) {
    const lower = rungs[lowerIndex];
    for (let higherIndex = lowerIndex + 1; higherIndex < rungs.length; higherIndex += 1) {
      const higher = rungs[higherIndex];
      if (lower.yesAsk === null || higher.yesBid === null || !(lower.yesAsk < higher.yesBid)) {
        continue;
      }
      const noPrice = 1 - higher.yesBid;
      findings.push(
        finding(
          "arbitrage",
          lower.strike,
          higher.strike,
          higher.yesBid - lower.yesAsk,
          `Buying YES at ${formatStrike(lower.strike)} for ${formatPrice(lower.yesAsk)} and NO at ${formatStrike(higher.strike)} for ${formatPrice(noPrice)} costs ${formatPrice(lower.yesAsk + noPrice)} before fees and pays at least $1.00 at any expiry price.`,
        ),
      );
    }
  }

  for (let index = 1; index < rungs.length; index += 1) {
    const lower = rungs[index - 1];
    const higher = rungs[index];
    if (lower.yesBid !== null && higher.yesBid !== null && higher.yesBid > lower.yesBid) {
      findings.push(
        finding(
          "bid-inversion",
          lower.strike,
          higher.strike,
          higher.yesBid - lower.yesBid,
          `The YES bid at ${formatStrike(higher.strike)} (${formatPrice(higher.yesBid)}) is above the YES bid at the lower strike ${formatStrike(lower.strike)} (${formatPrice(lower.yesBid)}).`,
        ),
      );
    }
    if (lower.yesAsk !== null && higher.yesAsk !== null && higher.yesAsk > lower.yesAsk) {
      findings.push(
        finding(
          "ask-inversion",
          lower.strike,
          higher.strike,
          higher.yesAsk - lower.yesAsk,
          `The YES ask at ${formatStrike(higher.strike)} (${formatPrice(higher.yesAsk)}) is above the YES ask at the lower strike ${formatStrike(lower.strike)} (${formatPrice(lower.yesAsk)}).`,
        ),
      );
    }
  }

  return findings.sort((left, right) => {
    const leftRank = left.kind === "arbitrage" ? 0 : 1;
    const rightRank = right.kind === "arbitrage" ? 0 : 1;
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    return right.edge - left.edge;
  });
}
