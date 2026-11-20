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
 * Checks that a value is a finite number.
 *
 * @param {unknown} value - Value to check.
 * @returns {boolean} True for finite numbers.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Checks that a stored value has the shape of a `PaperFill`, including every field the
 * receipt panel reads (the plan's legs and their quantities, its cost and worst case, and
 * the exposure's asset and quantity), so a malformed entry cannot crash the page.
 *
 * @param {unknown} value - Parsed JSON entry.
 * @returns {boolean} True if the entry can be used as a `PaperFill`.
 */
function isPaperFill(value: unknown): value is PaperFill {
  if (!isRecord(value)) {
    return false;
  }
  const { exposure, plan } = value;
  return (
    typeof value.id === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.eventTicker === "string" &&
    typeof value.planHash === "string" &&
    typeof value.memo === "string" &&
    (value.signature === null || typeof value.signature === "string") &&
    isRecord(exposure) &&
    typeof exposure.asset === "string" &&
    isFiniteNumber(exposure.quantity) &&
    isRecord(plan) &&
    isFiniteNumber(plan.totalCost) &&
    isFiniteNumber(plan.worstCaseAfter) &&
    Array.isArray(plan.legs) &&
    plan.legs.every((leg) => isRecord(leg) && isFiniteNumber(leg.quantity))
  );
}

/**
 * Parses the stored JSON. Corrupt or unexpected content yields an empty list, and entries
 * that are not valid fills are dropped; both are reported with a console warning naming
 * the storage key.
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
  } catch (error) {
    // Corrupt JSON is an expected state (manual edits, older formats): report it and start empty.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[use-paper-fills] localStorage "${PAPER_FILLS_STORAGE_KEY}" is not valid JSON, so no saved fills are shown: ${message}`);
    return EMPTY_FILLS;
  }
  if (!Array.isArray(parsed)) {
    console.warn(`[use-paper-fills] localStorage "${PAPER_FILLS_STORAGE_KEY}" is not a list, so no saved fills are shown.`);
    return EMPTY_FILLS;
  }
  const fills = parsed.filter(isPaperFill);
  if (fills.length < parsed.length) {
    console.warn(
      `[use-paper-fills] dropped ${parsed.length - fills.length} malformed entr${parsed.length - fills.length === 1 ? "y" : "ies"} from localStorage "${PAPER_FILLS_STORAGE_KEY}".`,
    );
  }
  return fills;
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
 * then the stored fills appear. Corrupt stored JSON is treated as an empty list and
 * malformed entries are dropped; both are reported with a console warning.
 *
 * @returns {PaperFillsState} The fills and functions to add, sign and clear them. `addFill`,
 *   `setSignature` and `clear` throw an `Error` if localStorage cannot be written.
 */
export function usePaperFills(): PaperFillsState {
  const fills = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  /**
   * Appends a fill to the stored list.
   *
   * @param {PaperFill} fill - The fill to save.
   * @returns {void}
   * @throws {Error} If localStorage is unavailable or the write fails.
   */
  const addFill = useCallback((fill: PaperFill): void => {
    writeFills([...getSnapshot(), fill]);
  }, []);

  /**
   * Stores the devnet receipt signature on a saved fill.
   *
   * @param {string} id - The fill's id.
   * @param {string} signature - The receipt transaction's signature.
   * @returns {void}
   * @throws {Error} If localStorage is unavailable or the write fails.
   */
  const setSignature = useCallback((id: string, signature: string): void => {
    const updated = getSnapshot().map((fill) => (fill.id === id ? { ...fill, signature } : fill));
    writeFills(updated);
  }, []);

  /**
   * Removes every saved fill.
   *
   * @returns {void}
   * @throws {Error} If localStorage is unavailable or the removal fails.
   */
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
