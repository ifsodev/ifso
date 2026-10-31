/**
 * @fileoverview The film ticker along the bottom of a screen — scene metadata
 * running like a slate strip on frosted glass.
 */

import Image from "next/image";
import { Marquee } from "@/views/home/marquee";

/** Milliseconds for the ticker to travel two copies of its items. */
const LOOP_DURATION_MS = 80000;

export interface FilmTickerProps {
  items: string[];
  className?: string;
}

export const FilmTicker = ({ items, className }: FilmTickerProps) => {
  return (
    <Marquee
      items={items}
      label="Scene details"
      duration={LOOP_DURATION_MS}
      className={`h-10 bg-glass backdrop-blur-sm max-portrait:h-12 max-mobile:h-10 ${className ?? ""}`}
      trackClassName="gap-4 pr-4 font-mono text-meta tracking-slate text-ink/85 uppercase"
      separator={
        <Image src="/assets/home/ticker-dot.svg" alt="" width={6} height={6} className="size-1.5" />
      }
    />
  );
};
