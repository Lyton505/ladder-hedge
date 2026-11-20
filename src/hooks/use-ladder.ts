import { useCallback, useEffect, useState } from "react";
import type { Ladder } from "@/lib/hedge/types";
import {
  describeClientError,
  fetchLadder,
  isOwnAbort,
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
  data: LadderResponse | null;
  error: string | null;
}

/**
 * Loads one ladder and keeps a live ladder fresh: it is re-read every 15 seconds while
 * the tab is visible, and as soon as the tab becomes visible again if the data is older
 * than that. Snapshot ladders are read once.
 *
 * @param {string | null} ticker - Ticker to load, or null when none is selected.
 * @param {LadderResponse | null} preloaded - A response already loaded for this ticker, shown until the first read lands.
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
     * Reads the ladder and stores the outcome; a failure keeps the last good ladder for this ticker.
     *
     * @returns {Promise<void>} Resolves when the outcome is stored.
     */
    const load = async (): Promise<void> => {
      try {
        const data = await fetchLadder(ticker, controller.signal);
        setResult({ ticker, data, error: null });
      } catch (error) {
        if (isOwnAbort(error, controller.signal)) {
          return;
        }
        const message = describeClientError(error);
        setResult((previous) => ({
          ticker,
          data: previous !== null && previous.ticker === ticker ? previous.data : null,
          error: message,
        }));
      }
    };

    void load();
    return () => controller.abort();
  }, [ticker, requestCount]);

  const current = result !== null && result.ticker === ticker ? result : null;
  const fallback = preloaded !== null && ticker !== null ? preloaded : null;
  const data = current?.data ?? fallback;
  const isLive = data !== null && data.ladder.source === "live";
  const fetchedAt = data?.ladder.fetchedAt ?? null;

  useEffect(() => {
    if (!isLive || !visible) {
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
  }, [isLive, visible, fetchedAt]);

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
