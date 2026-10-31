/**
 * Frame manifests for the home page sequences.
 *
 * Assets live in `public/assets/sequence-1`, `-2` and `-3` (see
 * [[folder-structure]]); this module is the single place that knows their paths
 * and order, so the sequence components stay content-agnostic.
 */

/** Frames exported per composition. */
const FRAME_COUNT = 150;

/** Zero-padding width used by the exported file names. */
const INDEX_PADDING = 5;

export interface SequenceManifest {
  /** Ordered frame URLs, first to last. */
  frames: string[];
  /**
   * The same frames cut to their centre 608x1080 (`sequence-N-portrait/`):
   * exactly the part a portrait phone shows, since the canvas cover-fits and
   * centres. A third of the bytes, the decode and the GPU upload per frame
   * for the same picture — see `fitsPortraitFrames`.
   */
  portraitFrames: string[];
  /** Accessible description of what the sequence depicts. */
  label: string;
}

const buildFrames = (folder: string): string[] =>
  Array.from(
    { length: FRAME_COUNT },
    (_, index) =>
      `/assets/${folder}/frame-${String(index).padStart(INDEX_PADDING, "0")}.webp`,
  );

/** Scrubbed by scroll — see `<ScrollSequence>`. */
export const skylineSequence: SequenceManifest = {
  label:
    "Flythrough along a sunlit city street lined with autumn trees, buildings rising on both sides",
  frames: buildFrames("sequence-1"),
  portraitFrames: buildFrames("sequence-1-portrait"),
};

/** Scrubbed by scroll — see `<ScrollSequence>`. */
export const studentSequence: SequenceManifest = {
  label: "The original city skyline, looking upward through falling leaves",
  frames: buildFrames("city-clean"),
  portraitFrames: buildFrames("city-clean-portrait"),
};

/** Scrubbed by scroll — see `<ScrollSequence>`. */
export const windowSequence: SequenceManifest = {
  label:
    "A camera move from an autumn street, through a sunlit studio where someone works at a desk, out an open window to a city skyline above the treetops",
  frames: buildFrames("sequence-3"),
  portraitFrames: buildFrames("sequence-3-portrait"),
};
