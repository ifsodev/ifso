"use client";

import { animated, easings, useSpring } from "@react-spring/web";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import "./ink-transition.css";

const pause = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** Wait for the route and its own asset gate, leaving failure controls accessible. */
async function waitForDestination(pathname: string, alive: () => boolean) {
  const deadline = Date.now() + 20000;
  while (alive() && location.pathname !== pathname && Date.now() < deadline) await pause(50);
  if (!alive() || location.pathname !== pathname) return;
  // Let React commit the destination and mount its loading gate.
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  // Home has its own animated loading screen. Let it be seen rather than
  // holding the ink cover over the entire introduction.
  if (pathname === "/") return;
  while (alive() && Date.now() < deadline) {
    const loader = document.querySelector(".ed-loading, .intro-screen");
    // If an asset fails, reveal the page's retry button instead of trapping the visitor.
    if (!loader || loader.querySelector("button")) break;
    await pause(60);
  }
  if (!alive()) return;
  const images = [...document.images].filter((image) => {
    const rect = image.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
  });
  await Promise.race([
    Promise.all([document.fonts.ready, ...images.map((image) => image.decode().catch(() => undefined))]),
    pause(Math.max(0, deadline - Date.now())),
  ]);
}

export function InkTransition() {
  const router = useRouter();
  const busy = useRef(false);
  const [active, setActive] = useState(false);
  const [motion, api] = useSpring(() => ({ opacity: 0, progress: 0 }));

  useEffect(() => {
    let live = true;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest("a[href]");
      if (!(link instanceof HTMLAnchorElement) || link.target || link.hasAttribute("download")) return;
      const destination = new URL(link.href, location.href);
      if (destination.origin !== location.origin || destination.pathname === location.pathname || destination.pathname === "/") return;
      event.preventDefault();
      event.stopPropagation();
      if (busy.current) return;
      busy.current = true;
      setActive(true);
      router.prefetch(destination.pathname + destination.search);
      api.set({ opacity: 1, progress: 0 });
      void (async () => {
        await Promise.all(api.start({ progress: 1, config: { duration: 1950, easing: easings.easeInOutCubic } }));
        if (!live) return;
        router.push(destination.pathname + destination.search + destination.hash);
        await waitForDestination(destination.pathname, () => live);
        if (!live) return;
        await pause(140);
        await Promise.all(api.start({ opacity: 0, config: { duration: 560, easing: easings.easeInOutCubic } }));
        if (!live) return;
        busy.current = false;
        setActive(false);
      })();
    };
    document.addEventListener("click", onClick, true);
    return () => { live = false; document.removeEventListener("click", onClick, true); api.stop(); };
  }, [api, router]);

  return <animated.div className={`ink-transition${active ? " is-active" : ""}`} aria-hidden="true" style={{ opacity: motion.opacity }}>
    <animated.div className="ink-paper" style={{ opacity: motion.progress.to(value => Math.min(1, value / .16)) }} />
    <svg className="ink-emblem" viewBox="0 0 320 320" aria-hidden="true">
      <animated.g className="ink-drawing" opacity={motion.progress.to(value => 1 - Math.max(0, Math.min(1, (value - .83) / .14)))}>
        <animated.path className="ink-frame" d="M57 65 C55 96 55 216 58 257 C95 262 224 262 263 257 C266 219 264 103 261 62 C215 59 105 60 57 65" pathLength="100" strokeDasharray="100 100" strokeDashoffset={motion.progress.to(value => 100 * (1 - Math.max(0, Math.min(1, (value - .1) / .34))))} />
        <animated.path className="ink-letter ink-letter-i" d="M97 104 C114 103 129 103 138 102 M117 104 C115 126 113 145 111 158 M94 159 C110 157 124 158 135 158" pathLength="100" strokeDasharray="100 100" strokeDashoffset={motion.progress.to(value => 100 * (1 - Math.max(0, Math.min(1, (value - .25) / .23))))} />
        <animated.path className="ink-letter" d="M176 157 C177 137 179 119 182 104 C198 102 214 102 230 104 M181 130 C195 129 206 128 220 129" pathLength="100" strokeDasharray="100 100" strokeDashoffset={motion.progress.to(value => 100 * (1 - Math.max(0, Math.min(1, (value - .39) / .22))))} />
        <animated.path className="ink-letter" d="M137 183 C124 175 104 176 96 185 C85 198 105 206 117 210 C132 215 140 223 130 234 C120 245 101 242 88 236" pathLength="100" strokeDasharray="100 100" strokeDashoffset={motion.progress.to(value => 100 * (1 - Math.max(0, Math.min(1, (value - .54) / .21))))} />
        <animated.path className="ink-letter" d="M202 177 C182 176 170 191 170 208 C169 226 180 242 199 243 C218 243 230 228 231 209 C232 192 221 177 202 177 Z" pathLength="100" strokeDasharray="100 100" strokeDashoffset={motion.progress.to(value => 100 * (1 - Math.max(0, Math.min(1, (value - .67) / .2))))} />
      </animated.g>
      <animated.image href="/ifso-seal-transparent.png" x="-30" y="-30" width="380" height="380" opacity={motion.progress.to(value => Math.max(0, Math.min(1, (value - .83) / .14)))} />
    </svg>
  </animated.div>;
}
