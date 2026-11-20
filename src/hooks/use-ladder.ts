import { useCallback, useEffect, useState } from "react";
import type { Ladder } from "@/lib/hedge/types";
import {
  describeClientError,
  fetchLadder,
  isOwnAbort,
  isSnapshotTicker,
  type LadderResponse,
  type SnapshotMeta,
} from "@/lib/client/api";
import { usePageVisible } from "./use-page-visible";

/** How often a live ladder is re-read while the tab is visible. */
export const LIVE_LADDER_REFRESH_MS = 15_000;

/** Value returned by {@link useLadder}. */
export interface LadderState {
  /** The ladder, or null before it has loaded. Kept while a refresh is running or after a failed refresh. */
  ladder: Ladder | null;
  /** Snapshot provenance for snapshot ladders; null for live ones. */
  snapshot: SnapshotMeta | null;
  /** True while the first read of this ticker is running. */
  loading: boolean;
  /** Readable message when the last read failed (the previous ladder, if any, is still shown). */
  error: string | null;
  /** Reads the ladder again now. */
  refresh: () => void;
}

/** One stored read of a ticker. */
interface LadderResult {
  ticker: string;
  /** The last reply that was what was asked for: live data for a live ticker, or the snapshot for a snapshot ticker. */
  data: LadderResponse | null;
  /**
   * A snapshot the server sent in place of a live ticker. It is shown only while no live
   * data exists for the ticker, and never replaces live data already shown.
   */
  standIn: LadderResponse | null;
  error: string | null;
}

/**
 * Builds the message for a live ticker answered with a snapshot.
 *
 * @param {LadderResponse} response - The snapshot reply.
 * @returns {string} A readable message.
 */
function standInMessage(response: LadderResponse): string {
  const reason = response.liveError ?? "the server sent captured snapshot data instead";
  return `Live quotes could not be read (${reason}). Live quotes are retried every ${LIVE_LADDER_REFRESH_MS / 1000} seconds`;
}

/**
 * Loads one ladder and keeps a live ladder fresh: it is re-read every 15 seconds while
 * the tab is visible, and as soon as the tab becomes visible again if the data is older
 * than that. Snapshot ladders are read once.
 *
 * A reply that carries a snapshot for a live ticker counts as a failed refresh: the last
 * live ladder stays on screen with the error set, and polling continues. Only when no live
 * data was ever read for the ticker is the snapshot shown (it is labelled as one), still
 * with the error set and polling for live data.
 *
 * @param {string | null} ticker - Ticker to load, or null when none is selected.
 * @param {LadderResponse | null} preloaded - A live response already loaded for this ticker, shown until the first read lands.
 * @returns {LadderState} The ladder, its provenance, and loading and error states.
 */
export function useLadder(ticker: string | null, preloaded: LadderResponse | null): LadderState {
  const visible = usePageVisible();
  const [result, setResult] = useState<LadderResult | null>(null);
  const [requestCount, setRequestCount] = useState(0);

  useEffect(() => {
    if (ticker === null) {
      return;
    }
    const controller = new AbortController();

    /**
     * Reads the ladder and stores the outcome; a failure, or a snapshot sent for a live
     * ticker, keeps the last good ladder for this ticker.
     *
     * @returns {Promise<void>} Resolves when the outcome is stored.
     */
    const load = async (): Promise<void> => {
      try {
        const response = await fetchLadder(ticker, controller.signal);
        if (!isSnapshotTicker(ticker) && response.ladder.source !== "live") {
          const message = standInMessage(response);
          console.warn(`[use-ladder] ${ticker}: ${message}`);
          setResult((previous) => {
            const same = previous !== null && previous.ticker === ticker;
            return { ticker, data: same ? previous.data : null, standIn: response, error: message };
          });
          return;
        }
        setResult({ ticker, data: response, standIn: null, error: null });
      } catch (error) {
        if (isOwnAbort(error, controller.signal)) {
          return;
        }
        const message = describeClientError(error);
        setResult((previous) => {
          const same = previous !== null && previous.ticker === ticker;
          return {
            ticker,
            data: same ? previous.data : null,
            standIn: same ? previous.standIn : null,
            error: message,
          };
        });
      }
    };

    void load();
    return () => controller.abort();
  }, [ticker, requestCount]);

  const current = result !== null && result.ticker === ticker ? result : null;
  const fallback = preloaded !== null && ticker !== null ? preloaded : null;
  const data = current?.data ?? fallback ?? current?.standIn ?? null;
  // A live ticker keeps polling even while a snapshot stands in, so live data returns on its own.
  const wantsLive = ticker !== null && !isSnapshotTicker(ticker);
  const fetchedAt = data?.ladder.fetchedAt ?? null;

  useEffect(() => {
    if (!wantsLive || !visible) {
      return;
    }
    const fetchedMs = fetchedAt === null ? Number.NaN : Date.parse(fetchedAt);
    const age = Number.isNaN(fetchedMs) ? LIVE_LADDER_REFRESH_MS : Date.now() - fetchedMs;
    // First refresh when the data turns 15 s old (at once if the tab was hidden for longer), then every 15 s.
    const firstDelay = Math.max(0, LIVE_LADDER_REFRESH_MS - age);
    let interval: ReturnType<typeof setInterval> | null = null;
    const first = setTimeout(() => {
      setRequestCount((count) => count + 1);
      interval = setInterval(() => setRequestCount((count) => count + 1), LIVE_LADDER_REFRESH_MS);
    }, firstDelay);
    return () => {
      clearTimeout(first);
      if (interval !== null) {
        clearInterval(interval);
      }
    };
  }, [wantsLive, visible, fetchedAt]);

  /**
   * Reads the ladder again now.
   *
   * @returns {void}
   */
  const refresh = useCallback((): void => {
    setRequestCount((count) => count + 1);
  }, []);

  return {
    ladder: data?.ladder ?? null,
    snapshot: data?.snapshot ?? null,
    loading: ticker !== null && data === null && current === null,
    error: current?.error ?? null,
    refresh,
  };
}
