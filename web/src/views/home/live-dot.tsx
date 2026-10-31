"use client";

/**
 * @fileoverview The gold "live" dot by "Start a project", with a ring that
 * swells out of it and fades, like a recording light — the studio is taking
 * work. A looping spring (hard rule #1: no CSS keyframes); still under
 * reduced motion.
 */

import { animated, easings, useSpring } from "@react-spring/web";
import { useMotionOff } from "@/hooks/animation/use-motion-off";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";

/** One pulse, ring out and gone. */
const PULSE_MS = 1600;
/** How far the ring swells, in dot diameters. */
const PULSE_SCALE = 2.6;

export const LiveDot = () => {
  // Read on the first render (reduced motion or the robot form): a loop under
  // react-spring's skipAnimation restarts in the same tick forever.
  const motionOff = useMotionOff();
  // The ring's look follows the hydration-safe flag (the server assumes
  // motion), so the served style matches; the loop reads `motionOff`.
  const reducedMotion = usePrefersReducedMotion();
  const { pulse } = useSpring({
    from: { pulse: 0 },
    to: { pulse: 1 },
    loop: !motionOff,
    pause: motionOff,
    config: { duration: PULSE_MS, easing: easings.easeOutCubic },
  });

  return (
    <span aria-hidden="true" className="relative inline-block size-3">
      <animated.span
        className="absolute inset-0 rounded-full bg-accent"
        style={{
          opacity: pulse.to((p) => (reducedMotion ? 0 : 0.55 * (1 - p))),
          scale: pulse.to((p) => 1 + (PULSE_SCALE - 1) * p),
        }}
      />
      <span className="absolute inset-0 rounded-full bg-accent" />
    </span>
  );
};
