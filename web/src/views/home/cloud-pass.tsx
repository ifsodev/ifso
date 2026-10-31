"use client";

/**
 * @fileoverview Blocks 5-6 — clouds close over the girl looking up ("When did
 * you last look up?"), fill the screen, and part again onto the studio's
 * street ("It all starts in one room.").
 *
 * The clouds have already closed over the girl by the time this scene opens —
 * the outgoing sequence's own last stretch brings them in (see `approach`).
 * This scene plays `depart`: it holds the cover, then lets them out onto the
 * studio's street. A single spring drives the curtain and every caption's
 * window, so the copy is timed against the same clock as the clouds.
 */

import { useCallback, useRef } from "react";
import { animated, useSpring } from "@react-spring/web";
import Image from "next/image";
import { PinnedScene } from "@/components/common/pinned-scene";
import { useRobot } from "@/components/common/robot-view";
import { useImageSequence } from "@/hooks/use-image-sequence";
import type { CloudPassContent } from "@/data/home/story";
import {
  WrittenLines,
  type WrittenLinesHandle,
} from "@/components/animation/written-lines";
import { ChapterMark } from "@/views/home/chapter-mark";
import { CloudMeet, depart } from "@/views/home/cloud-meet";
import { ramp, type ProgressWindow } from "@/views/home/sequence-caption";

/**
 * Scene height in viewports; progress runs across all but the last.
 *
 * Three, not four. The copy wants frames under it, not scroll: the extra
 * viewport only stretched the same handful of frames further apart, so the
 * shot crawled and the whole scene read as a slow patch. With LEAD_FRAMES
 * raised, each line now holds over more than twice as many frames as it did
 * at four viewports, across less scroll.
 */
const VIEWPORTS = 3;
/**
 * Share of this scene the clouds take to leave — about 0.9 of a viewport,
 * which is roughly the stretch the approach took in the sequence before. It
 * is a share, so it has to grow when VIEWPORTS shrinks.
 */
const DEPART_OVER = 0.45;

/**
 * The two lines run back to back and fill the scene between them. Their own
 * windows are wider than the chapter marks' because the lines are *written*
 * across them rather than faded: the window is the whole stroke of the pen,
 * and the subtitle's has to reach 1 exactly, since the next scene cuts in
 * there and would otherwise take the last letters off mid-word.
 */
const QUESTION: [ProgressWindow, ProgressWindow] = [[0.05, 0.17], [0.38, 0.52]];
const OUTGOING_CHAPTER: [ProgressWindow, ProgressWindow] = [[0.03, 0.11], [0.45, 0.55]];
const INCOMING_CHAPTER: [ProgressWindow, ProgressWindow] = [[0.53, 0.63], [0.94, 1]];
const SUBTITLE: [ProgressWindow, ProgressWindow] = [[0.56, 0.68], [0.86, 1]];

const within = (value: number, [fadeIn, fadeOut]: [ProgressWindow, ProgressWindow]) =>
  ramp(value, fadeIn) * (1 - ramp(value, fadeOut));

export interface CloudPassProps {
  content: CloudPassContent;
  onProgress: (progress: number) => void;
  className?: string;
}

export const CloudPass = ({ content, onProgress, className }: CloudPassProps) => {
  const [{ cloud }, api] = useSpring(() => ({ cloud: 0 }));
  // Both lines are written on letter by letter, and the pen is the scroll:
  // their windows feed <WrittenLines> directly instead of flipping a flag.
  // Timed, the subtitle's reverse outlived the scene — the next scene cuts
  // in at progress 1, which left the last letters still on screen when it
  // took over.
  const questionRef = useRef<WrittenLinesHandle>(null);
  const subtitleRef = useRef<WrittenLinesHandle>(null);

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
      api.set({ cloud: progress });
      questionRef.current?.setScrollProgress(within(progress, QUESTION));
      subtitleRef.current?.setScrollProgress(within(progress, SUBTITLE));
      onProgress(progress);
    },
    [api, onProgress, content.incomingFrames, showFrame],
  );

  return (
    <PinnedScene
      label={content.label}
      span={VIEWPORTS}
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
      <CloudMeet clouds={content.clouds} progress={cloud.to((p) => depart(p, DEPART_OVER))} composition="swell" />

      <h2 className="absolute inset-x-0 top-1/2 -translate-y-1/2 px-12 text-center font-display text-title text-ink-over-image text-shadow-legible max-tablet:px-8 max-mobile:px-5">
        <WrittenLines
          ref={questionRef}
          lines={content.questionLines}
          lineClassName="block max-mobile:inline"
          scrub
        />
      </h2>

      <div className="absolute inset-0">
        <animated.div
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-80 bg-linear-to-t from-ink/80 via-ink/40 to-ink/0 max-tablet:h-76.75 max-portrait:h-102.5 max-mobile:h-84.5"
          style={{ opacity: cloud.to((c) => within(c, SUBTITLE)) }}
        />
        {/* Centred on the screen like the question it answers, not pinned to
            the foot of it. */}
        <p className="absolute inset-x-0 top-1/2 -translate-y-1/2 px-12 text-center font-display text-subtitle max-tablet:px-8 max-mobile:px-5 text-paper text-shadow-legible">
          <WrittenLines ref={subtitleRef} lines={[content.subtitle]} scrub />
        </p>
      </div>

      <animated.div style={{ opacity: cloud.to((c) => within(c, OUTGOING_CHAPTER)) }}>
        <ChapterMark chapter={content.outgoingChapter} className="absolute right-12 bottom-11.25 text-paper text-shadow-mark max-tablet:right-8 max-tablet:bottom-9.25 max-portrait:top-32 max-portrait:bottom-auto max-mobile:top-28 max-mobile:right-5" />
      </animated.div>
      <animated.div style={{ opacity: cloud.to((c) => within(c, INCOMING_CHAPTER)) }}>
        <ChapterMark chapter={content.incomingChapter} className="absolute right-12 bottom-11.25 text-paper text-shadow-mark max-tablet:right-8 max-tablet:bottom-10 max-portrait:top-32 max-portrait:bottom-auto max-mobile:top-28 max-mobile:right-5" />
      </animated.div>
    </PinnedScene>
  );
};
