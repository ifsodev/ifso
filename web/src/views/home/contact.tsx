/**
 * @fileoverview Block 10 — back to the sky: a running line asking for the
 * story, the studio's address, the footer columns and the closing ticker.
 */

import Image from "next/image";
import Link from "next/link";
import type { ContactContent } from "@/data/home/story";
import { MistedLines } from "@/components/animation/misted-lines";
import { FilmTicker } from "@/views/home/film-ticker";
import { Marquee } from "@/views/home/marquee";

/** Footer columns surface one after another, label first, then its lines. */
const COLUMN_STAGGER_MS = 120;
const LINES_DELAY_MS = 90;

/** Milliseconds for the running line to travel two copies of its items. */
const RUNNING_LINE_MS = 60000;

export interface ContactProps {
  content: ContactContent;
}

export const Contact = ({ content }: ContactProps) => {
  return (
    <section id="contact" aria-label="Contact" className="relative h-svh overflow-hidden text-ink">
      <Image src={content.background} alt="" fill unoptimized sizes="100vw" className="object-cover" />
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-80 bg-linear-to-b from-paper via-paper/85 max-tablet:h-76.75 max-portrait:h-102.5 max-mobile:h-84.5 via-35% to-paper/0" />
      <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-95 bg-linear-to-t from-paper/92 max-tablet:h-104 max-portrait:h-121.5 max-mobile:h-100.25 via-paper/60 via-55% to-paper/0" />

      <h2 className="sr-only">Contact</h2>
      <div className="absolute inset-x-0 top-54 h-56 max-tablet:top-68.75 max-tablet:h-38.5 max-portrait:top-64 max-portrait:h-38 max-mobile:top-55 max-mobile:h-30">
        <div aria-hidden="true" className="absolute top-0 left-16 h-px w-328 bg-ink/30 max-tablet:left-8 max-tablet:w-240 max-portrait:right-8 max-portrait:w-auto max-mobile:right-5 max-mobile:left-5" />
        <div aria-hidden="true" className="absolute bottom-0 left-16 h-px w-328 bg-ink/30 max-tablet:left-8 max-tablet:w-240 max-portrait:right-8 max-portrait:w-auto" />
        <Marquee
          items={content.runningLine}
          label="If this, then so"
          duration={RUNNING_LINE_MS}
          className="absolute inset-x-0 top-6 max-tablet:top-6.25 max-portrait:top-4.5 max-mobile:top-5"
          trackClassName="gap-12 pr-12 font-display text-running text-ink/88 max-portrait:gap-10 max-portrait:pr-10 max-mobile:gap-7 max-mobile:pr-7"
          itemClassName="whitespace-nowrap"
          writeIn
          separator={<span className="block size-12 rounded-full bg-ink/88 max-tablet:size-9 max-portrait:size-10 max-mobile:size-7" />}
        />
      </div>

      <Link href="/dashboard?create=1" className="absolute top-118 left-12 font-sans text-link max-tablet:top-115.25 max-tablet:left-8 max-portrait:top-108 max-mobile:top-90 max-mobile:left-5 font-medium tracking-tight underline">Create a payment →</Link>

      <div className="absolute bottom-22.25 left-12 flex gap-6 max-tablet:bottom-22 max-tablet:left-8 max-portrait:bottom-26 max-portrait:grid max-portrait:grid-cols-2 max-portrait:gap-x-4 max-portrait:gap-y-8 max-mobile:bottom-20 max-mobile:left-5 max-mobile:gap-x-2.5 max-mobile:gap-y-6">
        {content.columns.map((column, columnIndex) => (
          <div key={column.label} className="flex w-79.5 flex-col gap-3 max-tablet:w-55.5 max-portrait:w-86 max-mobile:w-42.5">
            <h3 className="font-mono text-label text-accent uppercase">
              <MistedLines delay={columnIndex * COLUMN_STAGGER_MS} lines={[{ key: column.label, content: column.label }]} />
            </h3>
            <p className="font-sans text-nav">
              <MistedLines
                delay={columnIndex * COLUMN_STAGGER_MS + LINES_DELAY_MS}
                lines={column.lines.map((line) => ({
                  key: line.text,
                  className: "block",
                  content: (
                    line.href ? (
                      <Link href={line.href}>{line.text}</Link>
                    ) : line.short ? (
                      line.shortFrom === "tablet" ? (
                        <>
                          <span className="max-tablet:hidden">{line.text}</span>
                          <span className="hidden max-tablet:inline">{line.short}</span>
                        </>
                      ) : (
                        <>
                          <span className="max-mobile:hidden">{line.text}</span>
                          <span className="hidden max-mobile:inline">{line.short}</span>
                        </>
                      )
                    ) : (
                      line.text
                    )
                  ),
                }))}
              />
            </p>
          </div>
        ))}
      </div>

      <div aria-hidden="true" className="absolute inset-x-8 top-166 hidden h-px bg-ink/30 max-portrait:block max-mobile:inset-x-5 max-mobile:top-137" />
      <FilmTicker items={content.tickerItems} className="absolute inset-x-0 bottom-6 max-mobile:bottom-5" />
    </section>
  );
};
