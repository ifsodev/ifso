"use client";

/**
 * Calls `onChange(true)` once an element is clearly rendered — on screen and
 * at least SHOW_OPACITY opaque through all its ancestors — and
 * `onChange(false)` once it is fully hidden again. Waiting for most of the
 * scroll-driven fade means a reveal plays where it can be seen, not while
 * its scene is still faint.
 *
 * The home scenes show and hide their text by opacity on a pinned stage, so
 * the element never leaves the viewport and an IntersectionObserver would
 * never fire. Instead the element's own rendered visibility — opacity and
 * `visibility` of it and every ancestor, via `checkVisibility` — is read on
 * the shared ticker, together with whether it is on screen, so text in an
 * ordinary scrolling section (the contact block) waits until it is scrolled
 * to. Browsers without `checkVisibility` count only the on-screen part.
 */

import { useRef, type RefObject } from "react";
import { useLoop } from "@/hooks/animation/use-render-loop";

/** How often visibility is checked, in ms. */
const CHECK_MS = 50;
/** Share of the viewport height, from the bottom, the element must clear. */
const ENTRY_MARGIN = 0.04;
/** Combined opacity at which the element counts as shown. */
const SHOW_OPACITY = 0.6;

/** The element's opacity times that of every ancestor. */
const renderedOpacity = (element: Element) => {
  let opacity = 1;
  for (let node: Element | null = element; node && opacity > 0; node = node.parentElement) {
    opacity *= Number.parseFloat(getComputedStyle(node).opacity);
  }
  return opacity;
};

export const useOnShown = (
  ref: RefObject<Element | null>,
  onChange: (shown: boolean) => void,
) => {
  const shownRef = useRef(false);
  useLoop(
    () => {
      const element = ref.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const onScreen = rect.bottom > 0 && rect.top < window.innerHeight * (1 - ENTRY_MARGIN);
      const visible =
        onScreen &&
        (element.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) ?? true);
      // Show once clearly visible; hide only once gone, so a fade does not flicker it.
      const shown = shownRef.current ? visible : visible && renderedOpacity(element) >= SHOW_OPACITY;
      if (shown === shownRef.current) return;
      shownRef.current = shown;
      onChange(shown);
    },
    { framerate: CHECK_MS },
  );
};
