"use client";

/**
 * @fileoverview The scrolled story of the home page, block 1 to block 9.
 *
 *   preloader
 *   skyline sequence  — block 1 (hero), block 2 (studio)
 *   sky wipe          — block 3
 *   student sequence  — block 4 (what we make)
 *   cloud pass        — blocks 5-6
 *   window sequence   — block 7 (process), block 8 (works intro)
 *   works ring        — block 9
 *
 * Every sequence scene after the first is a lead-in: it cuts in over the one
 * before at the exact scroll position that one lets go, on an identical
 * picture, so the story reads as one continuous shot. That needs each scene to
 * stack above the previous one, hence the rising z-index.
 *
 * The works ring is the exception and is not a lead-in. The story is over by
 * then — there is no picture to continue — so it is simply the next block,
 * sitting a paper margin below block 8.
 *
 * The fixed header's ink follows whichever scene is pinned (0 < progress < 1)
 * — the concept flips it between dark over bright sky and paper, and light
 * over the darker shots.
 */

import { useCallback, useLayoutEffect, useRef } from "react";
import { useSpring } from "@react-spring/web";
import { HydrateWhenIdle } from "@/components/common/hydrate-when-idle";
import { useRobot } from "@/components/common/robot-view";
import { ScrollSequence } from "@/components/common/scroll-sequence";
import type { HeroContent, PreloaderContent } from "@/data/home/intro";
import type { SequenceManifest } from "@/data/home/sequences";
import type {
  CaptionContent,
  CloudPassContent,
  WipeContent,
  WorksContent,
} from "@/data/home/story";
import { approach, CloudMeet } from "@/views/home/cloud-meet";
import { CloudPass } from "@/views/home/cloud-pass";
import { Hero, type HeroHandle } from "@/views/home/hero";
import { useIntro } from "@/views/home/intro-store";
import { Preloader } from "@/views/home/preloader";
import {
  ramp,
  SequenceCaption,
  type ProgressHandle,
  type ProgressWindow,
} from "@/views/home/sequence-caption";
import { SkyWipe } from "@/views/home/sky-wipe";
import { WorksIntro } from "@/views/home/works-intro";
import { WorksList } from "@/views/home/works-list";
import { WorksRing } from "@/views/home/works-ring";

/**
 * Header ink per scene, as ramps on the scene's own progress (see `light` in
 * the home store): each flip crossfades over a stretch of scroll, placed where
 * the picture under the header changes brightness, never on a cut.
 */
const SKY_TO_STREET: ProgressWindow = [0.015, 0.07];
const GIRL_TO_SKY: ProgressWindow = [0.9, 0.99];
const STREET_TO_ROOM: ProgressWindow = [0.009, 0.073];
const ROOM_TO_PAPER: ProgressWindow = [0.76, 0.81];
/**
 * The window sequence is pinned for 5.5 viewports and reports progress
 * across exactly those — the default `progressEnd`, which ends at the unpin.
 * The camera move takes the first ~3.9 (its last frame is reached at
 * WINDOW_FRAME_END and held), block 8's page rises over the next 0.6 and
 * then closes over the held frame across one more, both at 1:1.
 *
 * The frame itself never travels: the cover finishes before the unpin, so
 * the stage slides away behind a screen that is already solid paper.
 *
 * Every window on this scene is expressed against that scrub, which is why
 * the numbers look unlike their neighbours': the camera move keeps its
 * length in pixels while the scene around it changes.
 */
const WINDOW_VIEWPORTS = 6.5;
const WINDOW_FRAME_END = 0.709;
/**
 * How far the held last frame creeps towards the camera over the rest of the
 * scene. The scrub runs out at WINDOW_FRAME_END but the scene has a third of
 * itself left — block 8 settling, then the slide-off — and the picture used
 * to sit all of that out. The push in runs to the end, so the frame is still
 * moving as it leaves the screen. It costs nothing: the canvas is painted at
 * up to 2x device pixels, so a composited 1.15 is still over the screen's
 * own resolution.
 */
const WINDOW_ZOOM = 1.15;
/**
 * Block 8's copy and the works ring, one paper sheet in document flow. Both
 * move with the native scroll, so the distance between them is this
 * sheet's own layout and cannot drift — no script touches either position.
 *
 * The sheet is pulled up 115svh into the end of the window scene, so it
 * rises over the paper that scene's page lays down: it enters the bottom of
 * the screen late in the page's rise, a third of a screen below the cloud
 * edge, and both climb at 1:1 from there. It only ever overlaps paper, and
 * it stacks above the scene.
 */
const WORKS_SHEET = "relative z-60 -mt-[115svh] bg-paper";

/**
 * Share of a sequence after which its transition's clouds start coming in.
 * They accelerate from here, so the shot plays on almost untouched and the
 * bank closes over it just as it runs out — the held last frame is never
 * left in the open. See `approach` in <CloudMeet>.
 */
const CLOUDS_FROM = 0.7;

export interface HomeStoryProps {
  preloader: PreloaderContent;
  hero: HeroContent;
  studio: CaptionContent;
  wipe: WipeContent;
  whatWeMake: CaptionContent;
  cloudPass: CloudPassContent;
  process: CaptionContent;
  works: WorksContent;
  sequences: {
    skyline: SequenceManifest;
    student: SequenceManifest;
    window: SequenceManifest;
  };
}

export const HomeStory = ({
  preloader,
  hero,
  studio,
  wipe,
  whatWeMake,
  cloudPass,
  process,
  works,
  sequences,
}: HomeStoryProps) => {
  const setLight = useIntro((state) => state.setLight);
  const robot = useRobot();
  const finish = useIntro((state) => state.finish);

  // The robot form has no preloader (D-016): the page is open from the start.
  // The first screen is already at rest in the served HTML (each entrance
  // reads `useRobot()`); this only releases what waits on the phase.
  useLayoutEffect(() => {
    if (robot) finish();
  }, [robot, finish]);

  // Each transition's clouds start inside the sequence before it, so the
  // scenes share one continuous pass: `approach` here, `depart` in the scene.
  // These carry scroll position, not motion of their own — see `.set` below.
  const [{ skylineOut }, skylineOutApi] = useSpring(() => ({ skylineOut: 0 }));
  const [{ studentOut }, studentOutApi] = useSpring(() => ({ studentOut: 0 }));
  const heroRef = useRef<HeroHandle>(null);
  const studioRef = useRef<ProgressHandle>(null);
  const whatWeMakeRef = useRef<ProgressHandle>(null);
  const processRef = useRef<ProgressHandle>(null);
  const worksIntroRef = useRef<ProgressHandle>(null);

  /** Set the header's ink while `progress` says this scene is the pinned one. */
  const lightWhilePinned = useCallback(
    (progress: number, light: number) => {
      if (progress > 0 && progress < 1) setLight(light);
    },
    [setLight],
  );

  const onSkyline = useCallback(
    (progress: number) => {
      heroRef.current?.setScrollProgress(progress);
      studioRef.current?.setScrollProgress(progress);
      skylineOutApi.set({ skylineOut: progress });
      // The top of the page counts too — progress sits at 0 there.
      if (progress < 1) setLight(ramp(progress, SKY_TO_STREET));
    },
    [setLight, skylineOutApi],
  );
  const onWipe = useCallback((p: number) => lightWhilePinned(p, 1), [lightWhilePinned]);
  const onStudent = useCallback(
    (progress: number) => {
      whatWeMakeRef.current?.setScrollProgress(progress);
      studentOutApi.set({ studentOut: progress });
      lightWhilePinned(progress, 1 - ramp(progress, GIRL_TO_SKY));
    },
    [lightWhilePinned, studentOutApi],
  );
  const onCloudPass = useCallback((p: number) => lightWhilePinned(p, 0), [lightWhilePinned]);
  const onWindow = useCallback(
    (progress: number) => {
      processRef.current?.setScrollProgress(progress);
      worksIntroRef.current?.setScrollProgress(progress);
      lightWhilePinned(
        progress,
        ramp(progress, STREET_TO_ROOM) * (1 - ramp(progress, ROOM_TO_PAPER)),
      );
    },
    [lightWhilePinned],
  );
  const onWorks = useCallback((p: number) => lightWhilePinned(p, 0), [lightWhilePinned]);

  return (
    <>
      {!robot && <Preloader content={preloader} />}
      <ScrollSequence
        frames={sequences.skyline.frames}
        portraitFrames={sequences.skyline.portraitFrames}
        label={sequences.skyline.label}
        onProgress={onSkyline}
        className="relative z-10"
        priority
      >
        <Hero ref={heroRef} content={hero} />
        <SequenceCaption ref={studioRef} content={studio} fadeIn={[0.16, 0.26]} fadeOut={[0.82, 0.92]} />
        <CloudMeet
          clouds={wipe.clouds}
          progress={skylineOut.to(approach(CLOUDS_FROM))}
          composition="drift"
        />
      </ScrollSequence>

      {/* Every scene below the hero hydrates on its own, one per idle period
          after load, under the preloader — not in the page's one hydration
          commit. Their server HTML stays on screen; nothing remounts. */}
      <HydrateWhenIdle>
        <SkyWipe content={wipe} onProgress={onWipe} className="relative z-20" />
      </HydrateWhenIdle>

      <HydrateWhenIdle>
      <ScrollSequence
        frames={sequences.student.frames}
        portraitFrames={sequences.student.portraitFrames}
        label={sequences.student.label}
        frameStart={wipe.leadShare}
        leadIn
        onProgress={onStudent}
        className="relative z-30"
      >
        <SequenceCaption
          ref={whatWeMakeRef}
          content={whatWeMake}
          fadeIn={[0.16, 0.26]}
          fadeOut={[0.8, 0.9]}
          headingClassName="max-tablet:w-99.75 max-portrait:w-auto"
        />
        <CloudMeet
          clouds={cloudPass.clouds}
          progress={studentOut.to(approach(CLOUDS_FROM))}
          composition="swell"
        />
      </ScrollSequence>
      </HydrateWhenIdle>

      <HydrateWhenIdle>
        <CloudPass content={cloudPass} onProgress={onCloudPass} className="relative z-40" />
      </HydrateWhenIdle>

      <HydrateWhenIdle>
      <ScrollSequence
        frames={sequences.window.frames}
        portraitFrames={sequences.window.portraitFrames}
        label={sequences.window.label}
        scrollViewports={WINDOW_VIEWPORTS}
        frameEnd={WINDOW_FRAME_END}
        zoomToEnd={WINDOW_ZOOM}
        frameStart={cloudPass.leadShare}
        leadIn
        onProgress={onWindow}
        className="relative z-50"
      >
        <SequenceCaption ref={processRef} content={process} fadeIn={[0.2, 0.273]} fadeOut={[0.472, 0.545]} />
        <WorksIntro ref={worksIntroRef} content={works} />
      </ScrollSequence>
      </HydrateWhenIdle>

      <div className={WORKS_SHEET}>
        <HydrateWhenIdle>
          <WorksList content={works} />
        </HydrateWhenIdle>
        <HydrateWhenIdle>
          <WorksRing content={works} onProgress={onWorks} />
        </HydrateWhenIdle>
      </div>
    </>
  );
};
