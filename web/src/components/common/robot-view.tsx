"use client";

import { Globals } from "@react-spring/web";
import { createContext, useContext, useLayoutEffect } from "react";

/**
 * The robot form of the page (D-016): every spring and text-engine animation
 * jumps to its end state, and `useRobot()` lets the first screen render at
 * rest in the served HTML (see `robot-spring.tsx`).
 *
 * `skipAnimation` is set at module evaluation — before anything on the page
 * mounts — and again in a layout effect, because the root `ReducedMotion`
 * re-assigns it from the OS setting when it mounts.
 */
/**
 * The robot form is marked by the server: `<RobotView>` renders
 * `<meta name="x-robot-view">`, so the check below reads what the server sent
 * rather than the URL — the proxy *rewrites*, so the address bar still says
 * `/` (a pathname check never fired on cortex, 2026-09-29). People's pages
 * never carry the tag, so nothing here can touch them.
 */
export const isRobotView = (): boolean =>
  typeof document !== "undefined" &&
  document.querySelector('meta[name="x-robot-view"]') !== null;

if (isRobotView()) {
  window.__robotView = true;
  Globals.assign({ skipAnimation: true });
}

const RobotContext = createContext(false);

export const useRobot = (): boolean => useContext(RobotContext);

export const RobotProvider = ({
  robot,
  children,
}: {
  robot: boolean;
  children: React.ReactNode;
}) => <RobotContext.Provider value={robot}>{children}</RobotContext.Provider>;

export const RobotView = () => {
  useLayoutEffect(() => {
    window.__robotView = true;
    Globals.assign({ skipAnimation: true });
  }, []);
  return <meta name="x-robot-view" content="1" />;
};
