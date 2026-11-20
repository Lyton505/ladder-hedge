import { useCallback, useSyncExternalStore } from "react";
import type { PaperFill } from "@/lib/hedge/types";

/** localStorage key that holds the saved paper fills as a JSON array. */
export const PAPER_FILLS_STORAGE_KEY = "ladder-hedge:paper-fills";

/** Value returned by `usePaperFills`. */
export interface PaperFillsState {
  /** Saved fills in the order they were added. */
  fills: PaperFill[];
  addFill: (fill: PaperFill) => void;
  setSignature: (id: string, signature: string) => void;
  clear: () => void;
}

/** Shared empty list, so server rendering and empty storage return a stable reference. */
const EMPTY_FILLS: PaperFill[] = [];

/** Listeners registered by mounted hooks in this tab. */
const listeners = new Set<() => void>();

/** Last raw storage value parsed, and its parse result, so snapshots stay referentially stable. */
let cachedRaw: string | null = null;
let cachedFills: PaperFill[] = EMPTY_FILLS;

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
 * Checks that a stored value has the shape of a `PaperFill`.
 *
 * @param {unknown} value - Parsed JSON entry.
 * @returns {boolean} True if the entry can be used as a `PaperFill`.
 */
function isPaperFill(value: unknown): value is PaperFill {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.eventTicker === "string" &&
    typeof value.planHash === "string" &&
    typeof value.memo === "string" &&
    (value.signature === null || typeof value.signature === "string") &&
    isRecord(value.exposure) &&
    isRecord(value.plan)
  );
}

/**
 * Parses the stored JSON. Corrupt or unexpected content yields an empty list.
 *
 * @param {string | null} raw - Raw localStorage value.
 * @returns {PaperFill[]} The valid fills found.
 */
function parseFills(raw: string | null): PaperFill[] {
  if (raw === null) {
    return EMPTY_FILLS;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt JSON is an expected state (manual edits, older formats): start empty.
    return EMPTY_FILLS;
  }
  if (!Array.isArray(parsed)) {
    return EMPTY_FILLS;
  }
  return parsed.filter(isPaperFill);
}

/**
 * Returns the browser's localStorage, or null during server rendering or when access is blocked.
 *
 * @returns {Storage | null} The storage object, or null.
 */
function getStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    // Some browsers throw on access when storage is disabled; treat as unavailable.
    return null;
  }
}

/**
 * Reads the current fills from storage, reusing the cached array while the raw value is unchanged.
 *
 * @returns {PaperFill[]} Current fills.
 */
function getSnapshot(): PaperFill[] {
  const storage = getStorage();
  if (storage === null) {
    return EMPTY_FILLS;
  }
  const raw = storage.getItem(PAPER_FILLS_STORAGE_KEY);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedFills = parseFills(raw);
  }
  return cachedFills;
}

/**
 * Snapshot used during server rendering and hydration.
 *
 * @returns {PaperFill[]} Always the shared empty list.
 */
function getServerSnapshot(): PaperFill[] {
  return EMPTY_FILLS;
}

/**
 * Notifies every mounted hook that storage changed.
 *
 * @returns {void}
 */
function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Subscribes to changes from this tab and, through the `storage` event, from other tabs.
 *
 * @param {() => void} listener - Called when the stored fills may have changed.
 * @returns {() => void} Unsubscribe function.
 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  /**
   * Forwards cross-tab storage events for our key.
   *
   * @param {StorageEvent} event - Browser storage event.
   * @returns {void}
   */
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === PAPER_FILLS_STORAGE_KEY) {
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * Persists the fills and notifies subscribers.
 *
 * @param {PaperFill[]} fills - Full list to store.
 * @returns {void}
 * @throws {Error} If storage is unavailable or the write fails (for example, quota exceeded).
 */
function writeFills(fills: PaperFill[]): void {
  const storage = getStorage();
  if (storage === null) {
    throw new Error("Paper fills cannot be saved: localStorage is not available.");
  }
  try {
    storage.setItem(PAPER_FILLS_STORAGE_KEY, JSON.stringify(fills));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Paper fills could not be saved to localStorage: ${message}`, { cause: error });
  }
  emitChange();
}

/**
 * Paper fills (simulated hedge executions) saved in this browser's localStorage.
 *
 * Safe during server rendering: the server and the hydration pass see an empty list,
 * then the stored fills appear. Corrupt stored JSON is treated as an empty list.
 *
 * @returns {PaperFillsState} The fills and functions to add, sign and clear them. `addFill`,
 *   `setSignature` and `clear` throw an `Error` if localStorage cannot be written.
 */
export function usePaperFills(): PaperFillsState {
  const fills = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const addFill = useCallback((fill: PaperFill): void => {
    writeFills([...getSnapshot(), fill]);
  }, []);

  const setSignature = useCallback((id: string, signature: string): void => {
    const updated = getSnapshot().map((fill) => (fill.id === id ? { ...fill, signature } : fill));
    writeFills(updated);
  }, []);

  const clear = useCallback((): void => {
    const storage = getStorage();
    if (storage === null) {
      throw new Error("Paper fills cannot be cleared: localStorage is not available.");
    }
    try {
      storage.removeItem(PAPER_FILLS_STORAGE_KEY);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Paper fills could not be cleared from localStorage: ${message}`, { cause: error });
    }
    emitChange();
  }, []);

  return { fills, addFill, setSignature, clear };
}
