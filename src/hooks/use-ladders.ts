import { useCallback, useEffect, useState } from "react";
import type { LadderSummary } from "@/lib/hedge/types";
import {
  describeClientError,
  fetchLadder,
  fetchLadderList,
  isOwnAbort,
  type LadderResponse,
} from "@/lib/client/api";
import { chooseDefaultLadder, countTwoSidedRungs } from "@/lib/client/workbench-model";
import { usePageVisible } from "./use-page-visible";

/** How often the ladder list is re-read while the tab is visible (hourly ladders rotate). */
export const LADDER_LIST_REFRESH_MS = 60_000;

/** Value returned by {@link useLadders}. */
export interface LaddersState {
  /** Ladders for the asset: live first, then snapshots. Empty while loading. */
  ladders: LadderSummary[];
  /** True until the first list for this asset has arrived or failed. */
  loading: boolean;
  /** Readable message when the list could not be loaded. */
  error: string | null;
  /** The ladder to select by default, or null while it is being chosen. */
  defaultTicker: string | null;
  /** True while live ladders are being loaded to count their two-sided rungs. */
  choosingDefault: boolean;
  /** Two-sided rung counts of the live ladders that were loaded, keyed by ticker. */
  twoSidedByTicker: Readonly<Record<string, number>>;
  /** Ladders loaded while choosing the default, keyed by the ticker requested, to show without a second wait. */
  preloaded: Readonly<Record<string, LadderResponse>>;
  /** Loads the list again and re-chooses the default. */
  retry: () => void;
}

/** One loaded ladder list. */
interface ListResult {
  key: string;
  ladders: LadderSummary[];
  error: string | null;
}

/** Outcome of choosing the default ladder. */
interface ChoiceResult {
  key: string;
  defaultTicker: string | null;
  twoSidedByTicker: Record<string, number>;
  preloaded: Record<string, LadderResponse>;
}

/** Shared empty records, so consumers see stable references. */
const EMPTY_COUNTS: Readonly<Record<string, number>> = {};
const EMPTY_PRELOADED: Readonly<Record<string, LadderResponse>> = {};

/**
 * Loads the live ladders of a list in parallel and counts their two-sided rungs.
 * Ladders that fail to load are left out; the failure is logged, not thrown, because
 * a missing count only means that ladder is not chosen by default.
 *
 * @param {LadderSummary[]} ladders - The list.
 * @param {AbortSignal} signal - Cancels the requests.
 * @returns {Promise<{ counts: Record<string, number>; preloaded: Record<string, LadderResponse> }>} Counts and loaded ladders keyed by ticker.
 */
async function probeLiveLadders(
  ladders: LadderSummary[],
  signal: AbortSignal,
): Promise<{ counts: Record<string, number>; preloaded: Record<string, LadderResponse> }> {
  const live = ladders.filter((ladder) => ladder.source === "live");
  const counts: Record<string, number> = {};
  const preloaded: Record<string, LadderResponse> = {};
  const settled = await Promise.allSettled(live.map((ladder) => fetchLadder(ladder.eventTicker, signal)));
  settled.forEach((outcome, index) => {
    const ticker = live[index].eventTicker;
    if (outcome.status === "fulfilled") {
      preloaded[ticker] = outcome.value;
      if (outcome.value.ladder.source === "live") {
        counts[ticker] = countTwoSidedRungs(outcome.value.ladder);
      }
    } else if (!signal.aborted) {
      console.warn(`[use-ladders] could not load ${ticker} to rank it: ${describeClientError(outcome.reason)}`);
    }
  });
  return { counts, preloaded };
}

/**
 * The ladders Gemini lists for an asset, and the one to show first.
 *
 * The default is the live, unexpired ladder with the most two-sided rungs (ties go to the
 * later expiry), because hourly ladders are often quoted on one side only; when none
 * qualifies, the asset's default snapshot. The list is re-read every minute while the tab
 * is visible; the default is chosen once per asset (and again on `retry`).
 *
 * @param {string} asset - Asset code, for example "SOL".
 * @returns {LaddersState} The list, the default choice and their loading and error states.
 */
export function useLadders(asset: string): LaddersState {
  const visible = usePageVisible();
  const [attempt, setAttempt] = useState(0);
  const [refreshCount, setRefreshCount] = useState(0);
  const [list, setList] = useState<ListResult | null>(null);
  const [choice, setChoice] = useState<ChoiceResult | null>(null);

  const choiceKey = `${asset}|${attempt}`;

  // Load the list and choose the default once per asset and attempt.
  useEffect(() => {
    const controller = new AbortController();
    const key = `${asset}|${attempt}`;

    /**
     * Loads the list, stores it, then ranks the live ladders and stores the default.
     *
     * @returns {Promise<void>} Resolves when both results are stored; errors become state.
     */
    const load = async (): Promise<void> => {
      let ladders: LadderSummary[];
      try {
        ladders = await fetchLadderList(asset, controller.signal);
        setList({ key, ladders, error: null });
      } catch (error) {
        if (isOwnAbort(error, controller.signal)) {
          return;
        }
        setList({ key, ladders: [], error: describeClientError(error) });
        setChoice({ key, defaultTicker: null, twoSidedByTicker: {}, preloaded: {} });
        return;
      }
      try {
        const { counts, preloaded } = await probeLiveLadders(ladders, controller.signal);
        if (controller.signal.aborted) {
          return;
        }
        const defaultTicker = chooseDefaultLadder(ladders, new Map(Object.entries(counts)), Date.now());
        setChoice({ key, defaultTicker, twoSidedByTicker: counts, preloaded });
      } catch (error) {
        if (isOwnAbort(error, controller.signal)) {
          return;
        }
        console.error(`[use-ladders] choosing the default ladder failed: ${describeClientError(error)}`);
        const fallback = chooseDefaultLadder(ladders, new Map(), Date.now());
        setChoice({ key, defaultTicker: fallback, twoSidedByTicker: {}, preloaded: {} });
      }
    };

    void load();
    return () => controller.abort();
  }, [asset, attempt]);

  // Re-read the list (without re-choosing the default) on each refresh tick.
  useEffect(() => {
    if (refreshCount === 0) {
      return;
    }
    const controller = new AbortController();
    const key = `${asset}|${attempt}`;

    /**
     * Re-reads the list and replaces it; a failed refresh keeps the previous list.
     *
     * @returns {Promise<void>} Resolves when done; errors are logged and kept out of the list.
     */
    const refresh = async (): Promise<void> => {
      try {
        const ladders = await fetchLadderList(asset, controller.signal);
        // Ignore a refresh that lands after the user switched asset.
        setList((previous) => (previous !== null && previous.key !== key ? previous : { key, ladders, error: null }));
      } catch (error) {
        if (isOwnAbort(error, controller.signal)) {
          return;
        }
        console.warn(`[use-ladders] list refresh failed: ${describeClientError(error)}`);
      }
    };

    void refresh();
    return () => controller.abort();
    // `attempt` is read only to tag the result; a new attempt already reloads in the effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshCount]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    const id = setInterval(() => setRefreshCount((count) => count + 1), LADDER_LIST_REFRESH_MS);
    return () => clearInterval(id);
  }, [visible]);

  const retry = useCallback((): void => {
    setAttempt((count) => count + 1);
  }, []);

  const currentList = list !== null && list.key === choiceKey ? list : null;
  const currentChoice = choice !== null && choice.key === choiceKey ? choice : null;

  return {
    ladders: currentList?.ladders ?? [],
    loading: currentList === null,
    error: currentList?.error ?? null,
    defaultTicker: currentChoice?.defaultTicker ?? null,
    choosingDefault: currentChoice === null,
    twoSidedByTicker: currentChoice?.twoSidedByTicker ?? EMPTY_COUNTS,
    preloaded: currentChoice?.preloaded ?? EMPTY_PRELOADED,
    retry,
  };
}
