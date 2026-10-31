/**
 * Home page state shared across sections.
 *
 * `phase` — `loading` while the ASCII TV draws; `revealing` once the screen is
 * growing onto the hero, so the site chrome fades in under it as it opens;
 * `done` when the preloader is gone and scrolling is back.
 * `light` — the fixed header's ink over the current block, as a continuous
 * 0-1: 0 is dark `ink` (over the hero's bright sky, clouds and paper), 1 is
 * light `paper` (over the darker shots). Scenes drive it from their scroll
 * progress with short ramps, so the header never flips at a cut — it crossfades
 * over a stretch of scroll instead.
 */

import { create } from "zustand";

export type IntroPhase = "loading" | "revealing" | "done";

interface IntroState {
  phase: IntroPhase;
  reveal: () => void;
  finish: () => void;
  light: number;
  setLight: (light: number) => void;
}

export const useIntro = create<IntroState>((set) => ({
  phase: "loading",
  reveal: () => set({ phase: "revealing" }),
  finish: () => set({ phase: "done" }),
  light: 0,
  setLight: (light) => set((state) => (state.light === light ? state : { light })),
}));
