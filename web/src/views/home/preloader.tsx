"use client";

/**
 * @fileoverview Home preloader — an ASCII TV that draws the city while the
 * first frames load, then opens onto the hero.
 *
 * One spring holds the whole timeline:
 *   p — load progress 0-1: the counter and the line-by-line ASCII drawing;
 *   e — the exit: the TV screen grows to the full viewport in one move.
 *
 * The screen is a real window, not a picture. Paper covers everything around
 * it (`.intro-surround`, masked to the inverse of the screen), and the paper
 * inside it fades away early in the exit, so what shows through is the page
 * itself — the first frame of the sequence on its canvas, and the hero
 * writing itself in on top. It used to show a still of that frame instead,
 * and the hero played its whole entrance behind it, finished before anyone
 * could see it.
 *
 * `e` crosses into CSS as `--screen-open` and `--screen-reveal`, both set to
 * the same value: the window then grows from the TV size to the full
 * viewport linearly in `e`, and `e` carries the one easing curve. The two
 * steps used to be two chained ease-outs, so the screen decelerated, then
 * jumped back to full speed when the second started — the jerk in the middle.
 */

import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { animated, easings, to, useSpring } from "@react-spring/web";
import { LayersLogo } from "@/components/common/layers-logo";
import { useScroll } from "@/hooks/smooth-scroll/use-scroll";
import type { PreloaderContent } from "@/data/home/intro";
import { fitsPortraitFrames } from "@/utils/portrait-frames";
import { AsciiNoise } from "@/views/home/ascii-noise";
import { useIntro } from "@/views/home/intro-store";
import { ramp, type ProgressWindow } from "@/views/home/sequence-caption";

/** The counter never sits on 100% before everything has actually landed. */
const LOAD_CEILING = 0.96;
/** Shortest the loading state may last, so a warm cache still reads as an intro. */
const MIN_LOADING_MS = 2400;
/** A beat on 100% so the number reads before the screen moves. */
const HOLD_MS = 120;
/**
 * The exit, start to settled. Quint ease-out: it leaves at full speed and
 * spends most of its time landing — a third of the way through, the screen
 * has covered four fifths of its growth.
 */
const EXIT_MS = 1300;
/**
 * Windows on `e`, the eased exit value — so they are early in time: `e`
 * reaches 0.3 about 90ms in. The paper inside the screen clears first, so
 * the page is showing through from the start of the move.
 */
const SCREEN_CLEAR: ProgressWindow = [0, 0.3];
const ASCII_OUT: ProgressWindow = [0, 0.2];
const NOISE_IN: ProgressWindow = [0, 0.08];
const NOISE_OUT: ProgressWindow = [0.08, 0.6];
const CHROME_OUT: ProgressWindow = [0, 0.45];
/** Peak opacity of the ASCII noise over the opening screen. */
const NOISE_OPACITY = 0.45;

const wait = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));

const loadImage = (src: string) => {
  const image = new window.Image();
  image.src = src;
  return image.decode().catch(() => undefined);
};

/** Stable pseudo-random 0-1 per character, so every visit draws the same way. */
const hash = (row: number, col: number) => {
  const x = Math.sin(row * 127.1 + col * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

export interface PreloaderProps {
  content: PreloaderContent;
}

export const Preloader = ({ content }: PreloaderProps) => {
  const [mounted, setMounted] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const finish = useIntro((state) => state.finish);
  const reveal = useIntro((state) => state.reveal);
  const lineRefs = useRef<(HTMLSpanElement | null)[]>([]);

  // A character appears once progress passes its threshold: mostly top to
  // bottom like a CRT painting its lines, loosened by per-glyph noise.
  const thresholds = useMemo(() => {
    const rows = content.asciiArt.length;
    return content.asciiArt.map((line, row) =>
      Array.from(line, (_, col) => (row / rows) * 0.7 + hash(row, col) * 0.3),
    );
  }, [content.asciiArt]);

  const [{ p, e }, api] = useSpring(() => ({
    p: 0,
    e: 0,
    onChange: ({ value }) => {
      const progress = value.p as number;
      content.asciiArt.forEach((line, row) => {
        const node = lineRefs.current[row];
        if (!node) return;
        let drawn = "";
        for (let col = 0; col < line.length; col += 1) {
          drawn += thresholds[row][col] <= progress ? line[col] : " ";
        }
        node.textContent = drawn;
      });
    },
  }));

  useEffect(() => {
    let cancelled = false;
    // The home store survives client-side navigation, so each visit must
    // restart the introduction before the screen opens onto the hero.
    useIntro.setState({ phase: "loading", light: 0 });
    const { stop, start } = useScroll.getState();
    stop();
    window.scrollTo(0, 0);

    // Warm the set the scrub will paint: the portrait cut on a portrait phone.
    const frames = fitsPortraitFrames(window.innerWidth, window.innerHeight)
      ? content.preloadPortraitFrames
      : content.preloadFrames;
    const urls = [...new Set([content.heroFrame, ...frames])];
    let loaded = 0;
    let cursor = 0;
    // Fetch the active viewport's complete sequence before opening the scene.
    // Keep concurrency bounded and compressed bytes in the browser cache; decoding
    // hundreds of full frames at once would exhaust memory on phones.
    const worker = async () => {
      while (!cancelled && cursor < urls.length) {
        const src = urls[cursor++];
        const response = await fetch(src, { cache: "force-cache" });
        if (!response.ok) throw new Error(`Could not load ${src}`);
        await response.blob();
        loaded += 1;
        if (!cancelled) api.start({p: (loaded / urls.length) * LOAD_CEILING, config: { tension: 40, friction: 26 }});
      }
    };
    const assets = Array.from({length: 8}, () => worker());

    // `api.start` returns one promise per controller — an array, which
    // `await` would pass straight through. Wait for all of them.
    const play = (props: Parameters<typeof api.start>[0]) =>
      Promise.all(api.start(props));

    const run = async () => {
      try {
        await Promise.all([...assets, loadImage(content.heroFrame), document.fonts.ready, wait(MIN_LOADING_MS)]);
      } catch { if (!cancelled) setLoadError(true); return; }
      if (cancelled) return;
      await play({
        p: 1,
        config: { duration: 450, easing: easings.easeOutCubic },
      });
      await wait(HOLD_MS);
      if (cancelled) return;
      // The hero and the site chrome start with the move, not after it: the
      // window is onto the live page, so their entrances play inside it.
      reveal();
      await play({
        e: 1,
        config: { duration: EXIT_MS, easing: easings.easeOutQuint },
      });
      if (cancelled) return;
      start();
      finish();
      setMounted(false);
    };
    run();

    return () => {
      cancelled = true;
      start();
    };
  }, [api, content.heroFrame, content.preloadFrames, content.preloadPortraitFrames, finish, reveal, attempt]);

  if (!mounted) return null;

  // Custom properties are not in CSSProperties' known keys; react-spring
  // writes them through style.setProperty at runtime.
  const screenStyle = {
    "--screen-open": e,
    "--screen-reveal": e,
  } as unknown as CSSProperties;

  return (
    <animated.div
      role="status"
      aria-busy="true"
      aria-label={`${content.statusLine} — loading`}
      className="intro-screen fixed inset-0 z-[var(--layer-intro)] overflow-hidden text-ink"
      style={screenStyle}
    >
      {loadError && <button type="button" onClick={() => { setLoadError(false); setAttempt(value => value + 1); }} className="absolute bottom-20 left-12 z-50 bg-paper px-4 py-2 font-sans text-body text-ink">Some images could not load. Retry →</button>}
      {/* Paper everywhere but the screen. */}
      <div aria-hidden="true" className="intro-surround absolute inset-0 bg-paper" />
      {/* Paper inside the screen too, until the move begins and it clears
          onto the page. Full-bleed is fine: outside the screen it only ever
          sits on the surround. */}
      <animated.div
        aria-hidden="true"
        className="absolute inset-0 bg-paper"
        style={{ opacity: e.to((v) => 1 - ramp(v, SCREEN_CLEAR)) }}
      />
      <div className="intro-screen-mask absolute inset-0">
        <AsciiNoise
          opacity={to([e], (v) => NOISE_OPACITY * ramp(v, NOISE_IN) * (1 - ramp(v, NOISE_OUT)))}
        />
      </div>
      <animated.pre
        aria-hidden="true"
        className="absolute top-1/2 left-1/2 -translate-1/2 font-mono text-glyph font-semibold text-ascii"
        style={{ opacity: e.to((v) => 1 - ramp(v, ASCII_OUT)) }}
      >
        {content.asciiArt.map((line, row) => (
          <span
            key={row}
            ref={(node) => {
              lineRefs.current[row] = node;
            }}
            className="block"
          >
            {" ".repeat(line.length)}
          </span>
        ))}
      </animated.pre>

      <animated.div
        className="absolute inset-0"
        style={{ opacity: e.to((v) => 1 - ramp(v, CHROME_OUT)) }}
      >
        <LayersLogo name={content.brandName} className="absolute top-6 left-12 max-tablet:left-8 max-mobile:top-4 max-mobile:left-5" />
        <p className="absolute top-10.5 right-12 font-mono max-tablet:right-8 max-mobile:hidden text-label uppercase">
          {content.studioLine}
        </p>
        <p className="absolute bottom-10.5 left-12 font-mono max-tablet:bottom-8 max-tablet:left-8 max-mobile:bottom-5 max-mobile:left-5 text-label uppercase">
          {content.statusLine}
        </p>
        <animated.p
          aria-hidden="true"
          className="absolute right-12 bottom-10 font-display max-tablet:right-8 max-tablet:bottom-8 max-mobile:right-5 max-mobile:bottom-5 text-counter tracking-tight"
        >
          {p.to((value) => `${String(Math.round(value * 100)).padStart(3, "0")}%`)}
        </animated.p>
      </animated.div>
    </animated.div>
  );
};
