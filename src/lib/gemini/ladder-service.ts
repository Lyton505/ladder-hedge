import type { Ladder, LadderRung, LadderSummary, SpotQuote } from "@/lib/hedge/types";
import {
  GeminiError,
  fetchActiveCryptoEvents,
  fetchEvent,
  fetchSpot,
  normalizeAsset,
  normalizeEventTicker,
} from "@/lib/gemini/gemini-client";
import { fetchTopOfBookSizes } from "@/lib/gemini/order-book";
import type { TopOfBook } from "@/lib/gemini/order-book";
import { isRecord, parseLadder, summarizeLadder } from "@/lib/gemini/parse-ladder";
import snapshotMeta from "../../../fixtures/gemini/snapshot-meta.json";
import btc2611200500 from "../../../fixtures/gemini/btc-2611200500.json";
import btc2611202200 from "../../../fixtures/gemini/btc-2611202200.json";
import eth2611200500 from "../../../fixtures/gemini/eth-2611200500.json";
import eth2611202200 from "../../../fixtures/gemini/eth-2611202200.json";
import sol2611200500 from "../../../fixtures/gemini/sol-2611200500.json";
import sol2611202200 from "../../../fixtures/gemini/sol-2611202200.json";
import btc2611302200 from "../../../fixtures/gemini/btc-2611302200.json";
import eth2611302200 from "../../../fixtures/gemini/eth-2611302200.json";
import sol2611302200 from "../../../fixtures/gemini/sol-2611302200.json";

/** Suffix that marks a snapshot ticker so it never collides with a live ticker. */
export const SNAPSHOT_SUFFIX = "-SNAPSHOT";

/** How long a live ladder request waits for order-book sizes before leaving them null. */
export const ORDER_BOOK_TIMEOUT_MS = 2500;

/**
 * How long a fetched crypto events list is reused before Gemini is asked again. Ladders
 * built from a cached list keep the time the list was actually fetched as `fetchedAt`.
 */
export const EVENTS_CACHE_TTL_MS = 20_000;

/** Captured event files, keyed by the file name used in `snapshot-meta.json`. */
const SNAPSHOT_FILES: Readonly<Record<string, unknown>> = {
  "sol-2611302200.json": sol2611302200,
  "btc-2611302200.json": btc2611302200,
  "eth-2611302200.json": eth2611302200,
  "sol-2611202200.json": sol2611202200,
  "btc-2611202200.json": btc2611202200,
  "eth-2611202200.json": eth2611202200,
  "sol-2611200500.json": sol2611200500,
  "btc-2611200500.json": btc2611200500,
  "eth-2611200500.json": eth2611200500,
};

/** Provenance of a snapshot ladder, for labelling in the UI. */
export interface SnapshotInfo {
  /** Snapshot ticker, ending in `-SNAPSHOT`. */
  eventTicker: string;
  /** The live ticker the snapshot was captured from. */
  liveTicker: string;
  capturedAt: string;
  referenceSpot: number;
  /** True when `referenceSpot` was estimated from the ladder rather than observed. */
  spotIsEstimated: boolean;
  spotSource: string;
}

interface SnapshotEntry {
  info: SnapshotInfo;
  ladder: Ladder;
}

/** Ladders listed for an asset, and whether the live part of the list failed. */
export interface LadderList {
  /** Live ladders (when the live call worked) followed by snapshots. */
  ladders: LadderSummary[];
  /**
   * Short reason the live Gemini list could not be read, so only snapshots are listed;
   * null when the live call worked (even if it found no live ladder) or live data is disabled.
   */
  liveError: string | null;
}

/** One ladder, and why a snapshot stands in for it when a live ticker was asked for. */
export interface LadderLoad {
  ladder: Ladder;
  /**
   * Short reason live data could not be served when a live ticker was requested and a
   * snapshot of it is returned instead; null when the ladder is what was asked for.
   */
  liveError: string | null;
}

/** A crypto events list read from Gemini, with the time it was read. */
interface FetchedEvents {
  events: unknown[];
  /** ISO time the list was fetched from Gemini. */
  fetchedAt: string;
  fetchedMs: number;
}

/** Last events list read from Gemini, reused for EVENTS_CACHE_TTL_MS; failures are never cached. */
let eventsCache: FetchedEvents | null = null;

/** The requested ladder does not exist, is not a crypto ladder, or is no longer tradable. */
export class LadderNotFoundError extends Error {
  /**
   * Creates a not-found error.
   *
   * @param {string} message - Human-readable description.
   * @param {unknown} [cause] - The underlying error, when there was one.
   */
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LadderNotFoundError";
  }
}

/** Gemini could not be reached or answered badly, and no snapshot can stand in. */
export class LadderUnavailableError extends Error {
  /**
   * Creates an upstream-unavailable error.
   *
   * @param {string} message - Human-readable description.
   * @param {unknown} [cause] - The underlying error, when there was one.
   */
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LadderUnavailableError";
  }
}

/**
 * Reports whether live Gemini calls are disabled by `LADDER_FORCE_SNAPSHOT=1`.
 *
 * @returns {boolean} True when only snapshots may be served.
 */
export function isForceSnapshot(): boolean {
  return process.env.LADDER_FORCE_SNAPSHOT === "1";
}

/**
 * Builds the snapshot entry described by one `snapshot-meta.json` record.
 *
 * @param {unknown} rawMeta - One element of the meta file's `snapshots` array.
 * @returns {SnapshotEntry} The parsed snapshot ladder and its provenance.
 * @throws {Error} When the record or its event file is malformed; fixtures are checked by tests.
 */
function buildSnapshotEntry(rawMeta: unknown): SnapshotEntry {
  if (!isRecord(rawMeta)) {
    throw new Error("snapshot-meta.json: entry is not an object");
  }
  const { ticker, file, capturedAt, referenceSpot, spotIsEstimated, spotSource } = rawMeta;
  if (
    typeof ticker !== "string" ||
    typeof file !== "string" ||
    typeof capturedAt !== "string" ||
    typeof referenceSpot !== "number" ||
    typeof spotIsEstimated !== "boolean" ||
    typeof spotSource !== "string"
  ) {
    throw new Error(`snapshot-meta.json: entry ${String(ticker)} has missing or mistyped fields`);
  }
  const capturedTime = Date.parse(capturedAt);
  if (Number.isNaN(capturedTime)) {
    throw new Error(`snapshot-meta.json: entry ${ticker} has an invalid capturedAt`);
  }
  const rawEvent = SNAPSHOT_FILES[file];
  if (rawEvent === undefined) {
    throw new Error(`snapshot-meta.json: entry ${ticker} names unknown file ${file}`);
  }
  const capturedIso = new Date(capturedTime).toISOString();
  const parsed = parseLadder(rawEvent, "snapshot", capturedIso, referenceSpot);
  if (parsed === null || parsed.eventTicker !== ticker) {
    throw new Error(`snapshot-meta.json: file ${file} is not a ladder for ${ticker}`);
  }
  const eventTicker = `${ticker}${SNAPSHOT_SUFFIX}`;
  return {
    info: { eventTicker, liveTicker: ticker, capturedAt: capturedIso, referenceSpot, spotIsEstimated, spotSource },
    ladder: { ...parsed, eventTicker },
  };
}

let snapshotCache: SnapshotEntry[] | null = null;

/**
 * Loads every captured snapshot in preference order (the first per asset is its default).
 *
 * @returns {SnapshotEntry[]} Snapshot ladders and provenance.
 * @throws {Error} When the bundled fixtures are malformed.
 */
function loadSnapshots(): SnapshotEntry[] {
  if (snapshotCache !== null) {
    return snapshotCache;
  }
  const entries: unknown = isRecord(snapshotMeta) ? snapshotMeta.snapshots : null;
  if (!Array.isArray(entries)) {
    throw new Error("snapshot-meta.json: snapshots is not an array");
  }
  snapshotCache = entries.map((entry) => buildSnapshotEntry(entry));
  return snapshotCache;
}

/**
 * Counts the rungs quoted on both sides (a YES bid and a YES ask).
 *
 * @param {Ladder} ladder - The ladder.
 * @returns {number} Number of two-sided rungs.
 */
function twoSidedRungs(ladder: Ladder): number {
  return ladder.rungs.filter((rung) => rung.yesBid !== null && rung.yesAsk !== null).length;
}

/**
 * Lists the snapshots of an asset in preference order: those that have not expired first,
 * by most two-sided rungs and then later expiry, followed by expired ones in the order of
 * `snapshot-meta.json`. The first entry for an asset is its default snapshot.
 *
 * @param {string | null} asset - Upper-case asset code, or null for all assets.
 * @param {number} nowMs - Current time in epoch milliseconds.
 * @returns {SnapshotEntry[]} Snapshot entries in preference order.
 * @throws {Error} When the bundled fixtures are malformed.
 */
function orderedSnapshots(asset: string | null, nowMs: number): SnapshotEntry[] {
  const entries = loadSnapshots().filter((entry) => asset === null || entry.ladder.asset === asset);
  const unexpired = entries.filter((entry) => Date.parse(entry.ladder.expiry) > nowMs);
  const expired = entries.filter((entry) => !(Date.parse(entry.ladder.expiry) > nowMs));
  unexpired.sort(
    (a, b) =>
      twoSidedRungs(b.ladder) - twoSidedRungs(a.ladder) || Date.parse(b.ladder.expiry) - Date.parse(a.ladder.expiry),
  );
  return [...unexpired, ...expired];
}

/**
 * Returns a deep copy of a ladder so callers cannot mutate the cached snapshots.
 *
 * @param {Ladder} ladder - The ladder to copy.
 * @returns {Ladder} An independent copy.
 */
function cloneLadder(ladder: Ladder): Ladder {
  return { ...ladder, rungs: ladder.rungs.map((rung) => ({ ...rung })) };
}

/**
 * Lists snapshot ladders, optionally for one asset.
 *
 * @param {string | null} asset - Upper-case asset code, or null for all.
 * @returns {Ladder[]} Snapshot ladders in preference order (see `orderedSnapshots`).
 */
function snapshotLadders(asset: string | null): Ladder[] {
  return orderedSnapshots(asset, Date.now()).map((entry) => cloneLadder(entry.ladder));
}

/**
 * Forgets the cached crypto events list, so the next list call asks Gemini. Used by tests.
 *
 * @returns {void}
 */
export function clearEventsCache(): void {
  eventsCache = null;
}

/**
 * Reads Gemini's active crypto events, reusing a list fetched less than
 * EVENTS_CACHE_TTL_MS ago. A failed read is retried once; failures are not cached.
 *
 * @returns {Promise<FetchedEvents>} The events and the time they were fetched.
 * @throws {GeminiError} When both attempts fail.
 */
async function loadCryptoEvents(): Promise<FetchedEvents> {
  const cached = eventsCache;
  if (cached !== null && Date.now() - cached.fetchedMs < EVENTS_CACHE_TTL_MS) {
    return cached;
  }
  let events: unknown[];
  try {
    events = await fetchActiveCryptoEvents();
  } catch (firstError) {
    console.warn(`[ladder-service] live ladder list failed, retrying once: ${describeError(firstError)}`);
    // A second failure propagates to the caller, which serves snapshots and reports it.
    events = await fetchActiveCryptoEvents();
  }
  const fetchedMs = Date.now();
  const fetched: FetchedEvents = { events, fetchedAt: new Date(fetchedMs).toISOString(), fetchedMs };
  eventsCache = fetched;
  return fetched;
}

/**
 * Finds a snapshot by its snapshot ticker or by the live ticker it was captured from.
 *
 * @param {string} ticker - "SOL2611202200-SNAPSHOT" or "SOL2611202200" (any case).
 * @returns {SnapshotEntry | null} The snapshot, or null.
 */
function findSnapshot(ticker: string): SnapshotEntry | null {
  const upper = ticker.trim().toUpperCase();
  const liveTicker = upper.endsWith(SNAPSHOT_SUFFIX) ? upper.slice(0, -SNAPSHOT_SUFFIX.length) : upper;
  return loadSnapshots().find((entry) => entry.info.liveTicker === liveTicker) ?? null;
}

/**
 * Returns provenance for a snapshot ladder, for labelling captured data and estimated spots.
 *
 * @param {string} eventTicker - A ladder's `eventTicker`.
 * @returns {SnapshotInfo | null} Provenance for snapshot tickers; null for live tickers.
 */
export function getSnapshotInfo(eventTicker: string): SnapshotInfo | null {
  if (!eventTicker.trim().toUpperCase().endsWith(SNAPSHOT_SUFFIX)) {
    return null;
  }
  const entry = findSnapshot(eventTicker);
  return entry === null ? null : { ...entry.info };
}

/**
 * Lists ladders: live ladders that have not expired (sorted by asset, then expiry), followed
 * by snapshot ladders. When the live call fails (after one retry) or `LADDER_FORCE_SNAPSHOT=1`,
 * only snapshots are returned; a failure is reported in `liveError`. The live events list is
 * reused for EVENTS_CACHE_TTL_MS.
 *
 * @param {string | null} asset - Asset code to filter by (any case), or null for all assets.
 * @returns {Promise<LadderList>} Ladder summaries, live first, and the live failure if any.
 * @throws {GeminiError} kind "invalid-input" for a malformed asset.
 * @throws {LadderUnavailableError} When Gemini fails and no snapshot exists for the asset.
 */
export async function listLadders(asset: string | null): Promise<LadderList> {
  try {
    const assetCode = asset === null ? null : normalizeAsset(asset);
    const snapshots = snapshotLadders(assetCode).map((ladder) => summarizeLadder(ladder));
    if (isForceSnapshot()) {
      return { ladders: snapshots, liveError: null };
    }

    let fetched: FetchedEvents;
    try {
      fetched = await loadCryptoEvents();
    } catch (error) {
      if (snapshots.length > 0) {
        console.warn(`[ladder-service] live ladder list failed, serving snapshots: ${describeError(error)}`);
        return { ladders: snapshots, liveError: describeError(error) };
      }
      throw new LadderUnavailableError(`Gemini ladder list is unavailable: ${describeError(error)}`, error);
    }

    const { events, fetchedAt } = fetched;
    const now = Date.now();
    const live: Ladder[] = [];
    for (const event of events) {
      const ladder = parseLadder(event, "live", fetchedAt, null);
      if (ladder === null || Date.parse(ladder.expiry) <= now) {
        continue;
      }
      if (assetCode !== null && ladder.asset !== assetCode) {
        continue;
      }
      live.push(ladder);
    }
    live.sort((a, b) => a.asset.localeCompare(b.asset) || Date.parse(a.expiry) - Date.parse(b.expiry));
    return { ladders: [...live.map((ladder) => summarizeLadder(ladder)), ...snapshots], liveError: null };
  } catch (error) {
    if (error instanceof GeminiError || error instanceof LadderUnavailableError) {
      throw error;
    }
    throw new LadderUnavailableError(`Failed to list ladders: ${describeError(error)}`, error);
  }
}

/**
 * Copies order-book sizes onto rungs. A size is used only when the WebSocket's best price
 * equals the REST quote on the rung, so a size always describes the price it sits next to.
 *
 * @param {LadderRung[]} rungs - Rungs with REST quotes.
 * @param {Map<string, TopOfBook>} books - Top of book keyed by instrument symbol.
 * @returns {LadderRung[]} New rungs with sizes filled where they match.
 */
function applySizes(rungs: LadderRung[], books: Map<string, TopOfBook>): LadderRung[] {
  return rungs.map((rung) => {
    const book = books.get(rung.instrumentSymbol);
    if (book === undefined) {
      return rung;
    }
    const bidMatches = rung.yesBid !== null && book.bidPrice !== null && Math.abs(book.bidPrice - rung.yesBid) < 1e-9;
    const askMatches = rung.yesAsk !== null && book.askPrice !== null && Math.abs(book.askPrice - rung.yesAsk) < 1e-9;
    return {
      ...rung,
      yesBidSize: bidMatches ? book.bidSize : null,
      yesAskSize: askMatches ? book.askSize : null,
    };
  });
}

/**
 * Loads one ladder. Tickers ending in `-SNAPSHOT` are served from fixtures. Live tickers are
 * fetched from Gemini with best-effort order-book sizes; if the live event fails, is settled
 * or is no longer a ladder, a snapshot captured from the same ticker is served instead when
 * one exists, with the reason in `liveError` so callers can tell it from live data.
 *
 * @param {string} ticker - Live ticker such as "SOL2611202200" or snapshot ticker such as "SOL2611202200-SNAPSHOT".
 * @returns {Promise<LadderLoad>} The ladder, and why a snapshot stands in for a live ticker.
 * @throws {LadderNotFoundError} When no such ladder exists (or the ticker is malformed) and no snapshot stands in.
 * @throws {LadderUnavailableError} When Gemini fails and no snapshot stands in.
 */
export async function loadLadder(ticker: string): Promise<LadderLoad> {
  try {
    const upper = ticker.trim().toUpperCase();
    const snapshot = findSnapshot(upper);
    if (upper.endsWith(SNAPSHOT_SUFFIX)) {
      if (snapshot === null) {
        throw new LadderNotFoundError(`No snapshot ladder ${upper}`);
      }
      return { ladder: cloneLadder(snapshot.ladder), liveError: null };
    }

    let liveTicker: string;
    try {
      liveTicker = normalizeEventTicker(upper);
    } catch (error) {
      throw new LadderNotFoundError(`Invalid ladder ticker: ${ticker.slice(0, 80)}`, error);
    }

    if (isForceSnapshot()) {
      if (snapshot === null) {
        throw new LadderNotFoundError(`Live data is disabled and there is no snapshot of ${liveTicker}`);
      }
      return { ladder: cloneLadder(snapshot.ladder), liveError: "live data is disabled on this server" };
    }

    let ladder: Ladder | null = null;
    let liveFailure: unknown = null;
    try {
      const event = await fetchEvent(liveTicker);
      ladder = parseLadder(event, "live", new Date().toISOString(), null);
    } catch (error) {
      liveFailure = error;
    }

    if (ladder === null) {
      if (snapshot !== null) {
        const reason = liveFailure === null ? "not an active ladder" : describeError(liveFailure);
        console.warn(`[ladder-service] live ladder ${liveTicker} unavailable (${reason}), serving snapshot`);
        return { ladder: cloneLadder(snapshot.ladder), liveError: reason };
      }
      if (liveFailure === null) {
        throw new LadderNotFoundError(`${liveTicker} is not an active crypto price ladder`);
      }
      if (liveFailure instanceof GeminiError && liveFailure.kind === "not-found") {
        throw new LadderNotFoundError(`Gemini has no event ${liveTicker}`, liveFailure);
      }
      throw new LadderUnavailableError(`Gemini event ${liveTicker} is unavailable: ${describeError(liveFailure)}`, liveFailure);
    }

    const books = await fetchTopOfBookSizes(
      ladder.rungs.map((rung) => rung.instrumentSymbol),
      ORDER_BOOK_TIMEOUT_MS,
    );
    return { ladder: { ...ladder, rungs: applySizes(ladder.rungs, books) }, liveError: null };
  } catch (error) {
    if (error instanceof LadderNotFoundError || error instanceof LadderUnavailableError) {
      throw error;
    }
    throw new LadderUnavailableError(`Failed to load ladder ${ticker.slice(0, 80)}: ${describeError(error)}`, error);
  }
}

/**
 * Loads one ladder, as {@link loadLadder} does, without the stand-in reason.
 *
 * @param {string} ticker - Live or snapshot ticker.
 * @returns {Promise<Ladder>} The ladder.
 * @throws {LadderNotFoundError} When no such ladder exists (or the ticker is malformed) and no snapshot stands in.
 * @throws {LadderUnavailableError} When Gemini fails and no snapshot stands in.
 */
export async function getLadder(ticker: string): Promise<Ladder> {
  try {
    const { ladder } = await loadLadder(ticker);
    return ladder;
  } catch (error) {
    if (error instanceof LadderNotFoundError || error instanceof LadderUnavailableError) {
      throw error;
    }
    throw new LadderUnavailableError(`Failed to load ladder ${ticker.slice(0, 80)}: ${describeError(error)}`, error);
  }
}

/**
 * Returns the spot price for an asset: live from Gemini, or, when `LADDER_FORCE_SNAPSHOT=1`,
 * the reference spot of the asset's default snapshot (see `orderedSnapshots`) with its
 * provenance in `source`.
 *
 * @param {string} asset - Asset code such as "SOL" (any case).
 * @returns {Promise<SpotQuote>} The spot quote.
 * @throws {GeminiError} When the live ticker fails or the asset is malformed.
 * @throws {LadderNotFoundError} When live data is disabled and the asset has no snapshot.
 */
export async function getSpotQuote(asset: string): Promise<SpotQuote> {
  try {
    const assetCode = normalizeAsset(asset);
    if (!isForceSnapshot()) {
      return await fetchSpot(assetCode);
    }
    const entry = orderedSnapshots(assetCode, Date.now()).at(0);
    if (entry === undefined) {
      throw new LadderNotFoundError(`Live data is disabled and there is no snapshot spot for ${assetCode}`);
    }
    const kind = entry.info.spotIsEstimated ? "snapshot, estimated" : "snapshot";
    return {
      asset: assetCode,
      price: entry.info.referenceSpot,
      source: `${kind}: ${entry.info.spotSource}`,
      asOf: entry.info.capturedAt,
    };
  } catch (error) {
    if (error instanceof GeminiError || error instanceof LadderNotFoundError) {
      throw error;
    }
    throw new LadderUnavailableError(`Failed to load spot for ${asset.slice(0, 20)}: ${describeError(error)}`, error);
  }
}

/**
 * Formats an unknown thrown value for logs and error messages.
 *
 * @param {unknown} error - The thrown value.
 * @returns {string} Its message, or its string form.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
