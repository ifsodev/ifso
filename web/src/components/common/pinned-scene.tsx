"use client";

// 📖 Docs: obsidian/frontend/components/common.md

/**
 * @fileoverview A full-viewport stage pinned for a stretch of scroll, reporting
 * scroll progress 0-1 across that stretch.
 *
 * The section is `span` viewports tall; its stage sticks for `span - 1` of
 * them. With `leadIn` it starts one viewport early, over the previous section's
 * last pinned viewport, and stays hidden until it pins — so it cuts in at the
 * exact scroll position the previous one lets go, and neither picture slides.
 * When the previous scene ends on this scene's first picture, the hand-over
 * is invisible. A lead-in scene must stack above the one before it.
 *
 * The cut is timed on the scroll itself, not on the progress ticker: the
 * visibility is written in Lenis's scroll callback (and the native scroll
 * event, for scrolls Lenis does not drive), in the same frame the scroll
 * position changes — a frame of lag would flash the previous stage sliding
 * away. Section offsets are cached and refreshed on resize, so the check is a
 * comparison, not a layout read.
 *
 * Progress comes from <ProgressTrigger>, so every scene shares the app-wide
 * rAF ticker rather than attaching its own scroll listener for it.
 */

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { ProgressTrigger } from "@/components/animation/springs/progress-trigger";
import { useScroll } from "@/hooks/smooth-scroll/use-scroll";

export interface PinnedSceneProps {
  /** Accessible name of the section. */
  label: string;
  /** Section height in viewports; the stage stays pinned for `span - 1`. */
  span: number;
  leadIn?: boolean;
  /** Called with scroll progress 0-1 across the pinned stretch. */
  onProgress: (progress: number) => void;
  /**
   * Where progress leaves 0. The default starts it as the stage pins, which
   * is what a scene wants when nothing it drives is visible before then. Pass
   * `"top center"` or `"top bottom"` to start reporting while the stage is
   * still sliding up into place, so whatever it drives is already running by
   * the time the reader sees it.
   */
  progressStart?: "top top" | "top center" | "top bottom";
  /**
   * Where progress reaches 1. The default ends it as the stage unpins, which
   * is what a scene wants when the next one cuts in on its last picture. Pass
   * `"bottom top"` to keep reporting while the stage slides away instead, so
   * anything it drives carries on rather than freezing on the way out.
   */
  progressEnd?: "bottom bottom" | "bottom top";
  /** Stacking and other section-level classes. */
  className?: string;
  /** Classes for the pinned stage, e.g. a background colour. */
  stageClassName?: string;
  stageStyle?: CSSProperties;
  children: ReactNode;
}

export const PinnedScene = ({
  label,
  span,
  leadIn = false,
  onProgress,
  progressStart = "top top",
  progressEnd = "bottom bottom",
  className,
  stageClassName,
  stageStyle,
  children,
}: PinnedSceneProps) => {
  const sectionRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const lenis = useScroll((state) => state.lenis);

  useEffect(() => {
    if (!leadIn) return;
    const section = sectionRef.current;
    const stage = stageRef.current;
    if (!section || !stage) return;

    let top = 0;
    const measure = () => {
      top = section.getBoundingClientRect().top + window.scrollY;
    };
    const update = (scrollY = window.scrollY) => {
      stage.style.visibility = scrollY >= top ? "visible" : "hidden";
    };
    const onLenis = ({ scroll }: { scroll: number }) => update(scroll);
    const onNative = () => update();
    const onResize = () => {
      measure();
      update();
    };

    measure();
    update();
    lenis?.on("scroll", onLenis);
    window.addEventListener("scroll", onNative, { passive: true });
    window.addEventListener("resize", onResize);
    const observer = new ResizeObserver(onResize);
    observer.observe(document.body);
    return () => {
      lenis?.off("scroll", onLenis);
      window.removeEventListener("scroll", onNative);
      window.removeEventListener("resize", onResize);
      observer.disconnect();
    };
  }, [leadIn, lenis]);

  return (
    <ProgressTrigger
      ref={sectionRef}
      tag="section"
      aria-label={label}
      start={progressStart}
      end={progressEnd}
      onChange={({ progress }) => onProgress(progress)}
      className={`${leadIn ? "-mt-[100svh]" : ""} ${className ?? ""}`}
      style={{ height: `${span * 100}svh` }}
    >
      <div
        ref={stageRef}
        className={`sticky top-0 h-svh w-full overflow-hidden ${leadIn ? "invisible" : ""} ${stageClassName ?? ""}`}
        style={stageStyle}
      >
        {children}
      </div>
    </ProgressTrigger>
  );
};
