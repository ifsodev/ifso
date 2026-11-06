"use client";

/**
 * @fileoverview Burger menu for portrait tablets and phones — a frosted glass
 * sheet over the page (768 and 390 frames of the concept): its own top row
 * with the mark and a close button, the nav in labelled groups set large, and
 * the studio email, socials and project CTA at the foot.
 *
 * The sheet springs in; page scroll is held while it is open. Escape, a click
 * outside the sheet and any link close it. Focus moves to the close button on
 * open and back to the opener on close.
 */

import Link from "next/link";
import { LayersLogo } from "@/components/common/layers-logo";
import { SocialIconLinks } from "@/components/common/social-links";
import { useEffect, useRef, type RefObject } from "react";
import { animated, useSpring } from "@react-spring/web";
import { MistedLines } from "@/components/animation/misted-lines";
import { WrittenLines } from "@/components/animation/written-lines";
import { useScroll } from "@/hooks/smooth-scroll/use-scroll";
import type { HeaderContent } from "@/data/home/intro";

export interface SiteMenuProps {
  content: HeaderContent;
  open: boolean;
  onClose: () => void;
  /** The button that opened the menu — focus returns to it on close. */
  opener: RefObject<HTMLButtonElement | null>;
}

/** Menu text writes in group by group, link by link, then the foot. */
const GROUP_STAGGER_MS = 260;
const LINK_STAGGER_MS = 120;
const FOOT_DELAY_MS = 700;

const HOVER =
  "transition-colors duration-[var(--duration-hover)] ease-entrance hover:text-ember focus-visible:text-ember";

export const SiteMenu = ({ content, open, onClose, opener }: SiteMenuProps) => {
  const closeRef = useRef<HTMLButtonElement>(null);
  const { reveal } = useSpring({
    reveal: open ? 1 : 0,
    config: { tension: 260, friction: 30 },
  });

  useEffect(() => {
    if (!open) return;
    const { stop, start } = useScroll.getState();
    const openerButton = opener.current;
    stop();
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      start();
      openerButton?.focus();
    };
  }, [open, onClose, opener]);

  const tab = open ? 0 : -1;

  return (
    <animated.div
      className="fixed inset-0 z-[var(--layer-header)] hidden max-portrait:block"
      style={{ visibility: reveal.to((r) => (r > 0.01 ? "visible" : "hidden")) }}
      onClick={onClose}
    >
      <animated.div
        id="site-menu"
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        aria-hidden={!open}
        onClick={(event) => event.stopPropagation()}
        className="absolute inset-8 flex flex-col overflow-y-auto rounded-4xl border border-glass-edge bg-paper/72 px-8 pt-7 pb-8 text-ink shadow-sheet backdrop-blur-lg max-mobile:inset-5 max-mobile:rounded-3xl max-mobile:px-6 max-mobile:pt-5 max-mobile:pb-6"
        style={{
          opacity: reveal,
          transform: reveal.to(
            (r) => `translate3d(0, ${(1 - r) * -1.5}rem, 0) scale(${0.98 + r * 0.02})`,
          ),
        }}
      >
        <div className="flex h-9 items-center justify-between max-mobile:h-8">
          <Link
            href="/"
            onClick={onClose}
            tabIndex={tab}
            aria-label="IFSO — home"
            className="flex items-center gap-4 max-mobile:gap-3.5"
          >
            <LayersLogo />
            <span className="font-mono text-tag tracking-slate uppercase">
              {content.brandName}
            </span>
          </Link>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            tabIndex={tab}
            className={`font-mono text-tag tracking-slate uppercase ${HOVER}`}
          >
            {content.menuClose}
          </button>
        </div>

        <nav aria-label="Menu" className="mt-8 border-t border-ink/20 max-mobile:mt-7">
          {content.navColumns.map((column, index) => (
            <div
              key={content.menuGroups[index]}
              className="grid grid-cols-[11.25rem_1fr_auto] items-start border-b border-ink/12 py-8 last:border-b-0 max-mobile:grid-cols-[1fr_auto] max-mobile:gap-y-2 max-mobile:py-6"
            >
              <p className="mt-4 font-mono text-meta tracking-slate text-accent uppercase max-mobile:mt-0">
                <MistedLines
                  delay={index * GROUP_STAGGER_MS}
                  lines={[{ key: content.menuGroups[index], content: content.menuGroups[index] }]}
                />
              </p>
              <ul className="font-display text-menu max-mobile:col-span-2 max-mobile:row-start-2">
                {column.map((link, linkIndex) => (
                  <li key={link.label}>
                    <Link href={link.href} onClick={onClose} tabIndex={tab} className={HOVER}>
                      <WrittenLines
                        lines={[link.label]}
                        delay={index * GROUP_STAGGER_MS + linkIndex * LINK_STAGGER_MS}
                      />
                    </Link>
                  </li>
                ))}
              </ul>
              <p
                aria-hidden="true"
                className="mt-4 font-mono text-meta text-accent max-mobile:col-start-2 max-mobile:row-start-1 max-mobile:mt-0"
              >
                <MistedLines
                  delay={index * GROUP_STAGGER_MS}
                  lines={[{ key: "count", content: String(column.length).padStart(2, "0") }]}
                />
              </p>
            </div>
          ))}
        </nav>

        <div className="mt-auto flex flex-col">

          <p className="mt-4 font-mono text-meta text-ink/60 max-mobile:mt-0">
            <MistedLines delay={FOOT_DELAY_MS} lines={[{ key: "socials", content: content.socials }]} />
          </p>
          <SocialIconLinks className="mt-3" tabIndex={tab} />
          <Link
            href={content.cta.href}
            onClick={onClose}
            tabIndex={tab}
            className="mt-6 flex h-16 items-center justify-center rounded-full bg-ember font-sans text-nav font-medium text-paper max-mobile:h-14 max-mobile:text-body"
          >
            <MistedLines delay={FOOT_DELAY_MS} lines={[{ key: "cta", content: `${content.cta.label} →` }]} />
          </Link>
        </div>
      </animated.div>
    </animated.div>
  );
};
