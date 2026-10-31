"use client";

/**
 * @fileoverview Heading lines that resolve out of blur, one letter at a time
 * in a scattered order — letters surface at their own moment rather than
 * sweeping left to right, and sink back the same way when the heading goes.
 * Under reduced motion the letters are simply there.
 *
 * The letters are the heading's whole appearance, in and out: a heading that
 * uses this must not also be faded by its block, or both reveals play under a
 * uniform opacity and all anyone sees is the block. Scenes fade everything
 * else — scrim, body copy, chapter mark — and leave the heading to these.
 *
 * Renders only the line spans; the heading element and its classes stay with
 * the caller, so every block keeps its own layout (e.g. lines that run on and
 * wrap on phones).
 *
 * The scatter is hashed from each letter's position rather than drawn from
 * `Math.random`: the order has to come out identical on the server and the
 * client or hydration breaks, and a heading should scatter the same way every
 * time it replays.
 *
 * Letters are split into their own elements for the reveal, which is no good
 * to a screen reader, so each line also carries the whole line as `sr-only`
 * text and the split copy is hidden from the accessibility tree.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { animated, easings, useSprings } from "@react-spring/web";
import { useRobot } from "@/components/common/robot-view";
import { useShownNear as useOnShown } from "@/hooks/use-shown-near";
import { enqueueIdle } from "@/utils/idle-queue";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";

/** One letter's fade, and how far apart the letters' starts are scattered. */
const LETTER_MS = 560;
const SCATTER_MS = 460;
/**
 * Scrubbed instead of timed: the share of the 0-1 scrub the letters' starts
 * are spread over, so each letter still has its own moment when the heading
 * is written by scroll position rather than by a clock.
 */
const SCATTER_SHARE = 0.45;
/** Blur a letter surfaces from, in px. */
const BLUR_PX = 12;

/** Stable pseudo-random 0-1 per letter, so every visit scatters the same way. */
const scatter = (line: number, index: number) => {
  const x = Math.sin(line * 127.1 + index * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

export interface WrittenLinesProps {
  lines: string[];
  /** Classes for each line span, e.g. "block max-mobile:inline". */
  lineClassName?: string;
  /** Wait before the first letter, in ms — to queue after other text. */
  delay?: number;
  /**
   * Drive the direction from outside instead of from the heading's own
   * visibility. Any heading whose block fades has to do this: on its own the
   * heading only counts as shown once its block is already up and as hidden
   * once it is already transparent, so both the reveal and its reverse play
   * where nobody can see them. Use `useLettersIn` for the flag.
   */
  show?: boolean;
  /**
   * Hand the write-on to the caller's scroll position: the component stops
   * watching its own visibility and stops reading `show`, and follows
   * `setScrollProgress` on the ref instead. Each letter keeps its scattered
   * moment — as a share of the scrub rather than a delay in milliseconds —
   * so the heading writes itself on as you scroll in and unwrites as you
   * scroll out, at exactly the speed of the scroll.
   */
  scrub?: boolean;
}

export interface WrittenLinesHandle {
  /** 0 is blank, 1 is fully written. */
  setScrollProgress: (progress: number) => void;
}

/**
 * A `show` flag that only re-renders when it flips. Scenes drive these from a
 * scroll callback that runs on every tick, so the setter has to be cheap to
 * call with the value it already holds.
 */
export const useLettersIn = (initial = false): [boolean, (next: boolean) => void] => {
  const [value, setValue] = useState(initial);
  const current = useRef(initial);
  const set = useCallback((next: boolean) => {
    if (next === current.current) return;
    current.current = next;
    setValue(next);
  }, []);
  return [value, set];
};

/** A letter at rest, before its spring exists — the same style the spring renders. */
const RESTING = {
  blank: { opacity: 0, filter: `blur(${BLUR_PX}px)` },
  written: { opacity: 1, filter: "none" },
} as const;

interface LetterTreeProps {
  lines: string[];
  words: string[][];
  lineClassName?: string;
  anchorRef: RefObject<HTMLSpanElement | null>;
  /** Renders letter `index` (in render order) of the heading. */
  letter: (char: string, index: number) => ReactNode;
}

/** Lines → words → letters, with each line also as `sr-only` text. */
const LetterTree = ({ lines, words, lineClassName, anchorRef, letter }: LetterTreeProps) => {
  let index = 0;
  return (
    <>
      {words.map((lineWords, lineIndex) => (
        <span
          key={lines[lineIndex]}
          ref={lineIndex === 0 ? anchorRef : undefined}
          className={lineClassName}
        >
          <span className="sr-only">{lines[lineIndex]}</span>
          {lineWords.map((word, wordIndex) => (
            <span key={`${word}-${wordIndex}`}>
              <span className="inline-block" aria-hidden="true">
                {Array.from(word, (char) => letter(char, index++))}
              </span>{" "}
            </span>
          ))}
        </span>
      ))}
    </>
  );
};

interface ArmedLettersProps extends Omit<LetterTreeProps, "letter"> {
  offsets: number[];
  delays: number[];
  delay: number;
  /** The direction to play, when the heading is not scrubbed. */
  show?: boolean;
  scrub: boolean;
  /** Where the springs start: the pose the resting letters were in. */
  start: number;
  handleRef: Ref<WrittenLinesHandle>;
  /** Scroll progress that arrived before the springs existed. */
  pendingRef: RefObject<number | null>;
}

/** The letters with their springs — mounted the first time the heading plays. */
const ArmedLetters = ({
  offsets,
  delays,
  delay,
  show,
  scrub,
  start,
  handleRef,
  pendingRef,
  ...tree
}: ArmedLettersProps) => {
  const reducedMotion = usePrefersReducedMotion();
  const [springs, api] = useSprings(offsets.length, () => ({ shown: start }));

  const setScrollProgress = useCallback(
    (progress: number) => {
      // Set, not start: this value *is* the scroll position, so it must
      // not have motion of its own.
      api.start((index) => ({
        shown: reducedMotion
          ? Number(progress > 0)
          : Math.min(
              Math.max((progress - offsets[index] * SCATTER_SHARE) / (1 - SCATTER_SHARE), 0),
              1,
            ),
        immediate: true,
      }));
    },
    [api, offsets, reducedMotion],
  );
  useImperativeHandle(handleRef, () => ({ setScrollProgress }), [setScrollProgress]);

  // The scroll that armed a scrubbed heading lands here.
  useEffect(() => {
    if (!scrub || pendingRef.current === null) return;
    setScrollProgress(pendingRef.current);
    pendingRef.current = null;
  }, [scrub, pendingRef, setScrollProgress]);

  const run = useCallback(
    (shown: boolean) => {
      api.start((index) =>
        shown
        ? {
            shown: 1,
            delay: reducedMotion ? 0 : delay + delays[index],
            immediate: reducedMotion,
            config: { duration: LETTER_MS, easing: easings.easeOutCubic },
          }
          : {
              shown: 0,
              delay: reducedMotion ? 0 : delays[index],
              immediate: reducedMotion,
              // The mirror of the entry: easeIn against easeOut, same scatter,
              // so the letters sink back into blur in the order they surfaced.
              config: { duration: LETTER_MS, easing: easings.easeInCubic },
            },
      );
    },
    [api, delay, delays, reducedMotion],
  );

  useEffect(() => {
    if (!scrub && show !== undefined) run(show);
  }, [scrub, show, run]);

  return (
    <LetterTree
      {...tree}
      letter={(char, index) => (
        <animated.span
          key={index}
          className="inline-block"
          style={{
            opacity: springs[index].shown,
            // Dropped to `none` at rest so a settled heading is not
            // left holding a composited layer per letter.
            filter: springs[index].shown.to((value) =>
              value >= 1 ? "none" : `blur(${(1 - value) * BLUR_PX}px)`,
            ),
          }}
        >
          {char}
        </animated.span>
      )}
    />
  );
};

/**
 * The heading renders its letters as plain spans in their resting pose, and
 * creates its springs in an idle period after load — or earlier, the first
 * time it plays: when `show` turns, when it is first seen, or when the scrub
 * first moves. The page holds a dozen of
 * these (a few hundred letters); starting every spring at hydration was most
 * of the phone's first long task, for headings screens away.
 */
export const WrittenLines = forwardRef<WrittenLinesHandle, WrittenLinesProps>(
  ({ lines, lineClassName, delay = 0, show, scrub = false }, ref) => {
  const anchorRef = useRef<HTMLSpanElement>(null);

  // Letters grouped by word, so a word never breaks across a wrap. Memoised
  // because the delays derive from them and `run` depends on those: rebuilt
  // every render, they would make the callback a new one each time.
  const words = useMemo(() => lines.map((line) => line.split(" ")), [lines]);

  // One scatter offset (0-1) per letter, in the order the letters render in.
  // Both modes read it: timed as a delay, scrubbed as a share of the scrub.
  const offsets = useMemo(() => {
    const built: number[] = [];
    words.forEach((lineWords, lineIndex) => {
      let letterIndex = 0;
      lineWords.forEach((word) => {
        for (let i = 0; i < word.length; i += 1) {
          built.push(scatter(lineIndex, letterIndex));
          letterIndex += 1;
        }
      });
    });
    return built;
  }, [words]);
  const delays = useMemo(() => offsets.map((offset) => offset * SCATTER_MS), [offsets]);

  // The robot form (D-016) serves a heading that writes itself on its own
  // visibility already written, and one driven by `show` in whatever state the
  // flag starts in — a scrubbed one stays blank: its words are in the
  // `sr-only` copy, and its picture is the scroll position.
  const robot = useRobot();
  const restsWritten = robot && !scrub && (show ?? true);
  const [start] = useState(restsWritten ? 1 : 0);

  const [armed, setArmed] = useState(false);
  const ownVisibility = !scrub && show === undefined;
  /** Own visibility, for a heading nobody drives from outside. */
  const [seen, setSeen] = useState(false);
  const armedRef = useRef<WrittenLinesHandle>(null);
  const pendingRef = useRef<number | null>(null);

  useOnShown(anchorRef, (shown) => {
    if (!ownVisibility || robot) return;
    setSeen(shown);
    if (shown) setArmed(true);
  });
  // People's headings also arm ahead of time, one per idle period after load,
  // so a heading's first play mid-scroll does not have to create its springs
  // in that frame (a 67-84 ms frame on the student caption, desktop). The
  // robot form never plays them.
  useEffect(() => {
    if (robot) return;
    return enqueueIdle(() => setArmed(true));
  }, [robot]);

  // A driven heading arms the first time the flag leaves its resting pose.
  useEffect(() => {
    if (!scrub && show !== undefined && Number(show) !== start) setArmed(true);
  }, [scrub, show, start]);

  useImperativeHandle(
    ref,
    () => ({
      setScrollProgress: (progress) => {
        if (armedRef.current) {
          armedRef.current.setScrollProgress(progress);
          return;
        }
        pendingRef.current = progress;
        if (progress > 0) setArmed(true);
      },
    }),
    [],
  );

  if (armed) {
    return (
      <ArmedLetters
        lines={lines}
        words={words}
        lineClassName={lineClassName}
        anchorRef={anchorRef}
        offsets={offsets}
        delays={delays}
        delay={delay}
        show={ownVisibility ? seen : show}
        scrub={scrub}
        start={start}
        handleRef={armedRef}
        pendingRef={pendingRef}
      />
    );
  }

  const resting = start ? RESTING.written : RESTING.blank;
  return (
    <LetterTree
      lines={lines}
      words={words}
      lineClassName={lineClassName}
      anchorRef={anchorRef}
      letter={(char, index) => (
        <span key={index} className="inline-block" style={resting}>
          {char}
        </span>
      )}
    />
  );
});

WrittenLines.displayName = "WrittenLines";
