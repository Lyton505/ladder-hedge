import type { SpotQuote } from "@/lib/hedge/types";
import { isRecord, parseDecimal } from "@/lib/gemini/parse-ladder";

/** Base URL of Gemini's public REST API. No API key is needed for the endpoints used here. */
export const GEMINI_API_BASE = "https://api.gemini.com";

/** Every Gemini request is abandoned after this many milliseconds. */
export const GEMINI_TIMEOUT_MS = 8000;

/** Page size for the events endpoint; Gemini accepts up to 500. */
const EVENTS_PAGE_SIZE = 500;

/** Hard stop on paging, so a misbehaving `pagination.total` cannot loop forever. */
const MAX_EVENT_PAGES = 10;

/** Event tickers are upper-case letters, digits and dashes, for example "SOL2611202200". */
const EVENT_TICKER = /^[A-Z0-9][A-Z0-9-]{2,63}$/;

/** Asset codes are short upper-case alphanumerics, for example "SOL". */
const ASSET_CODE = /^[A-Z0-9]{2,10}$/;

/** Why a Gemini request failed. */
export type GeminiErrorKind = "invalid-input" | "timeout" | "network" | "not-found" | "http" | "invalid-response";

/** A typed failure from the Gemini client. */
export class GeminiError extends Error {
  readonly kind: GeminiErrorKind;
  readonly status: number | null;

  /**
   * Creates a Gemini client error.
   *
   * @param {GeminiErrorKind} kind - The failure category.
   * @param {string} message - Human-readable description.
   * @param {number | null} [status] - Upstream HTTP status, when there was one.
   * @param {unknown} [cause] - The underlying error, when there was one.
   */
  constructor(kind: GeminiErrorKind, message: string, status: number | null = null, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GeminiError";
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Normalises and validates an event ticker.
 *
 * @param {string} ticker - A ticker such as "sol2611202200".
 * @returns {string} The upper-cased ticker.
 * @throws {GeminiError} kind "invalid-input" when the ticker has unexpected characters.
 */
export function normalizeEventTicker(ticker: string): string {
  const upper = ticker.trim().toUpperCase();
  if (!EVENT_TICKER.test(upper)) {
    throw new GeminiError("invalid-input", `Invalid event ticker: ${ticker.slice(0, 80)}`);
  }
  return upper;
}

/**
 * Normalises and validates an asset code.
 *
 * @param {string} asset - An asset such as "sol".
 * @returns {string} The upper-cased asset code.
 * @throws {GeminiError} kind "invalid-input" when the asset has unexpected characters.
 */
export function normalizeAsset(asset: string): string {
  const upper = asset.trim().toUpperCase();
  if (!ASSET_CODE.test(upper)) {
    throw new GeminiError("invalid-input", `Invalid asset: ${asset.slice(0, 20)}`);
  }
  return upper;
}

/**
 * Performs a GET against the Gemini API and parses the JSON body.
 *
 * @param {string} path - Path and query, starting with "/".
 * @returns {Promise<unknown>} The parsed, still untrusted, JSON body.
 * @throws {GeminiError} On timeout, network failure, a non-2xx status, or a body that is not JSON.
 */
async function getJson(path: string): Promise<unknown> {
  const url = `${GEMINI_API_BASE}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });
  } catch (error) {
    const isTimeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    if (isTimeout) {
      throw new GeminiError("timeout", `Gemini did not answer within ${GEMINI_TIMEOUT_MS} ms: ${path}`, null, error);
    }
    throw new GeminiError("network", `Could not reach Gemini: ${path}`, null, error);
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new GeminiError("network", `Gemini response body could not be read: ${path}`, response.status, error);
  }

  if (response.status === 404) {
    throw new GeminiError("not-found", `Gemini returned 404 for ${path}`, 404);
  }
  if (!response.ok) {
    throw new GeminiError("http", `Gemini returned HTTP ${response.status} for ${path}`, response.status);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new GeminiError("invalid-response", `Gemini returned a body that is not JSON: ${path}`, response.status, error);
  }
}

/**
 * Fetches every active event in Gemini's crypto category, paging until the reported total.
 * The `category=crypto` filter is verified to return only events with `category: "Crypto"`;
 * callers still check the category of each event.
 *
 * @returns {Promise<unknown[]>} Raw, untrusted event objects (ladders and binary up/down events).
 * @throws {GeminiError} When any page fails or has an unexpected shape.
 */
export async function fetchActiveCryptoEvents(): Promise<unknown[]> {
  const events: unknown[] = [];
  try {
    for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
      const offset = page * EVENTS_PAGE_SIZE;
      const body = await getJson(
        `/v1/prediction-markets/events?status=active&category=crypto&limit=${EVENTS_PAGE_SIZE}&offset=${offset}`,
      );
      if (!isRecord(body) || !Array.isArray(body.data)) {
        throw new GeminiError("invalid-response", "Gemini events response has no data array");
      }
      events.push(...body.data);
      const pagination = isRecord(body.pagination) ? body.pagination : null;
      const total = parseDecimal(pagination?.total);
      const reachedEnd = body.data.length < EVENTS_PAGE_SIZE || total === null || offset + body.data.length >= total;
      if (reachedEnd) {
        break;
      }
    }
    return events;
  } catch (error) {
    if (error instanceof GeminiError) {
      throw error;
    }
    throw new GeminiError("invalid-response", "Failed to load active crypto events", null, error);
  }
}

/**
 * Fetches one prediction-market event by ticker.
 *
 * @param {string} ticker - Event ticker such as "SOL2611202200".
 * @returns {Promise<unknown>} The raw, untrusted event object.
 * @throws {GeminiError} kind "invalid-input" for a malformed ticker, "not-found" when Gemini has no such event, or another kind on failure.
 */
export async function fetchEvent(ticker: string): Promise<unknown> {
  try {
    const normalized = normalizeEventTicker(ticker);
    const body = await getJson(`/v1/prediction-markets/events/${encodeURIComponent(normalized)}`);
    if (!isRecord(body)) {
      throw new GeminiError("invalid-response", `Gemini event response for ${normalized} is not an object`);
    }
    return body;
  } catch (error) {
    if (error instanceof GeminiError) {
      throw error;
    }
    throw new GeminiError("invalid-response", `Failed to load event ${ticker.slice(0, 80)}`, null, error);
  }
}

/**
 * Fetches the spot price of an asset from Gemini's `{asset}usd` public ticker.
 * The price is the bid/ask mid; when only one side is usable the last trade is used.
 *
 * @param {string} asset - Asset code such as "SOL".
 * @returns {Promise<SpotQuote>} The spot quote, stamped with the time it was fetched.
 * @throws {GeminiError} kind "invalid-input" for a malformed asset, "not-found" when Gemini has no USD ticker for it, or another kind on failure.
 */
export async function fetchSpot(asset: string): Promise<SpotQuote> {
  try {
    const code = normalizeAsset(asset);
    const symbol = `${code}USD`;
    let body: unknown;
    try {
      body = await getJson(`/v1/pubticker/${symbol.toLowerCase()}`);
    } catch (error) {
      if (error instanceof GeminiError && (error.kind === "not-found" || error.status === 400)) {
        throw new GeminiError("not-found", `Gemini has no ${symbol} ticker`, error.status, error);
      }
      throw error;
    }
    if (!isRecord(body)) {
      throw new GeminiError("invalid-response", `Gemini ${symbol} ticker response is not an object`);
    }
    const bid = parseDecimal(body.bid);
    const ask = parseDecimal(body.ask);
    const last = parseDecimal(body.last);
    const asOf = new Date().toISOString();
    if (bid !== null && ask !== null && bid > 0 && ask >= bid) {
      return { asset: code, price: (bid + ask) / 2, source: `Gemini ${symbol} ticker (bid/ask mid)`, asOf };
    }
    if (last !== null && last > 0) {
      return { asset: code, price: last, source: `Gemini ${symbol} ticker (last trade)`, asOf };
    }
    throw new GeminiError("invalid-response", `Gemini ${symbol} ticker has no usable price`);
  } catch (error) {
    if (error instanceof GeminiError) {
      throw error;
    }
    throw new GeminiError("invalid-response", `Failed to load spot for ${asset.slice(0, 20)}`, null, error);
  }
}
