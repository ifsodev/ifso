"use client";

/**
 * @fileoverview Small text that surfaces line by line out of a light mist (霞):
 * each line goes from a soft blur to sharp as it fades in. Plays each time the
 * text is shown, resets once it is hidden; under reduced motion the lines are
 * simply there.
 *
 * Renders only the line elements; the caller keeps the paragraph or list and
 * its layout, and says which element each line is (a span, or an li).
 *
 * A line given as plain text is split into words, and the words are grouped
 * into the lines the browser actually wrapped them onto when the reveal
 * starts — so a long paragraph surfaces row by row on screen, at any width.
 * A line given as markup (a link, a list row) surfaces as one piece.
 */

import { useRef, type ReactNode } from "react";
import { animated, easings, useSprings } from "@react-spring/web";
import { useRobot } from "@/components/common/robot-view";
import { useShownNear as useOnShown } from "@/hooks/use-shown-near";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";

/** One line's fade, and the gap before the next line starts. */
const LINE_MS = 950;
const STAGGER_MS = 140;
/** Blur a line starts from, in px. */
const MIST_PX = 4;
/** Words whose tops differ by more than this, in px, sit on different rows. */
const ROW_TOLERANCE_PX = 2;

export interface MistedLinesProps {
  /** One entry per line, in reading order. */
  lines: {
    key: string;
    content: ReactNode;
    className?: string;
    /** Rendered ahead of the line, outside the reveal — e.g. a line break. */
    before?: ReactNode;
  }[];
  /** Element each line renders as. */
  as?: "span" | "li";
  /** Wait before the first line, in ms — to queue after other text. */
  delay?: number;
}

/** What fades together: a word of a text line, or a whole markup line. */
interface Piece {
  line: number;
  node: ReactNode;
}

export const MistedLines = ({ lines, as = "span", delay = 0 }: MistedLinesProps) => {
  const firstLineRef = useRef<HTMLElement>(null);
  const pieceRefs = useRef<(HTMLElement | null)[]>([]);
  const reducedMotion = usePrefersReducedMotion();

  const pieces: Piece[][] = lines.map((line, lineIndex) =>
    typeof line.content === "string"
      ? line.content
          .split(" ")
          .filter(Boolean)
          .map((word) => ({ line: lineIndex, node: word }))
      : [{ line: lineIndex, node: line.content }],
  );
  const flat = pieces.flat();
  // The robot form (D-016) serves every line at rest and never replays it.
  const robot = useRobot();
  const [springs, api] = useSprings(flat.length, () => ({ mist: robot ? 1 : 0 }));

  /** On-screen row of each piece: a new authored line or a wrap starts a row. */
  const rowsOf = () => {
    const rows: number[] = [];
    let row = -1;
    let lastLine = -1;
    let lastTop = Number.NaN;
    flat.forEach((piece, index) => {
      const top = pieceRefs.current[index]?.offsetTop ?? lastTop;
      if (piece.line !== lastLine || Math.abs(top - lastTop) > ROW_TOLERANCE_PX) row += 1;
      rows.push(row);
      lastLine = piece.line;
      lastTop = top;
    });
    return rows;
  };

  // Watch the lines' parent: the lines themselves start at opacity 0.
  const parentRef = {
    get current() {
      return firstLineRef.current?.parentElement ?? null;
    },
  };
  useOnShown(parentRef, (shown) => {
    if (robot) return;
    const rows = shown ? rowsOf() : [];
    api.start((index) =>
      shown
        ? {
            mist: 1,
            delay: reducedMotion ? 0 : delay + rows[index] * STAGGER_MS,
            immediate: reducedMotion,
            config: { duration: LINE_MS, easing: easings.easeOutCubic },
          }
        : { mist: 0, immediate: true },
    );
  });

  const mistStyle = (index: number) => ({
    opacity: springs[index].mist,
    filter: springs[index].mist.to((m) => (m >= 1 ? "none" : `blur(${(1 - m) * MIST_PX}px)`)),
  });

  const TextLine = as === "li" ? "li" : "span";
  const MarkupLine = as === "li" ? animated.li : animated.span;
  let pieceIndex = 0;
  return (
    <>
      {lines.map((line, lineIndex) => {
        const lineRef = lineIndex === 0 ? (firstLineRef as never) : undefined;
        if (typeof line.content !== "string") {
          const index = pieceIndex++;
          return (
            <MarkupLine
              key={line.key}
              ref={(node: HTMLElement | null) => {
                pieceRefs.current[index] = node;
                if (lineIndex === 0) firstLineRef.current = node;
              }}
              className={line.className}
              style={mistStyle(index)}
            >
              {line.before}
              {line.content}
            </MarkupLine>
          );
        }
        return (
          <TextLine key={line.key} ref={lineRef} className={line.className}>
            {line.before}
            {pieces[lineIndex].map((piece, wordIndex) => {
              const index = pieceIndex++;
              return (
                <span key={`${piece.node}-${wordIndex}`}>
                  <animated.span
                    ref={(node) => {
                      pieceRefs.current[index] = node;
                    }}
                    className="inline-block"
                    style={mistStyle(index)}
                  >
                    {piece.node}
                  </animated.span>{" "}
                </span>
              );
            })}
          </TextLine>
        );
      })}
    </>
  );
};
