"use client";

// 📖 Docs: obsidian/frontend/components/common.md

/**
 * @fileoverview Full-viewport CRT treatment — TV scanlines, vignette and grain.
 *
 * Four fixed, stacked layers over the whole viewport — the last is the bezel
 * that rounds the screen's corners. Purely decorative:
 * `aria-hidden` and `pointer-events-none`, so it never touches the
 * accessibility tree or swallows a click.
 *
 * The scanlines drift slowly upward. That motion is a `@react-spring/web`
 * spring (hard rule #1 — CSS keyframes are banned) looping 0 → 1, written to
 * the `--overlay-scanline-drift` custom property. The distance itself is
 * expressed in CSS, so the period is still described in exactly one place, and
 * the animated value crossing the boundary is a bare number — a `var()` inside
 * an animated `transform` string serialises differently on server and client
 * and trips a hydration mismatch.
 *
 * Travelling exactly one period and looping is seamless because the gradient
 * repeats on that period and the layer is one period taller than its container.
 * A transform is compositor-only, so the drift never repaints the viewport.
 *
 * The layers live in `@layer components` in `globals.css` (`.crt-*`), driven by
 * the `--overlay-*` tokens — see obsidian/frontend/design-system.md.
 */

import { useState, type CSSProperties } from "react";
import { animated, easings, useSpring } from "@react-spring/web";
import { isRobotView } from "@/components/common/robot-view";
import { useMotionOff } from "@/hooks/animation/use-motion-off";

/**
 * Milliseconds for the scanlines to travel one period. Slow enough to read as
 * a drifting CRT rather than as scrolling texture.
 */
const DRIFT_DURATION_MS = 2600;

export interface CrtOverlayProps {
  /** Extra classes for the fixed container — e.g. to change stacking. */
  className?: string;
  /** Milliseconds per period of scanline drift. Higher is slower. */
  driftDuration?: number;
}

export const CrtOverlay = ({
  className,
  driftDuration = DRIFT_DURATION_MS,
}: CrtOverlayProps) => {
  // `skipAnimation` alone would not stop a loop — it makes each cycle finish
  // instantly, so the loop would restart as fast as it can. Stop it outright.
  // Read on the first render: a loop under react-spring's skipAnimation
  // restarts in the same tick forever. This sits in the root layout, outside
  // the view's robot context, so the robot form is read from the server's
  // marker instead (D-016).
  const motionOff = useMotionOff();
  const [robot] = useState(isRobotView);
  const prefersReducedMotion = motionOff || robot;

  const { drift } = useSpring({
    from: { drift: 0 },
    to: { drift: 1 },
    loop: !prefersReducedMotion,
    pause: prefersReducedMotion,
    config: { duration: driftDuration, easing: easings.linear },
  });

  const classes = [
    "pointer-events-none fixed inset-0 z-[var(--layer-overlay)]",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  // A custom property is not part of CSSProperties' known keys; react-spring
  // writes it through style.setProperty at runtime.
  const driftStyle = {
    "--overlay-scanline-drift": drift,
  } as unknown as CSSProperties;

  return (
    <div aria-hidden="true" className={classes}>
      <animated.div
        className="crt-scanlines absolute inset-x-0 top-0"
        style={driftStyle}
      />
      <div className="crt-vignette absolute inset-0" />
      <div className="crt-grain absolute inset-0" />
      <div className="crt-bezel absolute inset-0" />
    </div>
  );
};
