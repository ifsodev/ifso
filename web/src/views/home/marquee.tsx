"use client";

/**
 * @fileoverview A strip of items running left forever — the film ticker and
 * the contact running line.
 *
 * The track holds the items four times and a spring loops it left by exactly
 * half its length (two copies), so the seam is invisible and the strip stays
 * full across any viewport — one copy alone can be narrower than a wide
 * screen. Linear easing on purpose: a marquee that eases reads as stuttering.
 * Under reduced motion the loop is stopped outright (`skipAnimation` would
 * only make each cycle finish instantly).
 */

import { Fragment, type ReactNode } from "react";
import { animated, easings, useSpring } from "@react-spring/web";
import { WrittenLines } from "@/components/animation/written-lines";
import { useMotionOff } from "@/hooks/animation/use-motion-off";

const COPIES = ["a", "b", "c", "d"];

export interface MarqueeProps {
  items: string[];
  /** Drawn after every item. */
  separator: ReactNode;
  /** Milliseconds for the track to travel two copies of the items. */
  duration: number;
  label: string;
  /** Classes for the track — gap, type, colour. */
  trackClassName: string;
  itemClassName?: string;
  /** Write each item in word by word when shown, like the headings. */
  writeIn?: boolean;
  className?: string;
}

export const Marquee = ({
  items,
  separator,
  duration,
  label,
  trackClassName,
  itemClassName,
  writeIn = false,
  className,
}: MarqueeProps) => {
  // Read on the first render (reduced motion or the robot form): a loop under
  // react-spring's skipAnimation restarts in the same tick forever.
  const prefersReducedMotion = useMotionOff();
  const { shift } = useSpring({
    from: { shift: 0 },
    to: { shift: -50 },
    loop: !prefersReducedMotion,
    pause: prefersReducedMotion,
    config: { duration, easing: easings.linear },
  });

  return (
    <div className={`overflow-hidden ${className ?? ""}`}>
      <animated.ul
        aria-label={label}
        className={`flex h-full w-max items-center ${trackClassName}`}
        style={{ transform: shift.to((value) => `translate3d(${value}%, 0, 0)`) }}
      >
        {COPIES.map((copy) =>
          items.map((item) => (
            <Fragment key={`${copy}-${item}`}>
              <li aria-hidden={copy !== "a"} className={`shrink-0 ${itemClassName ?? ""}`}>
                {writeIn ? <WrittenLines lines={[item]} /> : item}
              </li>
              <li aria-hidden="true" className="flex shrink-0 items-center">
                {separator}
              </li>
            </Fragment>
          )),
        )}
      </animated.ul>
    </div>
  );
};
