import { assertValidLadder } from "@/lib/hedge/ladder-validation";
import { GEMINI_TAKER_FEE_RATE } from "@/lib/hedge/optimize-hedge";
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
 * Formats a per-pair edge with enough precision to show fee effects, for example "$0.0159".
 *
 * @param {number} edge - Edge in dollars per contract pair.
 * @returns {string} The formatted edge.
 */
function formatEdge(edge: number): string {
  return `$${edge.toFixed(4)}`;
}

/**
 * Computes the unrounded Gemini taker fee for one contract.
 *
 * @param {number} rate - Taker fee rate.
 * @param {number} price - Purchase price of the contract in dollars.
 * @returns {number} rate * price * (1 - price).
 */
function perContractFee(rate: number, price: number): number {
  return rate * price * (1 - price);
}

/**
 * Flags quotes on a ladder that contradict each other.
 *
 * - `arbitrage`: for any rungs i <= k with yesAsk_i < yesBid_k, buying YES at
 *   strike i and NO at strike k pays at least $1 at every expiry price (exactly
 *   $1 when i = k, a crossed book on one rung). It is reported only when the
 *   edge net of taker fees on both legs is positive, using the unrounded
 *   per-contract fee rate * price * (1 - price) on each leg's own purchase
 *   price (YES at yesAsk_i, NO at 1 - yesBid_k). `edge` is that net figure;
 *   `detail` gives gross and net.
 * - `bid-inversion`: adjacent rungs where the higher strike's YES bid exceeds
 *   the lower strike's. Edge: the difference.
 * - `ask-inversion`: the same for YES asks.
 *
 * Inversions alone are not executable. Missing quotes are skipped. Results are
 * sorted with arbitrage first, then by edge, largest first.
 *
 * @param {Ladder} ladder - The ladder, rungs sorted ascending by strike.
 * @param {number} [takerFeeRate] - Taker fee rate used for the net arbitrage edge; defaults to Gemini's 0.07.
 * @returns {CoherenceFinding[]} The findings; empty when the quotes are coherent.
 * @throws {RangeError} If the fee rate is invalid, strikes are not strictly increasing, or a quote or size is not a valid number.
 */
export function checkCoherence(ladder: Ladder, takerFeeRate: number = GEMINI_TAKER_FEE_RATE): CoherenceFinding[] {
  if (!Number.isFinite(takerFeeRate) || takerFeeRate < 0 || takerFeeRate >= 1) {
    throw new RangeError(`takerFeeRate must be in [0, 1), got ${takerFeeRate}`);
  }
  assertValidLadder(ladder);
  const findings: CoherenceFinding[] = [];
  const rungs = ladder.rungs;

  for (let lowerIndex = 0; lowerIndex < rungs.length; lowerIndex += 1) {
    const lower = rungs[lowerIndex];
    for (let higherIndex = lowerIndex; higherIndex < rungs.length; higherIndex += 1) {
      const higher = rungs[higherIndex];
      if (lower.yesAsk === null || higher.yesBid === null || !(lower.yesAsk < higher.yesBid)) {
        continue;
      }
      const yesPrice = lower.yesAsk;
      const noPrice = 1 - higher.yesBid;
      const grossEdge = higher.yesBid - yesPrice;
      const netEdge = grossEdge - perContractFee(takerFeeRate, yesPrice) - perContractFee(takerFeeRate, noPrice);
      if (cleanEdge(netEdge) <= 0) {
        continue;
      }
      const isSameRung = lowerIndex === higherIndex;
      const opening = isSameRung
        ? `The book at ${formatStrike(lower.strike)} is crossed: buying YES for ${formatPrice(yesPrice)} and NO for ${formatPrice(noPrice)}`
        : `Buying YES at ${formatStrike(lower.strike)} for ${formatPrice(yesPrice)} and NO at ${formatStrike(higher.strike)} for ${formatPrice(noPrice)}`;
      const payoff = isSameRung ? "pays exactly $1.00" : "pays at least $1.00";
      findings.push(
        finding(
          "arbitrage",
          lower.strike,
          higher.strike,
          netEdge,
          `${opening} costs ${formatPrice(yesPrice + noPrice)} before fees and ${payoff} at any expiry price, a gross edge of ${formatEdge(grossEdge)} per pair and ${formatEdge(netEdge)} after taker fees.`,
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
