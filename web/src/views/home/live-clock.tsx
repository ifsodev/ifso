"use client";

/**
 * @fileoverview The header's scene clock, running: Eastern Standard Time (UTC−05:00),
 * HH:MM:SS, ticking once a second. The server renders the authored time and
 * the client takes over after mount, so the markup hydrates cleanly.
 */

import { useEffect, useState } from "react";

export interface LiveClockProps {
  /** Shown until the client clock starts (server render). */
  initial: string;
  className?: string;
}

const format = (date: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Etc/GMT+5", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(date) + " EST";

export const LiveClock = ({ initial, className }: LiveClockProps) => {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    // Tick on the second boundary, so the display never lags a second behind.
    const tick = () => {
      const date = new Date();
      setNow(date);
      timer = setTimeout(tick, 1000 - date.getMilliseconds());
    };
    timer = setTimeout(tick, 0);
    return () => clearTimeout(timer);
  }, []);

  return (
    <time className={`tabular-nums ${className ?? ""}`} dateTime={now ? now.toISOString() : undefined}>
      {now ? format(now) : initial}
    </time>
  );
};
