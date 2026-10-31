"use client";

/**
 * @fileoverview Chapter mark — the chapter's name as stacked kanji with a small
 * mono translation underneath.
 *
 * Each time the mark comes into view the kanji are written in one by one, in
 * stroke order's rhythm: glyphs alternate a downward and a rightward stroke,
 * then the translation settles in. The marks sit inside scenes that fade them
 * by opacity, so "shown" comes from useOnShown, which reads the rendered
 * visibility; it resets once the mark has faded out, so it writes again on
 * the way back.
 */

import { useRef } from "react";
import { animated, easings, useSprings } from "@react-spring/web";
import type { ChapterContent } from "@/data/home/intro";
import { useRobot } from "@/components/common/robot-view";
import { useShownNear as useOnShown } from "@/hooks/use-shown-near";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";

/** One glyph's stroke, and the gap before the next glyph starts. */
const STROKE_MS = 400;
const STAGGER_MS = 280;

export interface ChapterMarkProps {
  chapter: ChapterContent;
  /** Position and colour — the mark follows the header's ink on each block. */
  className?: string;
}

/**
 * Clip for a glyph `draw` (0-1) of the way in: even glyphs down, odd across.
 * Fully drawn, the clip comes off so the legibility halo is not cut square.
 */
const strokeClip = (index: number, draw: number) => {
  if (draw >= 1) return "none";
  const rest = `${(1 - draw) * 100}%`;
  return index % 2 === 0 ? `inset(0 0 ${rest} 0)` : `inset(0 ${rest} 0 0)`;
};

export const ChapterMark = ({ chapter, className }: ChapterMarkProps) => {
  const { kanji, translation } = chapter;
  const glyphs = Array.from(kanji);
  const markRef = useRef<HTMLParagraphElement>(null);
  const reducedMotion = usePrefersReducedMotion();

  // One spring per glyph, plus one for the translation after the last glyph.
  // The robot form (D-016) serves the mark drawn and never replays it.
  const robot = useRobot();
  const [springs, api] = useSprings(glyphs.length + 1, () => ({ draw: robot ? 1 : 0 }));

  useOnShown(markRef, (shown) => {
    if (robot) return;
    api.start((index) =>
      shown
        ? {
            draw: 1,
            delay: reducedMotion ? 0 : index * STAGGER_MS,
            immediate: reducedMotion,
            config: { duration: STROKE_MS, easing: easings.linear },
          }
        : { draw: 0, immediate: true },
    );
  });

  const translationSpring = springs[glyphs.length];

  return (
    <p
      ref={markRef}
      lang="ja"
      className={`flex flex-col items-center gap-3 text-center ${className ?? ""}`}
    >
      <span className="flex flex-col font-kanji text-kanji font-bold">
        {glyphs.map((glyph, index) => (
          <animated.span
            key={`${glyph}-${index}`}
            style={{ clipPath: springs[index].draw.to((draw) => strokeClip(index, draw)) }}
          >
            {glyph}
          </animated.span>
        ))}
      </span>
      <animated.span
        lang="en"
        className="flex flex-col font-mono text-micro tracking-slate uppercase"
        style={{ opacity: translationSpring.draw.to((draw) => draw * 0.75) }}
      >
        {translation.map((word) => (
          <span key={word}>{word}</span>
        ))}
      </animated.span>
    </p>
  );
};
