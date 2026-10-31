"use client";

// 📖 Docs: obsidian/frontend/components/common.md

/**
 * @fileoverview Scroll-scrubbed image sequence.
 *
 * Maps scroll progress onto the frame index, so scrolling scrubs the sequence
 * like a timeline. Painting is `useImageSequence`; pinning is <PinnedScene>;
 * this component only decides which frame is current. There is no spring on
 * the index on purpose: it is a discrete value, and interpolating it would
 * show frames the scroll position is not on.
 *
 * `zoomToEnd` is the exception — once the scrub has run out of frames, the
 * held picture can keep moving by creeping towards the camera. That is a
 * continuous value, so it is sprung, and it rides on a composited transform
 * rather than a repaint.
 */

import { useCallback, type ReactNode } from "react";
import Image from "next/image";
import { animated, useSpring } from "@react-spring/web";
import { PinnedScene } from "@/components/common/pinned-scene";
import { useRobot } from "@/components/common/robot-view";
import { useImageSequence } from "@/hooks/use-image-sequence";

export interface ScrollSequenceProps {
  /** Ordered frame URLs, first to last. */
  frames: string[];
  /** The same frames' portrait cut, painted on a portrait phone (see useImageSequence). */
  portraitFrames?: string[];
  /** Accessible description of what the sequence depicts. */
  label: string;
  /**
   * Section height in viewports. Higher values slow the scrub down; the frame
   * is pinned for all but the last viewport.
   */
  scrollViewports?: number;
  /**
   * Progress (0-1) at which the last frame is reached; the rest of the span
   * holds it, e.g. while an overlay plays over the final shot. Defaults just
   * short of 1, so the last frame is already up when the stage unpins and the
   * next scene cuts in on that same picture.
   */
  frameEnd?: number;
  /**
   * Frame the scrub begins on, as a 0-1 share of the sequence. Use it when
   * something ahead of this scene has already played the opening frames — the
   * scrub then carries on from there instead of snapping back to the start.
   */
  frameStart?: number;
  /**
   * Scale the held last frame reaches at progress 1, e.g. `1.15`. The zoom
   * runs from `frameEnd` onwards, so the stretch where the scrub has nothing
   * left to play is still moving. Defaults to 1 — no zoom.
   */
  zoomToEnd?: number;
  /** See <PinnedScene> — cut in over the previous section. */
  leadIn?: boolean;
  /**
   * See <PinnedScene>. `"bottom top"` keeps progress running while the stage
   * slides away, which is what a `zoomToEnd` wants: the push in carries on
   * until the picture is off the screen instead of stopping at the unpin.
   */
  progressEnd?: "bottom bottom" | "bottom top";
  className?: string;
  /** Called with scroll progress 0-1 across the pinned span. */
  onProgress?: (progress: number) => void;
  /** Content pinned over the frames, e.g. a caption. */
  children?: ReactNode;
  /**
   * The first screen's sequence: on the robot form its still is the page's
   * LCP image, so it is preloaded.
   */
  priority?: boolean;
}

export const ScrollSequence = ({
  frames,
  portraitFrames,
  label,
  scrollViewports = 4,
  frameEnd = 0.985,
  frameStart = 0,
  zoomToEnd = 1,
  leadIn = false,
  progressEnd = "bottom bottom",
  className,
  onProgress,
  children,
  priority = false,
}: ScrollSequenceProps) => {
  // The robot form (D-016) gets the frame the scrub opens on as a still: no
  // canvas, and no sequence to download (with no canvas mounted, the hook
  // never starts loading).
  const robot = useRobot();
  const { canvasRef, showFrame } = useImageSequence(frames, portraitFrames);
  const [{ zoom }, zoomApi] = useSpring(() => ({ zoom: 0 }));
  const zooms = zoomToEnd > 1 && frameEnd < 1;

  const handleProgress = useCallback(
    (progress: number) => {
      const lastIndex = frames.length - 1;
      if (lastIndex >= 0) {
        const scrubbed = Math.min(progress / frameEnd, 1);
        showFrame(
          Math.round((frameStart + (1 - frameStart) * scrubbed) * lastIndex),
        );
      }
      if (zooms) {
        zoomApi.start({
          zoom: Math.max(0, (progress - frameEnd) / (1 - frameEnd)),
        });
      }
      onProgress?.(progress);
    },
    [frames.length, frameEnd, frameStart, zooms, zoomApi, showFrame, onProgress],
  );

  return (
    <PinnedScene
      label={label}
      span={scrollViewports}
      leadIn={leadIn}
      progressEnd={progressEnd}
      onProgress={handleProgress}
      className={className}
    >
      {robot ? (
        <Image
          src={frames[Math.round(frameStart * (frames.length - 1))]}
          alt={label}
          fill
          sizes="100vw"
          priority={priority}
          className="object-cover"
        />
      ) : (
      <animated.canvas
        ref={canvasRef}
        role="img"
        aria-label={label}
        className="block h-full w-full"
        style={
          zooms
            ? {
                transform: zoom.to((v) => `scale(${1 + v * (zoomToEnd - 1)})`),
                willChange: "transform",
              }
            : undefined
        }
      />
      )}
      {children}
    </PinnedScene>
  );
};
