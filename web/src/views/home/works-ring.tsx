"use client";

/**
 * @fileoverview Block 9 — the ring of films. Two carousels of stills turn in
 * 3D as you scroll: the near ring below brings each film to the front in
 * turn, the far ring above counter-rotates. The film at the front is named
 * in the middle, with its index and a link underneath.
 *
 * Real CSS 3D (perspective + rotateY/translateZ), sized so the rings project
 * onto the Figma frame's orbits, which are drawn flat underneath. Each card has two faces so the far side of
 * a ring reads unmirrored and dimmed, as in the concept.
 *
 * An ordinary <PinnedScene> on paper — simply the next block after
 * <WorksList>, in the same document flow (see <HomeStory>). It slides up into
 * place with the scroll like any block and has no entrance of its own; the
 * rings are already turning when it arrives.
 */

import { useCallback, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { MistedLines } from "@/components/animation/misted-lines";
import {
  WrittenLines,
  type WrittenLinesHandle,
} from "@/components/animation/written-lines";
import { animated, useSpring, type Interpolation } from "@react-spring/web";
import { PinnedScene } from "@/components/common/pinned-scene";
import type { WorksContent } from "@/data/home/story";
import { ramp, type ProgressWindow } from "@/views/home/sequence-caption";

const CARDS_PER_RING = 12;
const STEP_DEG = 360 / CARDS_PER_RING;
/**
 * The turn runs the whole scene, and the scene runs wider than its pin:
 * `progressStart="top bottom"` starts it the moment the block's first edge
 * clears the bottom of the screen, so the rings are already turning as they
 * rise into view rather than standing still until they land;
 * `progressEnd="bottom top"` carries it past the unpin, so they keep turning
 * on the way out to the footer.
 *
 * There is no entrance window. The block arrives by scrolling up from below
 * like any other, contents and all; fading or lifting it on top of that was
 * only ever needed when it cut in over the scene before it.
 */
const TURN: ProgressWindow = [0, 1];
/**
 * The name is written by the scroll, not by a clock. Measured as the ring's
 * distance from the film it is turning to, in film-steps: fully written
 * within NAME_HOLD of the front, gone by NAME_FADE, and the step itself
 * changes at 0.5 — past the fade, so the words are swapped on a blank line
 * rather than under letters that are still leaving.
 */
const NAME_HOLD = 0.18;
const NAME_FADE = 0.45;

interface RingProps {
  stills: string[];
  /** Base angle offset of card 0, degrees. */
  offset: number;
  rotation: Interpolation<number, string>;
  className: string;
  cardClassName: string;
  /** Card placement on the ring: translateZ(radius) plus a vertical nudge. */
  cardTransform: (angle: number) => string;
}

const Ring = ({
  stills,
  offset,
  rotation,
  className,
  cardClassName,
  cardTransform,
}: RingProps) => (
  <animated.div
    aria-hidden="true"
    className={`absolute left-1/2 transform-3d ${className}`}
    style={{ transform: rotation }}
  >
    {stills.map((still, index) => (
      <div
        key={`${still}-${index}`}
        className={`absolute top-0 left-0 transform-3d ${cardClassName}`}
        style={{ transform: cardTransform(offset + index * STEP_DEG) }}
      >
        {/* Served at display size: a card is ~15vw, and the stills are frames
            of the 1920px sequences. `unoptimized` had every card decode the
            full frame — 48 of them, hundreds of MB of bitmap for a block
            that shows each at under 200px wide. */}
        <div className="absolute inset-0 overflow-hidden shadow-card backface-hidden">
          <Image src={still} alt="" fill sizes="15vw" className="object-cover" />
        </div>
        <div className="absolute inset-0 rotate-y-180 overflow-hidden opacity-55 backface-hidden">
          <Image src={still} alt="" fill sizes="15vw" className="-scale-x-100 object-cover" />
        </div>
      </div>
    ))}
  </animated.div>
);

export interface WorksRingProps {
  content: WorksContent;
  onProgress: (progress: number) => void;
  className?: string;
}

export const WorksRing = ({ content, onProgress, className }: WorksRingProps) => {
  const films = content.films;
  const [{ turn }, turnApi] = useSpring(() => ({ turn: 0 }));
  /** The film the ring has turned to; its name is the one on screen. */
  const [current, setCurrent] = useState(0);
  const nameRef = useRef<WrittenLinesHandle>(null);
  const [meta, metaApi] = useSpring(() => ({ opacity: 1 }));

  const handleProgress = useCallback(
    (progress: number) => {
      const position = ramp(progress, TURN) * (films.length - 1);
      turnApi.start({ turn: position });
      const nearest = Math.round(position);
      // How far the ring is from having that film at the front, 0 to 0.5.
      const written = 1 - ramp(Math.abs(position - nearest), [NAME_HOLD, NAME_FADE]);
      nameRef.current?.setScrollProgress(written);
      metaApi.set({ opacity: written });
      setCurrent(nearest);
      onProgress(progress);
    },
    [films.length, turnApi, metaApi, onProgress],
  );

  // Each ring holds every film twice, on opposite sides.
  const nearStills = [...films.map((film) => film.stills[0]), ...films.map((film) => film.stills[1])];
  const farStills = [...films.map((film) => film.stills[1]), ...films.map((film) => film.stills[0])];

  const film = films[current];

  return (
    <PinnedScene
      label={content.headlineLines.join(" ")}
      span={5}
      progressStart="top bottom"
      progressEnd="bottom top"
      onProgress={handleProgress}
      className={className}
      stageClassName="bg-paper text-ink"
    >
      <div className="zoom-ring absolute top-0 left-0 perspective-[200rem]">
        {/* On portrait and phones the rings hang off the screen's middle, where
            the title sits, so a shorter screen crops them rather than pushing
            them into the title. */}
        {/* Orbits are drawn flat: a 1px ring seen edge-on in 3D thins to nothing
            at the front and back, where the concept shows a clean line. */}
        <div aria-hidden="true" className="absolute top-14 left-30 h-28 w-300 rounded-full border border-ink/14 max-portrait:top-[calc(50%-14.514rem)] max-portrait:left-10 max-mobile:top-[calc(50%-18.13rem)] max-mobile:-left-63" />
        <div aria-hidden="true" className="absolute bottom-19 left-10 h-28 w-340 rounded-full border border-ink/14 max-portrait:bottom-[calc(50%-18.514rem)] max-portrait:-left-10 max-mobile:bottom-[calc(50%-18.9425rem)] max-mobile:-left-83" />
        <Ring
          stills={farStills}
          offset={STEP_DEG / 2}
          rotation={turn.to((t) => `rotateY(${t * STEP_DEG}deg)`)}
          className="top-30.5 max-portrait:top-[calc(50%-13.951rem)] max-mobile:top-[calc(50%-16.38rem)]"
          cardClassName="-mt-23 -ml-17.5 h-46 w-35 max-portrait:-mt-28.75 max-portrait:-ml-22 max-portrait:h-57.5 max-portrait:w-44"
          cardTransform={(angle) => `rotateY(${angle}deg) translateZ(37.5rem) translateY(2.5625rem)`}
        />
        <Ring
          stills={nearStills}
          offset={0}
          rotation={turn.to((t) => `rotateY(${-t * STEP_DEG}deg)`)}
          className="bottom-36.25 max-portrait:bottom-[calc(50%-16.139rem)] max-mobile:bottom-[calc(50%-17.63rem)]"
          cardClassName="-mt-30.75 -ml-23 h-61.5 w-46 max-portrait:-mt-38.5 max-portrait:-ml-28.75 max-portrait:h-77 max-portrait:w-57.5"
          cardTransform={(angle) => `rotateY(${angle}deg) translateZ(42.5rem) translateY(-2.75rem)`}
        />
      </div>

      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-50 bg-linear-to-b from-paper/96 to-paper/0 max-tablet:h-48 max-portrait:h-56.5 max-mobile:h-45" />
      <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-52 bg-linear-to-t from-paper/96 to-paper/0 max-tablet:h-50 max-portrait:h-41.25 max-mobile:h-31.25" />
      <div aria-hidden="true" className="absolute top-1/2 left-1/2 h-80 w-180 -translate-1/2 rounded-full bg-paper/90 blur-2xl max-tablet:h-76.75 max-tablet:w-153.5 max-portrait:h-89.5 max-portrait:w-172.75 max-mobile:hidden" />

      <div className="absolute inset-0">
        <div className="absolute top-1/2 left-1/2 flex -translate-1/2 flex-col items-center gap-2 text-center">
          {/* Not keyed: the same letters stay put and are rewritten, so the
              name changes under a reveal rather than under a remount. */}
          <h2 className="font-display text-display whitespace-nowrap">
            <WrittenLines ref={nameRef} lines={[film.title]} scrub />
          </h2>
          <animated.p className="font-sans text-body text-ink/64" style={{ opacity: meta.opacity }}>
            <MistedLines lines={[{ key: film.meta, content: film.meta }]} />
          </animated.p>
        </div>

        <p className="absolute bottom-10.75 left-12 font-mono text-label uppercase max-tablet:bottom-8 max-tablet:left-8 max-mobile:hidden">{content.hint}</p>
        <p className="absolute right-12 bottom-10.75 flex gap-3 font-mono text-label max-tablet:right-8 max-tablet:bottom-8 max-mobile:right-auto max-mobile:bottom-5 max-mobile:left-1/2 max-mobile:-translate-x-1/2 max-mobile:whitespace-nowrap">
          <span className="text-accent">
            {String(current + 1).padStart(2, "0")} / {String(films.length).padStart(2, "0")}
          </span>
          <Link href={film.href} className="uppercase underline">
            {film.title} — {content.watchLabel}
          </Link>
        </p>
      </div>
    </PinnedScene>
  );
};
