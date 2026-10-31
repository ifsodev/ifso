/**
 * @fileoverview Block 8's copy — "Selected works" and the film index — as a
 * plain block in document flow, directly above the works ring.
 *
 * It used to be printed on the paper that rises inside the pinned window
 * scene, which meant its position was written by JavaScript on every tick
 * while the ring after it moved with the native scroll. Two blocks driven two
 * ways can never agree frame for frame: the distance between them breathed
 * with every scroll and the copy wobbled against the ring. In flow, both move
 * with the same scroll and the gap between them is a CSS margin — fixed by
 * construction, with no script in the loop.
 *
 * The clouds-to-paper rise that carries it in stays in the scene
 * (<WorksIntro>); this block rises over the paper that rise lays down.
 */

import Link from "next/link";
import type { WorksContent } from "@/data/home/story";
import { MistedLines } from "@/components/animation/misted-lines";
import { WrittenLines } from "@/components/animation/written-lines";
import { ChapterMark } from "@/views/home/chapter-mark";

export interface WorksListProps {
  content: WorksContent;
}

export const WorksList = ({ content }: WorksListProps) => (
  <div className="relative px-12 pt-14 pb-26 text-ink max-tablet:px-8 max-tablet:pt-12 max-tablet:pb-20 max-mobile:px-5 max-mobile:pt-10 max-mobile:pb-12">
    {/* The heading sets the block's height; the index and the chapter mark
        hang off its baseline at the concept's positions. Portrait stacks the
        index under the heading instead. */}
    <h2 className="font-display text-display max-portrait:pr-24">
      <WrittenLines lines={content.headlineLines} lineClassName="block" />
    </h2>
    <ol className="absolute bottom-26.75 left-240 flex w-79.5 flex-col gap-2 font-mono text-label max-tablet:bottom-20.75 max-tablet:left-151.5 max-tablet:w-76 max-portrait:static max-portrait:mt-8 max-portrait:w-auto max-portrait:gap-0 max-mobile:mt-6">
      <MistedLines
        as="li"
        lines={content.films.map((film, index) => ({
          key: film.title,
          content: (
            <Link
              href={film.href}
              className="flex gap-6 max-portrait:gap-8 max-portrait:border-t max-portrait:border-ink/15 max-portrait:py-3 max-mobile:gap-4 max-mobile:py-2.5"
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              <span className="flex-1 uppercase">{film.title}</span>
              <span>{film.year}</span>
            </Link>
          ),
        }))}
      />
    </ol>
    <ChapterMark
      chapter={content.chapter}
      className="absolute right-12 bottom-27.25 max-tablet:right-8 max-tablet:bottom-21.25 max-portrait:top-12 max-portrait:bottom-auto max-mobile:top-10 max-mobile:right-5"
    />
  </div>
);
