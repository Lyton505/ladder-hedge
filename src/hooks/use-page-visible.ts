import { useSyncExternalStore } from "react";

/**
 * Subscribes to page visibility changes.
 *
 * @param {() => void} listener - Called when the tab is shown or hidden.
 * @returns {() => void} Unsubscribe function.
 */
function subscribe(listener: () => void): () => void {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

/**
 * Reads whether the tab is visible.
 *
 * @returns {boolean} True when the document is visible.
 */
function getSnapshot(): boolean {
  return document.visibilityState === "visible";
}

/**
 * Visibility assumed during server rendering.
 *
 * @returns {boolean} Always true.
 */
function getServerSnapshot(): boolean {
  return true;
}

/**
 * Whether the browser tab is currently visible. Used to pause polling in background tabs.
 *
 * @returns {boolean} True when the tab is visible (and during server rendering).
 */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
