"use client";

/**
 * @fileoverview The cloud curtain that carries one sequence over into the
 * next: cut-outs drift in from opposite sides, overlap across the screen, and
 * carry straight on out the far side.
 *
 * The pass is split across two scenes, so neither sequence is ever caught on a
 * still frame:
 *
 *   outgoing sequence, last stretch   `approach(from)`  0 → COVER_AT
 *   transition scene                  `depart`          COVER_AT → 1
 *
 * Both halves are linear, so the whole pass is one constant drift: the clouds
 * close over a shot that is still playing and open again onto one that is
 * already moving.
 *
 * A flat `--cloud` fill rises behind the cut-outs across the middle of the
 * pass: four shapes cannot promise a seam-free cover at every aspect ratio.
 *
 * > Two things here are performance, not taste. The blur is **baked into the
 * > assets**, not a CSS `filter`: a live filter on a 200vw element is re-run
 * > every frame it moves. And each cut-out animates its own `transform` in
 * > percentages of its own width, so the travel is compositor-only and needs
 * > no viewport measurement — a custom property feeding `calc()` would
 * > invalidate style for the whole subtree on every frame instead.
 */

import Image from "next/image";
import { animated, type Interpolation, type SpringValue } from "@react-spring/web";
import { useAfterLoad } from "@/hooks/use-after-load";
import { ramp, type ProgressWindow } from "@/views/home/sequence-caption";

/** Progress at which the clouds are centred and the screen is covered. */
export const COVER_AT = 0.5;

/** The fill is fully opaque around the cover, so the hand-over is never caught. */
const FILL_IN: ProgressWindow = [0.28, 0.44];
const FILL_OUT: ProgressWindow = [0.56, 0.72];

type ProgressValue = SpringValue<number> | Interpolation<number, number>;

/** One cut-out, pre-blurred at two depths — see `public/assets/home/`. */
export interface CloudCutout {
  /** Lightly blurred, for the cut-outs nearest the front. */
  soft: string;
  /** Heavily blurred, for the ones sitting further back. */
  deep: string;
}

/**
 * Maps an outgoing sequence's own progress onto the clouds coming in.
 *
 * Nothing moves until `from`; from there the bank travels at a constant
 * speed and closes over the shot exactly as it runs out. Linear on purpose:
 * an eased approach reads as the clouds lunging at the end, and the pass is
 * meant to feel like weather drifting through, not like a shutter.
 */
export const approach = (from: number) => (progress: number) => {
  const t = Math.min(Math.max((progress - from) / (1 - from), 0), 1);
  return t * COVER_AT;
};

/**
 * Maps a transition scene's progress onto the clouds leaving. It opens already
 * covered, on the bank the outgoing sequence closed with, and carries on at
 * the same constant speed.
 *
 * This half used to hold the cover late, to keep a held first frame out of
 * sight. It no longer has to: the incoming shot is scrubbed under the clouds
 * (ADR-0030), so it is already moving whenever they clear.
 *
 * `over` is the share of the scene the departure takes. A scene that is long
 * for reasons of its own — captions to read — would otherwise drag the clouds
 * out at a fraction of the speed they came in; give it the same stretch of
 * scroll the approach used and the pass stays one even drift.
 */
export const depart = (progress: number, over = 1) =>
  COVER_AT + Math.min(progress / over, 1) * COVER_AT;

/**
 * Where one cut-out sits and which way it crosses. Sizes are deliberately far
 * larger than the screen: a cut-out whose own silhouette ends inside the frame
 * reads as a sticker, so every one of them runs off at least two edges.
 */
interface CloudBand {
  /** -1 drifts in from the left, 1 from the right. */
  side: -1 | 1;
  /** Width as a share of the viewport width. */
  width: number;
  /** Distance travelled before it is centred, as a share of viewport width. */
  travel: number;
  /** Top edge as a share of the stage height. */
  top: number;
  /** Aspect ratio of the cut-out, so it is never squashed. */
  aspect: number;
  depth: keyof CloudCutout;
  opacity: number;
}

/**
 * Each transition gets its own arrangement, so the two passes do not read as
 * the same shot twice. **Both halves of one transition must use the same one**
 * or the clouds change shape at the scene boundary.
 */
const COMPOSITIONS: Record<string, CloudBand[]> = {
  /** Low and wide — the bank rolls across the street. */
  drift: [
    { side: 1, width: 175, travel: 138, top: -20, aspect: 709 / 405, depth: "soft", opacity: 0.96 },
    { side: -1, width: 198, travel: 158, top: 8, aspect: 1158 / 509, depth: "deep", opacity: 0.92 },
    { side: 1, width: 186, travel: 144, top: 30, aspect: 1116 / 526, depth: "soft", opacity: 1 },
    { side: -1, width: 208, travel: 164, top: 50, aspect: 1158 / 768, depth: "deep", opacity: 1 },
  ],
  /** Taller and heavier, entering from the opposite sides — the sky closes in. */
  swell: [
    { side: -1, width: 162, travel: 132, top: -26, aspect: 751 / 447, depth: "deep", opacity: 1 },
    { side: 1, width: 216, travel: 168, top: 16, aspect: 1116 / 467, depth: "soft", opacity: 0.95 },
    { side: -1, width: 182, travel: 146, top: 42, aspect: 1158 / 568, depth: "soft", opacity: 0.98 },
    { side: 1, width: 202, travel: 156, top: -6, aspect: 1116 / 726, depth: "deep", opacity: 1 },
  ],
};

export type CloudComposition = keyof typeof COMPOSITIONS;

export interface CloudMeetProps {
  /** Cloud cut-outs, one per band, in order. */
  clouds: CloudCutout[];
  /** The cloud timeline, 0-1 — see `approach` and `depart`. */
  progress: ProgressValue;
  /** Which arrangement to use; one per transition. */
  composition?: CloudComposition;
}

export const CloudMeet = ({ clouds, progress, composition = "drift" }: CloudMeetProps) => {
  const bands = COMPOSITIONS[composition];
  // Off-screen until a transition screens away: fetched after load, not
  // ahead of the first paint (see `useAfterLoad`).
  const afterLoad = useAfterLoad();

  return (
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden">
      <animated.div
        className="absolute inset-0 bg-cloud"
        style={{
          opacity: progress.to((p) => ramp(p, FILL_IN) * (1 - ramp(p, FILL_OUT))),
        }}
      />

      {clouds.map((cutout, index) => {
        const band = bands[index % bands.length];
        // Travel as a share of the cut-out's own width, so the transform is a
        // plain percentage — identical on server and client, and composited.
        const reach = (band.travel / band.width) * 100;
        return (
          <animated.div
            key={cutout.soft}
            className="absolute will-change-transform"
            style={{
              left: "50%",
              marginLeft: `${-band.width / 2}vw`,
              width: `${band.width}vw`,
              aspectRatio: band.aspect,
              top: `${band.top}%`,
              opacity: band.opacity,
              transform: progress.to(
                (p) => `translate3d(${(band.side * (1 - 2 * p) * reach).toFixed(3)}%, 0, 0)`,
              ),
            }}
          >
            {afterLoad && (
              <Image
                src={cutout[band.depth]}
                alt=""
                fill
                loading="eager"
                sizes="200vw"
                className="object-contain"
              />
            )}
          </animated.div>
        );
      })}
    </div>
  );
};
