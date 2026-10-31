"use client";

/**
 * @fileoverview Block 3 — the street carried over to the girl looking up,
 * from inside the cloud.
 *
 * A lead-in <PinnedScene>: it starts on the outgoing sequence's final frame
 * and ends on the incoming sequence's first, so both hand-overs are invisible.
 * The clouds have already closed over the street by the time this scene
 * opens — the outgoing sequence's own last stretch brings them in (see
 * `approach`). This scene only plays the second half, `depart`: it holds the
 * cover and then lets the clouds out onto the incoming shot.
 */

import { useCallback } from "react";
import { animated, useSpring } from "@react-spring/web";
import Image from "next/image";
import { PinnedScene } from "@/components/common/pinned-scene";
import { useRobot } from "@/components/common/robot-view";
import { useImageSequence } from "@/hooks/use-image-sequence";
import type { WipeContent } from "@/data/home/story";
import { ChapterMark } from "@/views/home/chapter-mark";
import { CloudMeet, depart } from "@/views/home/cloud-meet";

export interface SkyWipeProps {
  content: WipeContent;
  onProgress: (progress: number) => void;
  /** Stacking — must sit above the scene before it. */
  className?: string;
}

export const SkyWipe = ({ content, onProgress, className }: SkyWipeProps) => {
  const [{ wipe }, api] = useSpring(() => ({ wipe: 0 }));

  // The incoming shot is scrubbed, not held: it plays its opening frames
  // under the clouds, so it is already moving when they part. Straight off
  // the scroll, like <ScrollSequence> — a spring here would lag the picture.
  const { canvasRef, showFrame } = useImageSequence(
    content.incomingFrames,
    content.incomingPortraitFrames,
  );
  // The robot form (D-016): the incoming shot's first frame as a still.
  const robot = useRobot();

  const handleProgress = useCallback(
    (progress: number) => {
      const lastIndex = content.incomingFrames.length - 1;
      if (lastIndex >= 0) {
        showFrame(Math.round(Math.min(Math.max(progress, 0), 1) * lastIndex));
      }
      // Set, not start: this value *is* the scroll position, so it must not
      // have motion of its own. A spring here lags, and the lag is worst where
      // the clouds should be exactly centred — they drift through the middle
      // instead of meeting in it, then settle once scrolling stops.
      api.set({ wipe: progress });
      onProgress(progress);
    },
    [api, onProgress, content.incomingFrames, showFrame],
  );

  return (
    <PinnedScene
      label={content.label}
      span={2}
      leadIn
      onProgress={handleProgress}
      className={className}
    >
      {robot ? (
        <Image src={content.incomingFrames[0]} alt={content.label} fill sizes="100vw" className="object-cover" />
      ) : (
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={content.label}
          className="absolute inset-0 block h-full w-full"
        />
      )}
      <CloudMeet clouds={content.clouds} progress={wipe.to(depart)} composition="drift" />

      <ChapterMark
        chapter={content.chapter}
        className="absolute right-12 bottom-11.25 text-paper text-shadow-mark max-tablet:right-8 max-tablet:bottom-6.75 max-portrait:top-32 max-portrait:bottom-auto max-mobile:top-28 max-mobile:right-5"
      />
    </PinnedScene>
  );
};
