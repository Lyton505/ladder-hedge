import type { Ladder, LadderSummary, SpotQuote } from "@/lib/hedge/types";

/**
 * Browser-side access to the app's own JSON routes.
 *
 * Client code talks to `/api/ladders`, `/api/ladders/{ticker}` and `/api/spot`
 * through these helpers only. It must never import `src/lib/gemini/ladder-service.ts`
 * or `order-book.ts`, which pull in `ws` and the JSON fixtures.
 */

/** How long the browser waits for one of the app's routes before giving up. */
export const API_TIMEOUT_MS = 15_000;

/**
 * Provenance of a snapshot ladder, as returned by `/api/ladders/{ticker}`.
 * Mirrors `SnapshotInfo` in the server's ladder service, redeclared here so the
 * client never imports server modules.
 */
export interface SnapshotMeta {
  eventTicker: string;
  liveTicker: string;
  capturedAt: string;
  referenceSpot: number;
  /** True when `referenceSpot` was estimated from the ladder rather than observed. */
  spotIsEstimated: boolean;
  spotSource: string;
}

/** Body of a successful `/api/ladders/{ticker}` response. */
export interface LadderResponse {
  ladder: Ladder;
  snapshot: SnapshotMeta | null;
}

/** An error from one of the app's routes, with the HTTP status when there was one. */
export class ApiError extends Error {
  /** HTTP status, or null when the request never got a response. */
  readonly status: number | null;

  /**
   * Creates an API error.
   *
   * @param {string} message - Readable description, suitable for the UI.
   * @param {number | null} status - HTTP status, or null for network failures and timeouts.
   * @param {unknown} [cause] - The underlying error, when there was one.
   */
  constructor(message: string, status: number | null, cause?: unknown) {
    super(message, { cause });
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Checks whether a value is a non-null object.
 *
 * @param {unknown} value - Value to check.
 * @returns {boolean} True for objects other than null.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Checks the fields of a ladder summary that the UI relies on.
 *
 * @param {unknown} value - Parsed JSON entry.
 * @returns {boolean} True when the entry can be used as a `LadderSummary`.
 */
function isLadderSummary(value: unknown): value is LadderSummary {
  return (
    isRecord(value) &&
    typeof value.eventTicker === "string" &&
    typeof value.title === "string" &&
    typeof value.asset === "string" &&
    typeof value.expiry === "string" &&
    typeof value.rungCount === "number" &&
    typeof value.quotedRungCount === "number" &&
    (value.source === "live" || value.source === "snapshot")
  );
}

/**
 * Checks the fields of a ladder that the engine and UI rely on.
 *
 * @param {unknown} value - Parsed JSON value.
 * @returns {boolean} True when the value can be used as a `Ladder`.
 */
function isLadder(value: unknown): value is Ladder {
  return (
    isRecord(value) &&
    typeof value.eventTicker === "string" &&
    typeof value.title === "string" &&
    typeof value.asset === "string" &&
    typeof value.expiry === "string" &&
    typeof value.fetchedAt === "string" &&
    (value.source === "live" || value.source === "snapshot") &&
    (value.referenceSpot === null || typeof value.referenceSpot === "number") &&
    Array.isArray(value.rungs) &&
    value.rungs.every((rung) => isRecord(rung) && typeof rung.strike === "number")
  );
}

/**
 * Checks the shape of snapshot provenance.
 *
 * @param {unknown} value - Parsed JSON value.
 * @returns {boolean} True when the value can be used as `SnapshotMeta`.
 */
function isSnapshotMeta(value: unknown): value is SnapshotMeta {
  return (
    isRecord(value) &&
    typeof value.eventTicker === "string" &&
    typeof value.capturedAt === "string" &&
    typeof value.referenceSpot === "number" &&
    typeof value.spotIsEstimated === "boolean" &&
    typeof value.spotSource === "string"
  );
}

/**
 * Checks the shape of a spot quote.
 *
 * @param {unknown} value - Parsed JSON value.
 * @returns {boolean} True when the value can be used as a `SpotQuote`.
 */
function isSpotQuote(value: unknown): value is SpotQuote {
  return (
    isRecord(value) &&
    typeof value.asset === "string" &&
    typeof value.price === "number" &&
    Number.isFinite(value.price) &&
    typeof value.source === "string" &&
    typeof value.asOf === "string"
  );
}

/**
 * Fetches one of the app's JSON routes and returns the parsed body.
 *
 * @param {string} url - Same-origin route URL.
 * @param {AbortSignal} [signal] - Cancels the request, for example when the component unmounts.
 * @returns {Promise<unknown>} The parsed JSON body of a 2xx response.
 * @throws {ApiError} With the route's `{ error }` message for 4xx and 5xx responses, or a
 *   readable message for timeouts, network failures and unreadable bodies.
 * @throws {DOMException} An `AbortError` when `signal` aborts, so callers can ignore it.
 */
export async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(API_TIMEOUT_MS);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", signal: combined });
  } catch (error) {
    if (signal?.aborted === true) {
      throw error;
    }
    if (timeout.aborted) {
      throw new ApiError(`The server did not answer within ${API_TIMEOUT_MS / 1000} seconds.`, null, error);
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new ApiError(`Could not reach the server (${detail}).`, null, error);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (signal?.aborted === true) {
      throw error;
    }
    throw new ApiError(`The server sent an unreadable reply (HTTP ${response.status}).`, response.status, error);
  }

  if (!response.ok) {
    const message =
      isRecord(body) && typeof body.error === "string" && body.error !== ""
        ? body.error
        : `The server answered HTTP ${response.status}.`;
    throw new ApiError(message, response.status);
  }
  return body;
}

/**
 * Lists the ladders for an asset: live ladders first, then captured snapshots.
 *
 * @param {string} asset - Asset code, for example "SOL".
 * @param {AbortSignal} [signal] - Cancels the request.
 * @returns {Promise<LadderSummary[]>} Ladder summaries in the server's order.
 * @throws {ApiError} When the route fails or answers with an unexpected shape.
 */
export async function fetchLadderList(asset: string, signal?: AbortSignal): Promise<LadderSummary[]> {
  try {
    const body = await fetchJson(`/api/ladders?asset=${encodeURIComponent(asset)}`, signal);
    if (!isRecord(body) || !Array.isArray(body.ladders)) {
      throw new ApiError("The ladder list came back in an unexpected shape.", null);
    }
    return body.ladders.filter(isLadderSummary);
  } catch (error) {
    if (error instanceof ApiError || signal?.aborted === true) {
      throw error;
    }
    throw new ApiError(`Could not load the ladder list: ${String(error)}`, null, error);
  }
}

/**
 * Loads one ladder with its snapshot provenance.
 *
 * @param {string} ticker - Live or snapshot event ticker.
 * @param {AbortSignal} [signal] - Cancels the request.
 * @returns {Promise<LadderResponse>} The ladder and, for snapshots, where it came from.
 * @throws {ApiError} When the route fails (404 for unknown or settled ladders, 502 when Gemini
 *   fails with no snapshot to stand in) or answers with an unexpected shape.
 */
export async function fetchLadder(ticker: string, signal?: AbortSignal): Promise<LadderResponse> {
  try {
    const body = await fetchJson(`/api/ladders/${encodeURIComponent(ticker)}`, signal);
    if (!isRecord(body) || !isLadder(body.ladder)) {
      throw new ApiError(`Ladder ${ticker} came back in an unexpected shape.`, null);
    }
    const snapshot = isSnapshotMeta(body.snapshot) ? body.snapshot : null;
    return { ladder: body.ladder, snapshot };
  } catch (error) {
    if (error instanceof ApiError || signal?.aborted === true) {
      throw error;
    }
    throw new ApiError(`Could not load ladder ${ticker}: ${String(error)}`, null, error);
  }
}

/**
 * Reads the spot price for an asset.
 *
 * @param {string} asset - Asset code, for example "SOL".
 * @param {AbortSignal} [signal] - Cancels the request.
 * @returns {Promise<SpotQuote>} The quote and its source.
 * @throws {ApiError} When the route fails or answers with an unexpected shape.
 */
export async function fetchSpot(asset: string, signal?: AbortSignal): Promise<SpotQuote> {
  try {
    const body = await fetchJson(`/api/spot?asset=${encodeURIComponent(asset)}`, signal);
    if (!isRecord(body) || !isSpotQuote(body.spot)) {
      throw new ApiError(`The ${asset} spot price came back in an unexpected shape.`, null);
    }
    return body.spot;
  } catch (error) {
    if (error instanceof ApiError || signal?.aborted === true) {
      throw error;
    }
    throw new ApiError(`Could not load the ${asset} spot price: ${String(error)}`, null, error);
  }
}

/**
 * True when an error is the abort of a request we cancelled ourselves.
 *
 * @param {unknown} error - The thrown value.
 * @param {AbortSignal} signal - The signal the caller controls.
 * @returns {boolean} True when the error should be ignored because the caller aborted.
 */
export function isOwnAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && !(error instanceof ApiError);
}

/**
 * Formats an unknown thrown value as a readable message.
 *
 * @param {unknown} error - The thrown value.
 * @returns {string} The message.
 */
export function describeClientError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
