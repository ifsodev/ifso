"use client";

import { Suspense, use, useId, type ReactNode } from "react";

import { useRobot } from "@/components/common/robot-view";

/**
 * Hydrate a below-the-fold client leaf in an idle period after `load`, on its
 * own — not in the page's one big hydration commit.
 *
 * Hydrating the whole page at once was one long task on a 4x-throttled phone
 * (kumo: every scene of the story — per-letter heading springs, cloud
 * curtains, the works ring — all far below the hero; kimi: ~670 ms). Each wrapped leaf suspends
 * while React hydrates, React keeps its server HTML on screen, and the leaf
 * hydrates in place (no remount) when its turn in the idle queue comes: one
 * leaf per idle period, in document order, so each is a short task of its own.
 *
 * Why idle and not "on approach": opening a block as the visitor scrolls
 * toward it put its hydration commit under the swipe — a 75–100 ms frame in
 * the phone scroll test, every run (kimi, 2026-10-02). The idle queue drains
 * under the hero's loader, long before anyone can scroll (kumo's preloader
 * holds the scroll for at least 2.4 s).
 *
 * Wrap leaves the hero's first screen never shows. On the server the gate is
 * open; a client mount that is not hydration waits one idle period (the leaf
 * is below the fold, so nothing visible waits).
 */
const queue: (() => void)[] = [];
let draining = false;

const whenIdle = (run: () => void) => {
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(run, { timeout: 3000 });
  } else {
    setTimeout(run, 120);
  }
};

const drain = () => {
  const next = queue.shift();
  if (!next) {
    draining = false;
    return;
  }
  whenIdle(() => {
    next();
    drain();
  });
};

const enqueue = (open: () => void) => {
  queue.push(open);
  if (draining) return;
  draining = true;
  if (document.readyState === "complete") drain();
  else window.addEventListener("load", drain, { once: true });
};

/** `useId` is stable across the server render, hydration and its retries. */
const gates = new Map<string, Promise<void>>();

const Gate = ({ id, children }: { id: string; children: ReactNode }) => {
  if (typeof window !== "undefined") {
    let gate = gates.get(id);
    if (!gate) {
      gate = new Promise<void>((open) => enqueue(open));
      gates.set(id, gate);
    }
    use(gate);
  }
  return children;
};

export const HydrateWhenIdle = ({ children }: { children: ReactNode }) => {
  const id = useId();
  // Not on the robot form (D-016). React streams a Suspense boundary larger
  // than ~12.8 KB as a `<div hidden>` segment that an inline script moves into
  // place — instant with JS, but a crawler that does not run it reads the copy
  // as hidden. The robot form is exactly that reader, and it has no intro to
  // hide the hydration under anyway.
  const robot = useRobot();
  if (robot) return children;
  return (
    <Suspense>
      <Gate id={id}>{children}</Gate>
    </Suspense>
  );
};
