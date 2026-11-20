import { useSyncExternalStore } from "react";

/** How often the shared client clock ticks. */
export const CLOCK_TICK_MS = 1_000;

/** Listeners of the shared clock. */
const listeners = new Set<() => void>();

/** Latest clock reading, or null before the first tick. */
let currentNowMs: number | null = null;

/** Interval handle while at least one component listens. */
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Reads the time and notifies listeners.
 *
 * @returns {void}
 */
function tick(): void {
  currentNowMs = Date.now();
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Subscribes to the shared clock, starting it for the first listener.
 *
 * @param {() => void} listener - Called on every tick.
 * @returns {() => void} Unsubscribe function; the clock stops when nobody listens.
 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    timer = setInterval(tick, CLOCK_TICK_MS);
    // Take the first reading right away, outside React's render.
    setTimeout(tick, 0);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/**
 * Current clock reading for the client.
 *
 * @returns {number | null} Epoch milliseconds, or null before the first tick.
 */
function getSnapshot(): number | null {
  return currentNowMs;
}

/**
 * Clock reading during server rendering and hydration.
 *
 * @returns {null} Always null, so server and first client render agree.
 */
function getServerSnapshot(): null {
  return null;
}

/**
 * The current time from a client clock that ticks once a second. Returns null during
 * server rendering and hydration, so countdowns never cause a hydration mismatch and no
 * component calls `Date.now()` while rendering.
 *
 * @returns {number | null} Epoch milliseconds, or null until the clock has ticked on the client.
 */
export function useNow(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
