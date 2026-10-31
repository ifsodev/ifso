"use client";

/**
 * Adaptive scaling grid hook.
 *
 * Scales the root (`<html>`) font-size up while the viewport is wider than
 * `baseWidth`, so a rem-based layout keeps growing proportionally on large
 * displays. At or below `baseWidth` the inline font-size is cleared and the
 * `vw` media queries in `globals.css` take over.
 *
 * 📖 Docs: obsidian/frontend/hooks.md
 */

import { useCallback, useEffect } from "react";

import { useResizeLoop } from "@/hooks/animation/user-resize-loop";

/** Root font-size (px) the design is measured against. */
const FONT_BASE = 16;
/**
 * Shortest viewport height (px) the base layout fits at FONT_BASE — the same
 * height cap as the `svh` term of the html font-size media queries.
 */
const MIN_BASE_HEIGHT = 800;

export interface UseAdaptiveGridOptions {
  /** Viewport width (px) above which the root font-size scales up. */
  baseWidth: number;
  /** Damping factor (0–1) for the scale-up; 1 = fully proportional. */
  coef?: number;
}

/**
 * Interpolates a font-size for `windowWidth` relative to `baseWidth`. `coef`
 * damps the effect: at 1 the size tracks the viewport 1:1, at 0 it stays flat.
 */
export const interpolateFontSize = (
  baseFontSize: number,
  baseWidth: number,
  windowWidth: number,
  coef = 0.5,
): number => {
  const widthReduction = ((baseWidth - windowWidth) / baseWidth) * 100;
  const fontReduction = widthReduction * coef;
  return baseFontSize - (baseFontSize * fontReduction) / 100;
};

export const useAdaptiveGrid = ({
  baseWidth,
  coef = 0.6666,
}: UseAdaptiveGridOptions): void => {
  const apply = useCallback(() => {
    const root = document.documentElement;
    const size = interpolateFontSize(
      FONT_BASE,
      baseWidth,
      window.innerWidth,
      coef,
    );

    if (window.innerWidth > baseWidth) {
      // A wide but short screen scales by height, so the frame still fits.
      const fit = (FONT_BASE * window.innerHeight) / MIN_BASE_HEIGHT;
      root.style.setProperty("font-size", `${Math.min(size, fit)}px`);
    } else {
      // Below the base width, let the `vw` media queries in globals.css drive.
      root.style.removeProperty("font-size");
    }
  }, [baseWidth, coef]);

  useEffect(() => {
    apply();
    // The resize loop only watches width; height changes the cap too.
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [apply]);

  useResizeLoop(apply);
};
