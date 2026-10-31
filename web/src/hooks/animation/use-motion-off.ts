"use client";

import { useState } from "react";
import { useReducedMotion } from "@react-spring/web";

import { useRobot } from "@/components/common/robot-view";

const reducedAtStart = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * True when motion is off: the visitor prefers reduced motion, or this is the
 * robot form (D-016). **Every looping spring must read it** —
 * `loop: !motionOff` — because both switch on react-spring's global
 * `skipAnimation`, under which a loop ends each lap instantly and starts the
 * next in the same tick: the page freezes (clair, evolve, gring-x on live).
 *
 * The media query is read on the first render: `useReducedMotion()` alone
 * reports `false` until its effect runs, by which time the loop has started.
 * The flag doesn't touch the DOM, so reading it during render can't mismatch.
 */
export const useMotionOff = (): boolean => {
  const [reducedFirst] = useState(reducedAtStart);
  const reduced = Boolean(useReducedMotion());
  const robot = useRobot();
  return reducedFirst || reduced || robot;
};
