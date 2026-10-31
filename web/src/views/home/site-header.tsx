"use client";

/**
 * @fileoverview Site header — fixed over every block, laid out on the grid of
 * the Figma concept. Desktop and landscape max-tablet: the 層 mark, three nav
 * columns, the scene clock (desktop only) and the project CTA. Portrait
 * max-tablet: the mark with the wordmark, a "Menu" button and a hairline; the
 * links move into a full-screen menu.
 *
 * Its ink follows the block underneath (`light` in the home store, 0-1): dark
 * over bright sky, clouds and paper, light over the darker shots. Scenes ramp
 * it with scroll, so ink and scrim crossfade instead of flipping at a cut. It
 * is written straight to the `--light` custom property — it changes on every
 * scroll tick and needs no render. Each end brings its own top scrim so the
 * nav always reads. The whole header springs in once the preloader is done.
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { animated, useSpring } from "@react-spring/web";
import { LayersLogo } from "@/components/common/layers-logo";
import type { HeaderContent } from "@/data/home/intro";
import { MistedLines } from "@/components/animation/misted-lines";
import { useRobot } from "@/components/common/robot-view";
import { useIntro } from "@/views/home/intro-store";
import { KanjiFlip } from "@/views/home/kanji-flip";
import { LiveClock } from "@/views/home/live-clock";
import { LiveDot } from "@/views/home/live-dot";
import { SiteMenu } from "@/views/home/site-menu";

export interface SiteHeaderProps {
  content: HeaderContent;
}

export const SiteHeader = ({ content }: SiteHeaderProps) => {
  const phase = useIntro((state) => state.phase);
  const [menuOpen, setMenuOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  // The robot form serves the header at rest (D-016).
  const robot = useRobot();
  const [{ shown }, api] = useSpring(() => ({ shown: robot ? 1 : 0 }));

  useEffect(() => {
    if (phase === "loading") return;
    api.start({ shown: 1, config: { tension: 60, friction: 22 } });
  }, [phase, api]);

  // The open menu is paper, so the header reads in ink over it.
  useEffect(() => {
    const write = (light: number) =>
      headerRef.current?.style.setProperty("--light", String(menuOpen ? 0 : light));
    write(useIntro.getState().light);
    return useIntro.subscribe((state) => write(state.light));
  }, [menuOpen]);

  return (
    <>
      <SiteMenu content={content} open={menuOpen} onClose={closeMenu} opener={menuButtonRef} />
      <animated.header
        ref={headerRef}
        className="header-ink fixed inset-x-0 top-0 z-[var(--layer-header)] h-40 max-portrait:h-26"
        // The open menu carries its own top row, so the header steps aside.
        style={{
          opacity: shown.to((value) => (menuOpen ? 0 : value)),
          pointerEvents: phase === "done" && !menuOpen ? "auto" : "none",
        }}
      >
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-x-0 top-0 h-75 bg-linear-to-b from-paper/90 via-paper/50 to-paper/0 opacity-[calc(1-var(--light,0))] max-tablet:h-72 max-portrait:h-96 max-mobile:h-79.25 ${
            menuOpen ? "invisible" : ""
          }`}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-75 bg-linear-to-b from-ink/85 via-ink/47 to-ink/0 opacity-[var(--light,0)] max-tablet:h-72 max-portrait:hidden"
        />

        <Link href="/" aria-label="IFSO — home" className="absolute top-6 left-12 max-tablet:left-8 max-portrait:hidden">
          <LayersLogo />
        </Link>
        <Link
          href="/"
          aria-label="IFSO — home"
          className="absolute top-6 left-8 hidden items-center gap-6 max-portrait:flex max-mobile:left-5 max-mobile:gap-4"
        >
          <LayersLogo />
          <span className="font-mono text-tag tracking-slate uppercase">{content.brandName}</span>
        </Link>

        <nav aria-label="Primary" className="absolute top-6 left-97.5 max-tablet:left-69.5 max-portrait:hidden">
          <ul className="flex items-start gap-16 font-sans text-nav max-tablet:gap-6">
            {content.navColumns.map((column) => (
              <li key={column[0].label} className="w-22.5 max-tablet:w-35">
                <ul className="flex flex-col gap-1">
                  <MistedLines
                    as="li"
                    lines={column.map((link) => ({
                      key: link.label,
                      content: (
                        <Link href={link.href} className="group/flip">
                          <KanjiFlip label={link.label} jp={link.jp} />
                        </Link>
                      ),
                    }))}
                  />
                </ul>
              </li>
            ))}
          </ul>
        </nav>

        <div className="absolute top-6 left-240 flex w-32.75 flex-col gap-2 font-mono text-meta tracking-slate max-tablet:hidden">
          <LiveClock
            initial={content.sceneTime}
            className="flex h-6.5 w-fit items-center rounded-sm border border-current px-2.5"
          />
          <p className="flex flex-col gap-0.5 uppercase">
            <span>{content.scenePlace}</span>
            <span>{content.sceneShot}</span>
          </p>
        </div>

        <Link
          href={content.cta.href}
          className="group/flip absolute top-6 right-12 flex items-center gap-3 font-sans text-nav max-tablet:right-8 max-portrait:hidden"
        >
          <MistedLines
            lines={[{ key: "cta", content: <KanjiFlip label={content.cta.label} jp={content.cta.jp} /> }]}
          />
          <LiveDot />
        </Link>

        <button
          type="button"
          ref={menuButtonRef}
          aria-expanded={menuOpen}
          aria-controls="site-menu"
          onClick={() => setMenuOpen((open) => !open)}
          className="absolute top-8 right-8 hidden font-mono text-tag tracking-slate uppercase max-portrait:block max-mobile:right-5"
        >
          {content.menuOpen}
        </button>
        <div aria-hidden="true" className="absolute inset-x-8 top-20 hidden h-px bg-current opacity-40 max-portrait:block max-mobile:inset-x-5" />
      </animated.header>
    </>
  );
};
