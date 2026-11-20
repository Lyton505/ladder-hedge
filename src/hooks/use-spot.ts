import { useEffect, useState } from "react";
import type { SpotQuote } from "@/lib/hedge/types";
import { describeClientError, fetchSpot, isOwnAbort } from "@/lib/client/api";
import { usePageVisible } from "./use-page-visible";

/** How often the spot price is re-read while the tab is visible. */
export const SPOT_REFRESH_MS = 15_000;

/** Value returned by {@link useSpot}. */
export interface SpotState {
  /** The latest quote for the asset, or null before one has loaded. */
  spot: SpotQuote | null;
  /** True while the first read for this asset is running. */
  loading: boolean;
  /** Readable message when the last read failed. */
  error: string | null;
}

/** One stored read of an asset's spot. */
interface SpotResult {
  asset: string;
  spot: SpotQuote | null;
  error: string | null;
}

/**
 * Reads an asset's spot price from `/api/spot` and re-reads it every 15 seconds while the
 * tab is visible. A failed refresh keeps the last good quote and reports the error.
 *
 * @param {string} asset - Asset code, for example "SOL".
 * @param {boolean} enabled - False to stop reading (for example while a snapshot ladder supplies the spot).
 * @returns {SpotState} The quote and its loading and error states.
 */
export function useSpot(asset: string, enabled: boolean): SpotState {
  const visible = usePageVisible();
  const [result, setResult] = useState<SpotResult | null>(null);
  const [requestCount, setRequestCount] = useState(0);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const controller = new AbortController();

    /**
     * Reads the spot and stores the outcome.
     *
     * @returns {Promise<void>} Resolves when the outcome is stored.
     */
    const load = async (): Promise<void> => {
      try {
        const spot = await fetchSpot(asset, controller.signal);
        setResult({ asset, spot, error: null });
      } catch (error) {
        if (isOwnAbort(error, controller.signal)) {
          return;
        }
        const message = describeClientError(error);
        setResult((previous) => ({
          asset,
          spot: previous !== null && previous.asset === asset ? previous.spot : null,
          error: message,
        }));
      }
    };

    void load();
    return () => controller.abort();
  }, [asset, enabled, requestCount]);

  useEffect(() => {
    if (!enabled || !visible) {
      return;
    }
    const id = setInterval(() => setRequestCount((count) => count + 1), SPOT_REFRESH_MS);
    return () => clearInterval(id);
  }, [enabled, visible]);

  const current = result !== null && result.asset === asset ? result : null;
  return {
    spot: current?.spot ?? null,
    loading: enabled && current === null,
    error: current?.error ?? null,
  };
}
