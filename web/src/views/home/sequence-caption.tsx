"use client";

/**
 * @fileoverview A caption pinned over a scrubbed sequence — display headline
 * bottom-left, body in the right column, chapter mark in the corner, over a
 * dark scrim. Blocks 2, 4 and 7 of the concept.
 *
 * Visibility is a window on the sequence's scroll progress, eased by a spring
 * so a fast scroll still fades rather than cuts. The scrim, the body copy and
 * the chapter mark each take that fade; the headline does not, because its
 * letters are its appearance both ways and a fade over them hides both.
 */

import { forwardRef, useImperativeHandle } from "react";
import { animated, useSpring } from "@react-spring/web";
import type { CaptionContent } from "@/data/home/story";
import { transformRange } from "@/utils/math";
import { MistedLines } from "@/components/animation/misted-lines";
import { useLettersIn, WrittenLines } from "@/components/animation/written-lines";
import { ChapterMark } from "@/views/home/chapter-mark";

/** A progress window (0-1 of the pinned span): [start, end]. */
export type ProgressWindow = [number, number];

export interface ProgressHandle {
  /** Scroll progress 0-1 of the scene this overlay is pinned over. */
  setScrollProgress: (progress: number) => void;
}

/** 0 before the window, 1 after it, linear across it. */
export const ramp = (value: number, [from, to]: ProgressWindow) =>
  transformRange(value, from, to, 0, 1);

export interface SequenceCaptionProps {
  content: CaptionContent;
  fadeIn: ProgressWindow;
  fadeOut: ProgressWindow;
  /** Heading level: the page has one h1, captions are sections under it. */
  headingTag?: "h2" | "h3";
  /** Extra heading classes, e.g. a width that makes the concept's line break. */
  headingClassName?: string;
}

export const SequenceCaption = forwardRef<ProgressHandle, SequenceCaptionProps>(
  ({ content, fadeIn, fadeOut, headingTag: Heading = "h2", headingClassName }, ref) => {
    const [{ visible }, api] = useSpring(() => ({ visible: 0 }));
    /** Whether the headline's letters should be in; see <WrittenLines>. */
    const [lettersIn, setLettersIn] = useLettersIn();

    useImperativeHandle(
      ref,
      () => ({
        setScrollProgress: (progress) => {
          api.start({
            visible: ramp(progress, fadeIn) * (1 - ramp(progress, fadeOut)),
          });
          // The letters start as the block begins to arrive and go back as it
          // begins to leave, so the write and its reverse both run inside the
          // window rather than at its edges.
          setLettersIn(progress >= fadeIn[0] && progress < fadeOut[0]);
        },
      }),
      [api, fadeIn, fadeOut, setLettersIn],
    );

    return (
      <div className="absolute inset-0 text-paper text-shadow-legible">
        <animated.div
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-110 bg-linear-to-t from-ink/72 max-tablet:h-105.5 max-portrait:h-140.75 max-mobile:h-116 to-ink/0"
          style={{ opacity: visible }}
        />
        {/* Portrait stacks headline over body at the bottom; wider layouts
            place them in their own columns. */}
        <div className="max-portrait:absolute max-portrait:inset-x-8 max-portrait:bottom-8 max-portrait:flex max-portrait:flex-col max-portrait:gap-8 max-mobile:inset-x-5 max-mobile:bottom-5 max-mobile:gap-6">
        <Heading
          className={`absolute bottom-10 left-12 font-display text-display max-tablet:bottom-8 max-tablet:left-8 max-portrait:static ${headingClassName ?? ""}`}
        >
          <WrittenLines lines={content.headlineLines} lineClassName="block" show={lettersIn} />
        </Heading>
        <animated.p
          className="absolute bottom-10 left-240 w-79.5 font-sans text-body max-tablet:bottom-8 max-tablet:left-151.5 max-tablet:w-76 max-portrait:static max-portrait:w-131 max-mobile:w-auto"
          style={{ opacity: visible }}
        >
          <MistedLines
            lines={content.bodyLines.map((line, index) => ({
              key: line,
              content: line,
              before: index > 0 && <br className="max-portrait:hidden" />,
            }))}
          />
        </animated.p>
        </div>
        <animated.div style={{ opacity: visible }}>
          <ChapterMark chapter={content.chapter} className="absolute right-12 text-shadow-mark bottom-11.25 max-tablet:right-8 max-tablet:bottom-9.25 max-portrait:top-32 max-portrait:bottom-auto max-mobile:top-28 max-mobile:right-5" />
        </animated.div>
      </div>
    );
  },
);

SequenceCaption.displayName = "SequenceCaption";
