import type { Exposure, HedgeLeg, HedgePlan } from "@/lib/hedge/types";
import { RECEIPT_PREFIX } from "./constants";

/** Hard upper bound on the memo size in UTF-8 bytes; memos must be strictly smaller. */
export const MAX_MEMO_BYTES = 300;

/** Number of hex characters of the plan hash written into the memo. */
export const MEMO_HASH_PREFIX_LENGTH = 32;

/** Fields recovered from a receipt memo. */
export interface ParsedReceiptMemo {
  eventTicker: string;
  quantity: number;
  maxLoss: number;
  totalCost: number;
  legCount: number;
  planHash: string;
}

/** One leg in the canonical plan JSON. Key order is part of the format. */
interface CanonicalLeg {
  s: string;
  d: string;
  q: number;
  p: number;
}

/** The canonical plan object. Key order is part of the format. */
interface CanonicalPlan {
  v: 1;
  eventTicker: string;
  asset: string;
  quantity: number;
  spot: number;
  maxLoss: number;
  totalCost: number;
  legs: CanonicalLeg[];
}

const LENGTH_TAG_PATTERN = /^\[\d+\]\s*/;
const HASH_PREFIX_PATTERN = /^[0-9a-f]{32}$/;
const MEMO_SEPARATOR = "|";

/**
 * Rounds a number to 6 decimal places for canonical serialisation.
 *
 * @param {number} value - The value to round.
 * @param {string} field - Field name, used in the error message.
 * @returns {number} The rounded value, with negative zero normalised to zero.
 * @throws {Error} If the value is NaN or infinite.
 */
function round6(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot build a hedge receipt: ${field} is not a finite number (${String(value)}).`);
  }
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  if (Object.is(rounded, -0)) {
    return 0;
  }
  return rounded;
}

/**
 * Orders legs by instrument symbol, then side, using plain code-unit comparison so the
 * result does not depend on the runtime locale.
 *
 * @param {HedgeLeg} a - First leg.
 * @param {HedgeLeg} b - Second leg.
 * @returns {number} Negative, zero or positive, as `Array.prototype.sort` expects.
 */
function compareLegs(a: HedgeLeg, b: HedgeLeg): number {
  if (a.instrumentSymbol < b.instrumentSymbol) {
    return -1;
  }
  if (a.instrumentSymbol > b.instrumentSymbol) {
    return 1;
  }
  if (a.side < b.side) {
    return -1;
  }
  if (a.side > b.side) {
    return 1;
  }
  return 0;
}

/**
 * Serialises a hedge plan into the canonical JSON that the receipt hash commits to.
 *
 * Format: `{ v: 1, eventTicker, asset, quantity, spot, maxLoss, totalCost, legs: [{ s, d, q, p }] }`
 * with legs sorted by instrument symbol then side, numbers rounded to 6 decimals, keys in
 * exactly that order and no whitespace.
 *
 * @param {string} eventTicker - Ticker of the ladder event the plan hedges against.
 * @param {Exposure} exposure - The holding being hedged.
 * @param {HedgePlan} plan - The computed plan.
 * @returns {string} Canonical JSON string.
 * @throws {Error} If any number in the plan is NaN or infinite.
 */
export function canonicalPlanJson(eventTicker: string, exposure: Exposure, plan: HedgePlan): string {
  const sortedLegs = [...plan.legs].sort(compareLegs);
  const legs: CanonicalLeg[] = sortedLegs.map((leg) => ({
    s: leg.instrumentSymbol,
    d: leg.side,
    q: round6(leg.quantity, `leg ${leg.instrumentSymbol} quantity`),
    p: round6(leg.price, `leg ${leg.instrumentSymbol} price`),
  }));
  const canonical: CanonicalPlan = {
    v: 1,
    eventTicker,
    asset: exposure.asset,
    quantity: round6(exposure.quantity, "exposure quantity"),
    spot: round6(exposure.spot, "exposure spot"),
    maxLoss: round6(plan.requestedMaxLoss, "max loss"),
    totalCost: round6(plan.totalCost, "total cost"),
    legs,
  };
  return JSON.stringify(canonical);
}

/**
 * Converts bytes to a lowercase hex string.
 *
 * @param {ArrayBuffer} buffer - Bytes to encode.
 * @returns {string} Lowercase hex, two characters per byte.
 */
function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Hashes the canonical plan JSON with SHA-256 using Web Crypto.
 *
 * @param {string} eventTicker - Ticker of the ladder event.
 * @param {Exposure} exposure - The holding being hedged.
 * @param {HedgePlan} plan - The computed plan.
 * @returns {Promise<string>} 64-character lowercase hex digest.
 * @throws {Error} If Web Crypto is unavailable or the plan contains non-finite numbers.
 */
export async function hashPlan(eventTicker: string, exposure: Exposure, plan: HedgePlan): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle === undefined) {
      throw new Error("Web Crypto (crypto.subtle) is not available in this environment.");
    }
    const json = canonicalPlanJson(eventTicker, exposure, plan);
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(json));
    return toHex(digest);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to hash hedge plan: ${message}`, { cause: error });
  }
}

/**
 * Formats a number for the memo: rounded to 6 decimals, no trailing zeros.
 *
 * @param {number} value - Value to format.
 * @param {string} field - Field name, used in the error message.
 * @returns {string} Decimal string.
 * @throws {Error} If the value is NaN or infinite.
 */
function formatMemoNumber(value: number, field: string): string {
  return String(round6(value, field));
}

/**
 * Builds the pipe-delimited receipt memo for a plan.
 *
 * Format: `LH1|{eventTicker}|q={quantity}|floor={maxLoss}|cost={totalCost to 2 decimals}|legs={leg count}|h={first 32 hex of planHash}`.
 *
 * @param {string} eventTicker - Ticker of the ladder event.
 * @param {Exposure} exposure - The holding being hedged.
 * @param {HedgePlan} plan - The computed plan.
 * @returns {Promise<{ memo: string; planHash: string }>} The memo and the full 64-character plan hash.
 * @throws {Error} If the ticker is empty or contains `|`, the plan has non-finite numbers,
 *   hashing fails, or the memo would reach 300 bytes.
 */
export async function buildReceiptMemo(
  eventTicker: string,
  exposure: Exposure,
  plan: HedgePlan,
): Promise<{ memo: string; planHash: string }> {
  try {
    if (eventTicker.trim() === "") {
      throw new Error("event ticker is empty.");
    }
    if (eventTicker.includes(MEMO_SEPARATOR)) {
      throw new Error(`event ticker "${eventTicker}" contains the "|" separator.`);
    }
    const planHash = await hashPlan(eventTicker, exposure, plan);
    const parts = [
      RECEIPT_PREFIX,
      eventTicker,
      `q=${formatMemoNumber(exposure.quantity, "exposure quantity")}`,
      `floor=${formatMemoNumber(plan.requestedMaxLoss, "max loss")}`,
      `cost=${round6(plan.totalCost, "total cost").toFixed(2)}`,
      `legs=${plan.legs.length}`,
      `h=${planHash.slice(0, MEMO_HASH_PREFIX_LENGTH)}`,
    ];
    const memo = parts.join(MEMO_SEPARATOR);
    const byteLength = new TextEncoder().encode(memo).length;
    if (byteLength >= MAX_MEMO_BYTES) {
      throw new Error(`memo is ${byteLength} bytes; it must be under ${MAX_MEMO_BYTES}.`);
    }
    return { memo, planHash };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to build hedge receipt memo: ${message}`, { cause: error });
  }
}

/**
 * Removes the `[length] ` tag that RPC nodes prepend to each memo.
 *
 * @param {string} memo - Memo text, possibly tagged.
 * @returns {string} The memo without a leading length tag.
 */
function stripLengthTag(memo: string): string {
  return memo.replace(LENGTH_TAG_PATTERN, "");
}

/**
 * Pulls the Ladder Hedge receipt out of the `memo` field that `getSignaturesForAddress`
 * returns. The RPC formats each memo as `[length] text` and joins several memos with `; `.
 *
 * @param {string | null} rpcMemo - Raw `memo` field from the RPC, or null.
 * @returns {string | null} The first receipt memo without its length tag, or null if none.
 */
export function extractReceiptMemo(rpcMemo: string | null): string | null {
  if (rpcMemo === null) {
    return null;
  }
  const segments = rpcMemo.split(/;\s(?=\[\d+\]\s)/);
  for (const segment of segments) {
    const stripped = stripLengthTag(segment.trim());
    if (stripped.startsWith(`${RECEIPT_PREFIX}${MEMO_SEPARATOR}`)) {
      return stripped;
    }
  }
  return null;
}

/**
 * Parses a `key=value` memo field into a finite number.
 *
 * @param {string} part - The field text, for example `q=10`.
 * @param {string} key - Expected key.
 * @returns {number | null} The number, or null if the key or value is invalid.
 */
function parseNumberField(part: string, key: string): number | null {
  const prefix = `${key}=`;
  if (!part.startsWith(prefix)) {
    return null;
  }
  const raw = part.slice(prefix.length);
  if (raw.trim() === "") {
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return null;
  }
  return value;
}

/**
 * Parses a receipt memo back into its fields.
 *
 * Accepts memos with or without the RPC `[length] ` tag.
 *
 * @param {string} memo - Memo text.
 * @returns {ParsedReceiptMemo | null} Parsed fields, or null if the memo is not a valid
 *   Ladder Hedge receipt.
 */
export function parseReceiptMemo(memo: string): ParsedReceiptMemo | null {
  const stripped = stripLengthTag(memo.trim());
  const parts = stripped.split(MEMO_SEPARATOR);
  if (parts.length !== 7 || parts[0] !== RECEIPT_PREFIX) {
    return null;
  }
  const [, eventTicker, quantityPart, floorPart, costPart, legsPart, hashPart] = parts;
  if (eventTicker.trim() === "") {
    return null;
  }
  const quantity = parseNumberField(quantityPart, "q");
  const maxLoss = parseNumberField(floorPart, "floor");
  const totalCost = parseNumberField(costPart, "cost");
  const legCount = parseNumberField(legsPart, "legs");
  if (quantity === null || maxLoss === null || totalCost === null || legCount === null) {
    return null;
  }
  if (!Number.isInteger(legCount) || legCount < 0) {
    return null;
  }
  if (!hashPart.startsWith("h=")) {
    return null;
  }
  const planHash = hashPart.slice(2);
  if (!HASH_PREFIX_PATTERN.test(planHash)) {
    return null;
  }
  return { eventTicker, quantity, maxLoss, totalCost, legCount, planHash };
}
