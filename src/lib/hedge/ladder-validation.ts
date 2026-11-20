import type { Ladder, LadderRung } from "@/lib/hedge/types";

/** Quote fields that must be null or a finite price in [0, 1]. */
const PRICE_FIELDS = ["yesBid", "yesAsk"] as const;

/** Size fields that must be null or a finite non-negative number of contracts. */
const SIZE_FIELDS = ["yesBidSize", "yesAskSize"] as const;

/**
 * Names a rung for error messages.
 *
 * @param {LadderRung} rung - The rung.
 * @param {number} index - Its position in the ladder.
 * @returns {string} For example "rung 3 (SOL-70, strike 70)".
 */
function describeRung(rung: LadderRung, index: number): string {
  return `rung ${index} (${rung.instrumentSymbol}, strike ${rung.strike})`;
}

/**
 * Checks that a ladder is safe for the engine: strikes finite and strictly
 * increasing, every non-null price finite and within [0, 1], and every
 * non-null size finite and non-negative. An empty ladder passes; callers that
 * need rungs check for that themselves.
 *
 * @param {Ladder} ladder - The ladder to check.
 * @returns {void}
 * @throws {RangeError} Naming the offending rung and field when any value is out of range.
 */
export function assertValidLadder(ladder: Ladder): void {
  ladder.rungs.forEach((rung, index) => {
    if (!Number.isFinite(rung.strike)) {
      throw new RangeError(`Ladder ${describeRung(rung, index)}: strike must be a finite number, got ${rung.strike}`);
    }
    if (index > 0) {
      const previous = ladder.rungs[index - 1];
      if (!(rung.strike > previous.strike)) {
        throw new RangeError(
          `Ladder ${describeRung(rung, index)}: strikes must be strictly increasing, but strike ${rung.strike} follows ${previous.strike}`,
        );
      }
    }
    PRICE_FIELDS.forEach((field) => {
      const value = rung[field];
      if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1)) {
        throw new RangeError(`Ladder ${describeRung(rung, index)}: ${field} must be null or a finite price in [0, 1], got ${value}`);
      }
    });
    SIZE_FIELDS.forEach((field) => {
      const value = rung[field];
      if (value !== null && (!Number.isFinite(value) || value < 0)) {
        throw new RangeError(`Ladder ${describeRung(rung, index)}: ${field} must be null or a finite non-negative size, got ${value}`);
      }
    });
  });
}
