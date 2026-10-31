"use client";

/**
 * @fileoverview Full-viewport field of ASCII glyphs cut out of the hero frame
 * (`.ascii-noise`), laid over the opening screen.
 *
 * The glyphs are random, so they are generated after mount — rendering them on
 * the server would guarantee a hydration mismatch — and sized to the viewport
 * in whole character cells.
 */

import { useEffect, useState } from "react";
import { animated, type Interpolation } from "@react-spring/web";

/** The glyph set of the "01b — Intro → hero" frame. */
const GLYPHS = "%+@*#=";
/** IBM Plex Mono advance width, as a share of the font size. */
const CHAR_ADVANCE = 0.6;

export interface AsciiNoiseProps {
  /** Spring-driven opacity from the preloader timeline. */
  opacity: Interpolation<number>;
}

export const AsciiNoise = ({ opacity }: AsciiNoiseProps) => {
  const [text, setText] = useState("");

  useEffect(() => {
    const fontSize = parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    const cols = Math.ceil(window.innerWidth / (fontSize * CHAR_ADVANCE));
    const rows = Math.ceil(window.innerHeight / fontSize);
    const lines = Array.from({ length: rows }, () =>
      Array.from(
        { length: cols },
        () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)],
      ).join(""),
    );
    setText(lines.join("\n"));
  }, []);

  return (
    <animated.pre
      aria-hidden="true"
      // The glyphs are cut out of the hero frame (`.ascii-noise`), so the class
      // waits for them: on an empty <pre> it only fetched the frame ahead of
      // the first paint, for nothing to show.
      className={`${text ? "ascii-noise " : ""}absolute inset-0 overflow-hidden font-mono text-glyph font-semibold`}
      style={{ opacity }}
    >
      {text}
    </animated.pre>
  );
};
