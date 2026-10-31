"use client";

/**
 * @fileoverview Hero (block 1) — pinned over the first frame of the skyline
 * sequence, so the picture behind it is the scrub's own canvas.
 *
 * Two springs: `shown` brings the chrome in as the preloader opens (phase
 * `revealing`), so the copy arrives with the screen rather than after it;
 * `scrolled` fades it out over the first stretch of scroll, handing the frame
 * over to the scrub. The opening sequence feeds `scrolled` from its scroll
 * progress — a spring, so fast scrolling still reads as a fade, not a cut.
 *
 * The headline is **not** in that fade, and it does not take the exit lift
 * either — it rises in with the rest and then leaves where it stands. Its
 * letters are its appearance both ways (see <WrittenLines>), and they only
 * start once the preloader is gone:
 * the scrub reports progress 0 from the moment the page loads, so a headline
 * driven by scroll alone wrote itself in behind the preloader and was already
 * sitting there, finished, when the screen opened onto it.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { animated, to, useSpring } from "@react-spring/web";
import type { HeroContent } from "@/data/home/intro";
import { MistedLines } from "@/components/animation/misted-lines";
import { useRobot } from "@/components/common/robot-view";
import { useLettersIn, WrittenLines } from "@/components/animation/written-lines";
import { ChapterMark } from "@/views/home/chapter-mark";
import { FilmTicker } from "@/views/home/film-ticker";
import { useIntro } from "@/views/home/intro-store";

/** Share of the pinned scroll span over which the hero fades out. */
const LEAVE_SPAN = 0.1;
/** Rise of the headline as it enters, in rem. */
const ENTER_RISE_REM = 1.5;

export interface HeroHandle {
  /** Scroll progress 0-1 of the sequence the hero is pinned over. */
  setScrollProgress: (progress: number) => void;
}

export interface HeroProps {
  content: HeroContent;
}

export const Hero = forwardRef<HeroHandle, HeroProps>(({ content }, ref) => {
  const phase = useIntro((state) => state.phase);
  /** The robot form serves the hero at rest — copy in, letters written (D-016). */
  const robot = useRobot();

  const [{ shown }, shownApi] = useSpring(() => ({ shown: robot ? 1 : 0 }));
  const [{ scrolled }, scrolledApi] = useSpring(() => ({ scrolled: 0 }));
  /** Headline letters in or out; see <WrittenLines> `show`. */
  const [lettersIn, setLettersIn] = useLettersIn(robot);
  /** The preloader has gone, so there is someone to write the headline for. */
  const openedRef = useRef(false);

  useEffect(() => {
    // `revealing`, not `done`: the screen is already opening onto the hero
    // by then, so the copy arrives with it instead of a beat after it.
    if (phase === "loading") return;
    shownApi.start({ shown: 1, config: { tension: 60, friction: 22 } });
    openedRef.current = true;
    setLettersIn(true);
  }, [phase, shownApi, setLettersIn]);

  useImperativeHandle(
    ref,
    () => ({
      setScrollProgress: (progress) => {
        scrolledApi.start({
          scrolled: Math.min(progress / LEAVE_SPAN, 1),
        });
        // Send the letters back as soon as the scrub starts, so the reverse
        // plays while the rest of the hero is still there to see it against.
        setLettersIn(openedRef.current && progress < LEAVE_SPAN * 0.2);
      },
    }),
    [scrolledApi, setLettersIn],
  );

  const visible = to([shown, scrolled], (e, l) => e * (1 - l));
  const rise = to(
    [shown, scrolled],
    (e, l) => `translate3d(0, ${(1 - e) * ENTER_RISE_REM - l * ENTER_RISE_REM}rem, 0)`,
  );
  /**
   * The headline rises in with the rest but does not travel on the way out.
   * Its exit is the letters sinking back where they stand; adding a lift to
   * that reads as the line being pulled off the screen instead.
   */
  const headlineRise = shown.to((e) => `translate3d(0, ${(1 - e) * ENTER_RISE_REM}rem, 0)`);

  return (
    <div className="absolute inset-0 text-ink">
      {/* Everything but the headline fades as one. The headline is carried by
          its own letters — folding it into this would hide them. */}
      <animated.div className="absolute inset-0" style={{ opacity: visible }}>
      <animated.p
        className="absolute top-52 left-240 w-108 font-sans text-body max-tablet:left-151.5 max-tablet:w-76 max-portrait:top-auto max-portrait:bottom-26 max-portrait:left-8 max-portrait:w-131 max-mobile:bottom-20 max-mobile:right-5 max-mobile:left-5 max-mobile:w-auto"
        style={{ transform: rise }}
      >
        {/* One line per entry at 1440; on tablet the lines run together and
            wrap in the narrower column, as in the 1024 frame. */}
        <MistedLines
          lines={content.intro.map((line) => ({
            key: line,
            content: line,
            className: "block max-tablet:inline",
          }))}
        />
      </animated.p>

      <ChapterMark chapter={content.chapter} className="absolute right-12 bottom-31.25 text-ink max-tablet:right-8 max-tablet:bottom-25.25 max-portrait:top-32 max-portrait:bottom-auto max-mobile:top-28 max-mobile:right-5" />

      <FilmTicker items={content.tickerItems} className="absolute inset-x-0 bottom-6 max-mobile:bottom-5" />
      </animated.div>

      <animated.h1
        className="absolute bottom-28 left-12 font-display text-display max-tablet:bottom-24 max-tablet:left-8 max-portrait:bottom-51 max-mobile:bottom-43 max-mobile:right-5 max-mobile:left-5 max-mobile:w-auto"
        style={{ transform: headlineRise }}
      >
        {/* Lines break as authored; on phones the headline runs on and wraps
            in the narrow column, as in the 390 frame. */}
        <WrittenLines lines={content.headlineLines} lineClassName="block max-mobile:inline" show={lettersIn} />
      </animated.h1>
    </div>
  );
});

Hero.displayName = "Hero";
