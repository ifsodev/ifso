"use client";

/**
 * `true` once the page has loaded and the main thread has had an idle moment.
 *
 * For media that is in the markup from the start but not on the first screen
 * — the cloud cut-outs sit translated off-screen until a transition many
 * screens down. Served as `<img>` in the HTML, the browser fetched them
 * during the parse, ahead of first paint, and on a phone every byte before
 * first paint is billed to it. Mounting them here keeps them warm long before
 * anyone scrolls to them, without competing with the first screen.
 */

import { useEffect, useState } from "react";

/** Longest wait for an idle moment once loaded, in ms. */
const IDLE_TIMEOUT_MS = 1500;

let loaded = false;

export const useAfterLoad = (): boolean => {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (loaded) {
      setReady(true);
      return;
    }
    let idle = 0;
    let timer = 0;
    const settle = () => {
      const done = () => {
        loaded = true;
        setReady(true);
      };
      if (typeof window.requestIdleCallback === "function") {
        idle = window.requestIdleCallback(done, { timeout: IDLE_TIMEOUT_MS });
      } else {
        timer = setTimeout(done, 0) as unknown as number;
      }
    };
    if (document.readyState === "complete") settle();
    else window.addEventListener("load", settle, { once: true });
    return () => {
      window.removeEventListener("load", settle);
      if (idle) window.cancelIdleCallback(idle);
      if (timer) clearTimeout(timer);
    };
  }, []);

  return ready;
};
