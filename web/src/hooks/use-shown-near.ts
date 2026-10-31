"use client";

/**
 * `useOnShown`, but only polled while the element is on screen.
 *
 * The vendored `useOnShown` (src/hooks/animation, protected) reads layout —
 * `getBoundingClientRect`, `checkVisibility`, `getComputedStyle` up the tree —
 * every 50 ms for the life of the page. The home page mounts ~35 of them
 * (every misted line group, written heading and chapter mark), so on a phone
 * that was a forced layout per instance on every tick of every scroll.
 *
 * Same answer, same thresholds: an IntersectionObserver says when the element
 * is on screen at all (cheap, off the main thread), and only then is the exact
 * check run on the shared ticker. Leaving the screen reports hidden, which is
 * what the polled check would have said there.
 */

import { useEffect, useRef, type RefObject } from "react";
import { useLoop } from "@/hooks/animation/use-render-loop";

/** How often visibility is checked while on screen, in ms. */
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

export const useShownNear = (
  ref: RefObject<Element | null>,
  onChange: (shown: boolean) => void,
) => {
  const shownRef = useRef(false);
  const nearRef = useRef(false);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  // The element can be replaced under the same ref (a heading swapping its
  // resting letters for animated ones), so the observer follows `ref.current`.
  const observed = useRef<{ element: Element | null; observer: IntersectionObserver | null }>({
    element: null,
    observer: null,
  });
  const follow = () => {
    const element = ref.current;
    const current = observed.current;
    if (element === current.element) return;
    current.observer?.disconnect();
    current.element = element;
    current.observer = null;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      nearRef.current = true;
      return;
    }
    current.observer = new IntersectionObserver(([entry]) => {
      nearRef.current = entry.isIntersecting;
      if (!entry.isIntersecting && shownRef.current) {
        shownRef.current = false;
        onChangeRef.current(false);
      }
    });
    current.observer.observe(element);
  };

  useEffect(() => {
    follow();
    const current = observed.current;
    return () => {
      current.observer?.disconnect();
      current.element = null;
      current.observer = null;
    };
    // Mount-only; later swaps are picked up by the loop below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLoop(
    () => {
      follow();
      if (!nearRef.current) return;
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
      onChangeRef.current(shown);
    },
    { framerate: CHECK_MS },
  );
};
