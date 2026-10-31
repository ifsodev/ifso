/**
 * The portrait cut of the home sequences (`public/assets/sequence-N-portrait`):
 * the centre 608x1080 of each 1920x1080 frame, re-encoded at WebP q85.
 *
 * A canvas cover-fits and centres its frame, so a box no wider than this
 * aspect shows nothing outside the cut — the same picture from a third of the
 * pixels. Regenerate after re-exporting a sequence:
 *   cwebp -q 85 -crop 656 0 608 1080 sequence-N/frame-X.webp -o sequence-N-portrait/frame-X.webp
 */

/** Width / height of the portrait cut. */
export const PORTRAIT_FRAME_ASPECT = 608 / 1080;

/** Whether a box of this size shows nothing outside the portrait cut. */
export const fitsPortraitFrames = (width: number, height: number): boolean =>
  width > 0 && height > 0 && width / height <= PORTRAIT_FRAME_ASPECT;
