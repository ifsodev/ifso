/**
 * @fileoverview Paints a frame sequence into a <canvas>.
 *
 * The part an image sequence needs regardless of what drives it: decode the
 * frames once, draw one on demand in cover-fit, and re-fit after a viewport
 * change. What advances the frame index stays the caller's business — today
 * that is scroll progress, in `<ScrollSequence>`.
 *
 * Frames are held as decoded `HTMLImageElement`s, so showing one is a single
 * `drawImage` with no decode on the critical path.
 *
 * 📖 Docs: obsidian/frontend/hooks.md
 */

"use client";

import { RefObject, useCallback, useEffect, useRef, useState } from "react";
import { fitsPortraitFrames } from "@/utils/portrait-frames";
import { useWindowSize } from "@/hooks/use-window-size";

/** Cap the backing store on high-DPR screens — beyond 2x costs fill rate for no visible gain. */
const MAX_PIXEL_RATIO = 2;

/**
 * How early to start fetching, as a share of the viewport. "100%" means a
 * sequence begins loading one full screen before it is reached, so it is ready
 * by the time it arrives without every sequence downloading at first paint.
 */
const PRELOAD_MARGIN = "100%";

export interface UseImageSequenceResult {
  /** Attach to the <canvas> the sequence paints into. */
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** Paint frame `index`. A no-op if that frame has not decoded yet. */
  showFrame: (index: number) => void;
}

/**
 * Decoded bitmaps kept around the current frame on the portrait path: this
 * many ahead in the scroll direction, BITMAPS_BEHIND behind, and none further
 * than BITMAPS_KEEP away. ~2.6 MB each at 608x1080.
 */
const BITMAPS_AHEAD = 16;
const BITMAPS_BEHIND = 5;
const BITMAPS_KEEP = 22;

type FrameSource = HTMLImageElement | ImageBitmap;

/**
 * Frame requests issued per task. A scene comes within a screen mid-swipe,
 * and issuing all 150 requests in that one task was a ~150 ms frame on a
 * 4x-throttled phone (kumo). In batches, nearest the current frame first,
 * each task is a few milliseconds.
 */
const REQUESTS_PER_TASK = 6;

/** Run `issue(index)` for every index, nearest `from` first, a batch per task. */
const issueNearestFirst = (
  count: number,
  from: number,
  issue: (index: number) => void,
  cancelled: () => boolean,
) => {
  const order = Array.from({ length: count }, (_, index) => index).sort(
    (a, b) => Math.abs(a - from) - Math.abs(b - from) || a - b,
  );
  let next = 0;
  const batch = () => {
    if (cancelled()) return;
    for (let n = 0; n < REQUESTS_PER_TASK && next < order.length; n += 1) {
      issue(order[next]);
      next += 1;
    }
    if (next < order.length) setTimeout(batch, 0);
  };
  batch();
};

const sizeOf = (source: FrameSource) =>
  source instanceof HTMLImageElement
    ? { width: source.naturalWidth, height: source.naturalHeight }
    : { width: source.width, height: source.height };

/**
 * @param frames Full frames, first to last.
 * @param portraitFrames Optional centre cut of the same frames, painted instead
 *   while the canvas is narrow enough to show nothing outside it (a portrait
 *   phone) — the same picture for a third of the decode and upload. A resize
 *   past that width switches back to the full frames.
 */
export function useImageSequence(
  frames: string[],
  portraitFrames?: string[],
): UseImageSequenceResult {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasSizeRef = useRef({ width: 0, height: 0 });
  const imagesRef = useRef<HTMLImageElement[]>([]);
  const frameIndexRef = useRef(0);
  const { width, height } = useWindowSize();

  /*
   * The portrait path (a phone) paints from ImageBitmaps instead of <img>s.
   * An <img> drawn into a canvas is decoded at raster time, synchronously, on
   * the main thread — and a sequence's 150 decoded frames do not stay in the
   * decode cache, so every scrubbed frame was decoded again inside the frame
   * that showed it (kumo: ~13 ms a frame on a 4x-throttled phone, 9% of the
   * scroll's frames dropped). The compressed bytes are kept as blobs and a
   * window of frames around the current one is decoded ahead, off the main
   * thread, by `createImageBitmap`; the window is released when the scene is
   * off screen.
   */
  const blobsRef = useRef<(Blob | undefined)[]>([]);
  const bitmapsRef = useRef(new Map<number, ImageBitmap>());
  const decodingRef = useRef(new Set<number>());
  const directionRef = useRef(1);
  const nearRef = useRef(true);
  const bitmapPathRef = useRef(false);

  const sourceAt = (index: number): FrameSource | undefined => {
    if (bitmapPathRef.current) return bitmapsRef.current.get(index);
    const image = imagesRef.current[index];
    return image?.complete && image.naturalWidth > 0 ? image : undefined;
  };

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const source = sourceAt(frameIndexRef.current);
    if (!source) return;
    const { width: sourceWidth, height: sourceHeight } = sizeOf(source);
    if (sourceWidth === 0 || sourceHeight === 0) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const { width: cssWidth, height: cssHeight } = canvasSizeRef.current;
    if (cssWidth === 0 || cssHeight === 0) return;

    // No more device pixels than the frame has to give: past the frame's own
    // resolution the canvas only holds an upscaled copy, and every pixel of it
    // is drawn on each scroll tick and composited each frame. A phone in
    // portrait shows a ~490px-wide crop of a 1080px-tall frame at 2-3x — the
    // cap draws ~3x fewer pixels for the same picture.
    const sourcePerCss = 1 / Math.max(cssWidth / sourceWidth, cssHeight / sourceHeight);
    const ratio = Math.max(
      1,
      Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO, sourcePerCss),
    );
    const targetWidth = Math.round(cssWidth * ratio);
    const targetHeight = Math.round(cssHeight * ratio);

    // Resizing the canvas clears it, so only touch it on a real size change.
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }

    // Cover fit: fill the box, preserve aspect ratio, centre the overflow.
    const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;

    context.drawImage(
      source,
      (targetWidth - drawWidth) / 2,
      (targetHeight - drawHeight) / 2,
      drawWidth,
      drawHeight,
    );
    // Reads refs only; stable for the life of the hook.
  }, []);

  // Cache the canvas box as it changes instead of forcing a layout read for
  // every frame of a scroll-scrubbed sequence.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const update = () => {
      canvasSizeRef.current = { width: canvas.clientWidth, height: canvas.clientHeight };
      paint();
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update, { passive: true });
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(([entry]) => {
      canvasSizeRef.current = { width: entry.contentRect.width, height: entry.contentRect.height };
      paint();
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [paint]);

  /** Decode frame `index` off the main thread, if it is wanted and not held. */
  const decodeBitmap = useCallback(
    (index: number) => {
      const blob = blobsRef.current[index];
      const bitmaps = bitmapsRef.current;
      const decoding = decodingRef.current;
      if (!blob || bitmaps.has(index) || decoding.has(index)) return;
      decoding.add(index);
      const blobs = blobsRef.current;
      createImageBitmap(blob)
        .then((bitmap) => {
          decoding.delete(index);
          // Released, or the window has moved on while it decoded.
          const distance = Math.abs(index - frameIndexRef.current);
          if (blobsRef.current !== blobs || !nearRef.current || distance > BITMAPS_KEEP) {
            bitmap.close();
            return;
          }
          bitmaps.set(index, bitmap);
          if (index === frameIndexRef.current) paint();
        })
        .catch(() => {
          // A frame that fails to decode is skipped; its neighbour stays up.
          decoding.delete(index);
        });
    },
    [paint],
  );

  /** Hold the window of decoded frames around `center`, in the scroll direction. */
  const holdWindow = useCallback(
    (center: number) => {
      if (!bitmapPathRef.current || !nearRef.current) return;
      const count = blobsRef.current.length;
      const direction = directionRef.current;
      // Nearest first, so the frame on screen next is decoded next.
      for (let step = 0; step <= BITMAPS_AHEAD; step += 1) {
        const ahead = center + direction * step;
        if (ahead >= 0 && ahead < count) decodeBitmap(ahead);
        if (step > 0 && step <= BITMAPS_BEHIND) {
          const behind = center - direction * step;
          if (behind >= 0 && behind < count) decodeBitmap(behind);
        }
      }
      for (const [index, bitmap] of bitmapsRef.current) {
        if (Math.abs(index - center) > BITMAPS_KEEP) {
          bitmap.close();
          bitmapsRef.current.delete(index);
        }
      }
    },
    [decodeBitmap],
  );

  const releaseBitmaps = () => {
    for (const bitmap of bitmapsRef.current.values()) bitmap.close();
    bitmapsRef.current.clear();
  };

  const showFrame = useCallback(
    (index: number) => {
      if (index === frameIndexRef.current) return;
      directionRef.current = index > frameIndexRef.current ? 1 : -1;
      frameIndexRef.current = index;
      holdWindow(index);
      paint();
    },
    [paint, holdWindow],
  );

  // Frames are only fetched once the canvas is near the viewport. Decoded
  // bitmaps are held for the life of the sequence, and at 1920x1080 they are far
  // heavier than the file on disk — so a page holding several sequences must not
  // decode all of them at first paint.
  const [shouldLoad, setShouldLoad] = useState(false);

  // Which set to paint, chosen from the canvas's own box once it is about to
  // load. Only ever widened back to the full frames: a portrait cut painted
  // into a wider canvas would crop the picture, the reverse never does.
  const [portrait, setPortrait] = useState<boolean | null>(null);
  useEffect(() => {
    if (!shouldLoad) return;
    const canvas = canvasRef.current;
    const fits =
      Boolean(portraitFrames?.length) &&
      fitsPortraitFrames(canvas?.clientWidth ?? width, canvas?.clientHeight ?? height);
    setPortrait((current) => (current === null ? fits : current && fits));
  }, [shouldLoad, width, height, portraitFrames]);
  const activeFrames = portrait && portraitFrames ? portraitFrames : frames;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (typeof IntersectionObserver === "undefined") {
      setShouldLoad(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setShouldLoad(true);
        observer.disconnect();
      },
      { rootMargin: PRELOAD_MARGIN },
    );

    // The decoded window lives only while the scene is within a screen of
    // the viewport; a scene scrolled past gives its memory back.
    const near = new IntersectionObserver(
      ([entry]) => {
        nearRef.current = entry.isIntersecting;
        if (entry.isIntersecting) holdWindow(frameIndexRef.current);
        else releaseBitmaps();
      },
      { rootMargin: PRELOAD_MARGIN },
    );

    observer.observe(canvas);
    near.observe(canvas);
    return () => {
      observer.disconnect();
      near.disconnect();
    };
    // Mount-only; the callbacks read refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!shouldLoad || portrait === null) return;
    let cancelled = false;

    if (portrait) {
      // The bitmap path: keep the compressed bytes, decode a window of them.
      bitmapPathRef.current = true;
      const blobs: (Blob | undefined)[] = new Array(activeFrames.length);
      blobsRef.current = blobs;
      issueNearestFirst(activeFrames.length, frameIndexRef.current, (index) => {
        fetch(activeFrames[index])
          .then((response) => (response.ok ? response.blob() : undefined))
          .then((blob) => {
            if (cancelled || !blob) return;
            blobs[index] = blob;
            // Decode it now if it falls inside the current window.
            const offset = (index - frameIndexRef.current) * directionRef.current;
            if (offset >= -BITMAPS_BEHIND && offset <= BITMAPS_AHEAD) decodeBitmap(index);
          })
          .catch(() => {
            // A frame that fails to load is skipped; its neighbour stays up.
          });
      }, () => cancelled);
      return () => {
        cancelled = true;
        blobsRef.current = [];
        bitmapPathRef.current = false;
        releaseBitmaps();
      };
    }

    const images: HTMLImageElement[] = new Array(activeFrames.length);
    imagesRef.current = images;

    // Paint as soon as a frame lands, so the canvas is never blank while the
    // rest of the sequence is still downloading.
    issueNearestFirst(activeFrames.length, frameIndexRef.current, (index) => {
      const image = new Image();
      image.decoding = "async";
      image.src = activeFrames[index];
      images[index] = image;
      image
        .decode()
        .then(() => {
          // A decoded neighbour does not change what is currently visible.
          // Repainting for every loaded image competes with the scroll scrub.
          if (!cancelled && index === frameIndexRef.current) paint();
        })
        .catch(() => {
          // A frame that fails to decode is skipped; its neighbour stays up.
        });
    }, () => cancelled);

    return () => {
      cancelled = true;
      imagesRef.current = [];
    };
  }, [activeFrames, paint, decodeBitmap, shouldLoad, portrait]);

  // Re-fit the canvas after a viewport change.
  useEffect(() => {
    paint();
  }, [width, height, paint]);

  return { canvasRef, showFrame };
}
