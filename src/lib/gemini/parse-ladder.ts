import type { DataSource, Ladder, LadderRung, LadderSummary } from "@/lib/hedge/types";

/** Matches a ladder contract label such as "$72 or above" or "$61,200 or above". */
const OR_ABOVE_LABEL = /^\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s+or\s+above\s*$/i;

/** Leading letters of an event ticker such as "SOL2611200500" are the asset. */
const TICKER_ASSET = /^([A-Z]+)[0-9]/;

/** Instrument symbols are plain identifiers such as "GEMI-SOL2611200500-HI72". */
const INSTRUMENT_SYMBOL = /^[A-Za-z0-9-]{1,80}$/;

/** Quantity step used when a contract does not state a valid one. */
const DEFAULT_QUANTITY_INCREMENT = 1;

/** Smallest number of rungs that still makes a usable ladder. */
const MIN_RUNGS = 2;

/**
 * Narrows an unknown value to a plain object record.
 *
 * @param {unknown} value - Any value.
 * @returns {boolean} True when the value is a non-null, non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a decimal value that Gemini may send as a string or a number.
 *
 * @param {unknown} value - The raw field value.
 * @returns {number | null} The finite number, or null when absent or not numeric.
 */
export function parseDecimal(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Reads a contract price in dollars. Prices at or outside the 0..1 bounds carry no
 * information about the book and are treated as unquoted.
 *
 * @param {unknown} value - The raw price field.
 * @returns {number | null} A price strictly between 0 and 1, or null.
 */
function parseQuotePrice(value: unknown): number | null {
  const parsed = parseDecimal(value);
  if (parsed === null || parsed <= 0 || parsed >= 1) {
    return null;
  }
  return parsed;
}

/**
 * Extracts the dollar strike from an "or above" contract label.
 *
 * @param {string} label - A label such as "$61,200 or above".
 * @returns {number | null} The strike, or null when the label is not an "or above" ladder label.
 */
export function parseStrikeLabel(label: string): number | null {
  const match = OR_ABOVE_LABEL.exec(label);
  if (match === null) {
    return null;
  }
  const strike = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(strike) && strike > 0 ? strike : null;
}

/**
 * Reads a nested record field, tolerating a missing or malformed parent.
 *
 * @param {unknown} parent - The object that may hold the field.
 * @param {string} key - The field name.
 * @returns {Record<string, unknown> | null} The nested record, or null.
 */
function readRecord(parent: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(parent)) {
    return null;
  }
  const child = parent[key];
  return isRecord(child) ? child : null;
}

/**
 * Converts one raw Gemini contract into a ladder rung.
 *
 * @param {unknown} rawContract - One element of the event's `contracts` array.
 * @returns {LadderRung | null} The rung, or null when the contract is not an active "or above" contract.
 */
function parseRung(rawContract: unknown): LadderRung | null {
  if (!isRecord(rawContract)) {
    return null;
  }
  const { label, instrumentSymbol, status } = rawContract;
  if (typeof label !== "string" || typeof instrumentSymbol !== "string") {
    return null;
  }
  if (!INSTRUMENT_SYMBOL.test(instrumentSymbol) || status !== "active") {
    return null;
  }
  const strike = parseStrikeLabel(label);
  if (strike === null) {
    return null;
  }

  // Only bestBid/bestAsk describe the book. `prices.sell.yes` and `prices.buy.yes` equal
  // them when a side is quoted, but when a side is empty Gemini fills them with
  // `lastTradePrice` (seen on 87 of 87 empty sides with a last trade, 2026-11-20), which
  // would invent a quote and can cross the book. They are therefore not used as fallbacks.
  const prices = readRecord(rawContract, "prices");
  const yesBid = parseQuotePrice(prices?.bestBid);
  const yesAsk = parseQuotePrice(prices?.bestAsk);

  const increment = parseDecimal(rawContract.quantityIncrement);
  const quantityIncrement = increment !== null && increment > 0 ? increment : DEFAULT_QUANTITY_INCREMENT;

  return {
    instrumentSymbol,
    label,
    strike,
    yesBid,
    yesAsk,
    yesBidSize: null,
    yesAskSize: null,
    quantityIncrement,
  };
}

/**
 * Converts a raw Gemini prediction-market event into a price ladder.
 *
 * Only crypto categorical events with at least two active "or above" contracts are
 * ladders. Binary up/down events, sports events and malformed input return null.
 * Rungs are sorted ascending by strike; a repeated strike keeps its first contract.
 *
 * @param {unknown} rawEvent - One event object as returned by the Gemini API (untrusted).
 * @param {DataSource} source - Whether the event came from the live API or a snapshot.
 * @param {string} fetchedAt - ISO 8601 time the event was fetched or captured.
 * @param {number | null} referenceSpot - Spot price at capture for snapshots; null for live ladders.
 * @returns {Ladder | null} The ladder, or null when the event is not a usable crypto ladder.
 */
export function parseLadder(
  rawEvent: unknown,
  source: DataSource,
  fetchedAt: string,
  referenceSpot: number | null,
): Ladder | null {
  if (!isRecord(rawEvent)) {
    return null;
  }
  const { type, category, ticker, title, expiryDate, contracts } = rawEvent;
  if (type !== "categorical" || typeof category !== "string" || category.toLowerCase() !== "crypto") {
    return null;
  }
  if (typeof ticker !== "string" || typeof expiryDate !== "string" || !Array.isArray(contracts)) {
    return null;
  }
  const assetMatch = TICKER_ASSET.exec(ticker);
  if (assetMatch === null) {
    return null;
  }
  const expiryTime = Date.parse(expiryDate);
  if (Number.isNaN(expiryTime)) {
    return null;
  }

  const parsedRungs: LadderRung[] = [];
  for (const rawContract of contracts) {
    const rung = parseRung(rawContract);
    if (rung !== null) {
      parsedRungs.push(rung);
    }
  }

  // A stable sort keeps the original order among equal strikes, so the first one wins.
  const sorted = [...parsedRungs].sort((a, b) => a.strike - b.strike);
  const rungs: LadderRung[] = [];
  for (const rung of sorted) {
    const previous = rungs[rungs.length - 1];
    if (previous === undefined || previous.strike !== rung.strike) {
      rungs.push(rung);
    }
  }
  if (rungs.length < MIN_RUNGS) {
    return null;
  }

  return {
    eventTicker: ticker,
    title: typeof title === "string" && title.trim() !== "" ? title : ticker,
    asset: assetMatch[1],
    expiry: new Date(expiryTime).toISOString(),
    rungs,
    fetchedAt,
    source,
    referenceSpot,
  };
}

/**
 * Summarises a ladder for list views.
 *
 * @param {Ladder} ladder - A parsed ladder.
 * @returns {LadderSummary} The summary; a rung counts as quoted when it has a bid or an ask.
 */
export function summarizeLadder(ladder: Ladder): LadderSummary {
  const quotedRungCount = ladder.rungs.filter((rung) => rung.yesBid !== null || rung.yesAsk !== null).length;
  return {
    eventTicker: ladder.eventTicker,
    title: ladder.title,
    asset: ladder.asset,
    expiry: ladder.expiry,
    rungCount: ladder.rungs.length,
    quotedRungCount,
    source: ladder.source,
  };
}
