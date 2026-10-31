/**
 * @fileoverview Reads the `prefers-reduced-motion` media query as React state.
 *
 * `<ReducedMotion>` already flips react-spring's global `skipAnimation`, which
 * makes ordinary springs jump to their end state. That is not enough for a
 * **looping** spring: skipping the animation only makes each cycle finish
 * instantly, so the loop restarts as fast as it can. Anything that loops has to
 * check this hook and stop itself.
 *
 * One shared listener for the whole app, delivered through
 * `useSyncExternalStore` — SSR-safe and tear-free, mirroring
 * `use-window-size.ts`.
 */

"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/** Server render assumes full motion; the client corrects on hydration. */
const SERVER_SNAPSHOT = false;

let snapshot = SERVER_SNAPSHOT;
let query: MediaQueryList | null = null;

const listeners = new Set<() => void>();

const handleChange = (): void => {
  if (!query) return;
  if (query.matches === snapshot) return;
  snapshot = query.matches;
  listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void): (() => void) => {
  if (!query) {
    query = window.matchMedia(QUERY);
    snapshot = query.matches;
  }
  if (listeners.size === 0) {
    query.addEventListener("change", handleChange);
  }
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      query?.removeEventListener("change", handleChange);
    }
  };
};

/** `true` when the visitor has asked the OS to reduce motion. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => SERVER_SNAPSHOT,
  );
}
