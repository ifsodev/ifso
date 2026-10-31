"use client";

/**
 * @fileoverview Block 8's page — out of the studio window the city sinks into
 * cloud: banks drift up over the skyline and turn to paper, then the paper
 * keeps climbing and closes over the frame behind it. The frame never
 * travels: the scene stays pinned for both legs, so the reader sees a white
 * page climbing over a held shot, not the shot being dragged off the top. By
 * the time the stage unpins the screen is solid paper and the slide-off is
 * invisible.
 *
 * Only the page lives here. "Selected works" and the film index are
 * <WorksList>, a plain block in document flow after the scene — they used to
 * be printed on this page and moved with it by script, which could never
 * agree frame for frame with the ring that follows them in flow.
 *
 * Driven by the window sequence's scroll progress through one spring value,
 * `p`, written with `set` so it carries no motion of its own, on a plain
 * composited transform — no custom properties, nothing for the style engine
 * to recalculate per tick.
 */

import { forwardRef, useImperativeHandle } from "react";
import Image from "next/image";
import { animated, useSpring } from "@react-spring/web";
import type { WorksContent } from "@/data/home/story";
import { useAfterLoad } from "@/hooks/use-after-load";
import { ramp, type ProgressHandle, type ProgressWindow } from "@/views/home/sequence-caption";

/**
 * Windows on the window sequence's progress (see WINDOW_VIEWPORTS). The
 * frame underneath reaches its last picture at WINDOW_FRAME_END and holds,
 * so everything after it is carried by this page alone — both legs run to
 * the end of the pinned stretch, each 1:1 with the scroll: 60svh of rise
 * over 0.6 of a viewport, then 100svh of cover over one. The rise starts
 * before the camera move runs out, so the banks drift up over a city that is
 * still moving, and the held frame creeps towards the camera underneath
 * (`zoomToEnd`) so nothing is ever still.
 */
const RISE: ProgressWindow = [0.709, 0.818];
const COVER: ProgressWindow = [0.818, 1];

export interface WorksIntroProps {
  content: WorksContent;
}

export const WorksIntro = forwardRef<ProgressHandle, WorksIntroProps>(({ content }, ref) => {
  const [{ p }, api] = useSpring(() => ({ p: 0 }));
  // Hidden until the window scene's last stretch: fetched after load, not
  // ahead of the first paint (see `useAfterLoad`).
  const afterLoad = useAfterLoad();

  useImperativeHandle(
    ref,
    // Set, not start: this value *is* the scroll position (ADR-0029).
    () => ({ setScrollProgress: (progress) => api.set({ p: progress }) }),
    [api],
  );

  /**
   * Two legs on one transform. 100svh of cover, not less: the solid paper
   * starts 12.5rem below the container's top, and anything short of a screen
   * leaves that strip of frame showing at the top on a tall viewport. The
   * body hangs 100svh below the container, so the bottom stays covered.
   */
  const lift = p.to(
    (v) => `translate3d(0, ${(1 - ramp(v, RISE)) * 60 - ramp(v, COVER) * 100}svh, 0)`,
  );

  return (
    <div className="absolute inset-0">
      <animated.div
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 h-200 will-change-transform max-tablet:h-192 max-portrait:h-256 max-mobile:h-211"
        style={{ transform: lift, opacity: p.to((v) => (v < RISE[0] ? 0 : 1)) }}
      >
        <div className="absolute top-62 -left-16 h-70.5 w-140 opacity-95 blur-cloud-soft max-tablet:top-66.25 max-tablet:-left-15.25 max-tablet:h-54.25 max-tablet:w-107.5 max-portrait:top-88.25 max-portrait:-left-42.75 max-portrait:h-72.25 max-portrait:w-143.25 max-mobile:top-72.75 max-mobile:-left-44.5 max-mobile:h-59.5 max-mobile:w-118.25">
          {afterLoad && <Image src={content.cloud} alt="" loading="eager" fill sizes="40vw" className="object-cover" />}
        </div>
        {afterLoad && <Image src={content.cloudBank} alt="" loading="eager" width={900} height={202} className="absolute top-48 -left-100 h-121.25 w-540 max-w-none max-tablet:top-57.75 max-tablet:-left-86.5 max-tablet:h-93 max-tablet:w-414.75 max-portrait:top-77 max-portrait:-left-185.75 max-portrait:h-124.25 max-portrait:w-553 max-mobile:top-63.5 max-mobile:-left-181.75 max-mobile:h-102.25 max-mobile:w-455.75 opacity-90 mask-b-from-55% blur-cloud-far" />}
        {afterLoad && <Image src={content.cloudBank} alt="" loading="eager" width={900} height={202} className="absolute top-66 -left-140 h-134.75 w-600 max-w-none max-tablet:top-76.25 max-tablet:-left-116.5 max-tablet:h-103.5 max-tablet:w-460.75 max-portrait:top-101.75 max-portrait:-left-222 max-portrait:h-138 max-portrait:w-614.5 max-mobile:top-83.75 max-mobile:-left-210 max-mobile:h-113.75 max-mobile:w-506.5 mask-b-from-55% blur-cloud-near" />}
        {/* Clouds turn to paper along a cloud-shaped edge, not a ruled line. */}
        {/* Its silhouette is a CSS mask image — fetched after load too. */}
        <div className={`${afterLoad ? "cloud-edge " : ""}absolute -inset-x-30 top-100 h-55 bg-paper blur-cloud-near max-tablet:top-95 max-tablet:h-60 max-portrait:top-92 max-portrait:h-70 max-mobile:top-80 max-mobile:h-70`} />
        <div className="absolute inset-x-0 top-150 -bottom-[100svh] bg-paper max-tablet:top-150 max-portrait:top-150 max-mobile:top-140" />
      </animated.div>

    </div>
  );
});

WorksIntro.displayName = "WorksIntro";
