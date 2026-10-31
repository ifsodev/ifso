import { InkTransition } from "@/components/common/ink-transition";
import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";

import {
  generateMetadata,
  generateViewport,
} from "@/utils/seo/generate-page-metadata";
import { getSiteStructuredData } from "@/utils/seo/structured-data";

import { CONSENT_FLAG_SCRIPT } from "@/components/common/Cookie/consent-flag";
import { AdaptiveGrid } from "@/components/common/grid";
import { CrtOverlay } from "@/components/common/crt-overlay";
import { ReducedMotion } from "@/components/common/reduced-motion";
import { ScrollLayout } from "@/layouts/scroll-layout";
import { SocialLinks } from "@/components/common/social-links";

import "./globals.css";

/*
 * Onest (variable, 100-900) and Reggae One, self-hosted as Latin subsets
 * (Basic Latin, Latin-1, typographic punctuation, the arrows the copy uses):
 *   pyftsubset <font>.ttf --unicodes="U+0020-007E,U+00A0-00FF,U+0131,U+0152-0153,
 *     U+02C6,U+02DA,U+02DC,U+2013-2014,U+2018-201A,U+201C-201E,U+2022,U+2026,
 *     U+2039-203A,U+20AC,U+2122,U+2190-2193,U+2212" --flavor=woff2 --no-hinting
 *     --desubroutinize --layout-features=kern,liga,calt,ccmp,locl,mark,mkmk
 * From Google, Reggae One carried ~120 CJK unicode-range @font-face rules in a
 * render-blocking stylesheet for a face only ever set in Latin, and Onest
 * fetched a second 18 KB file for the → and ↑ in the footer. Now one file
 * each: Onest 51 → 29 KB, Reggae One 20 → 10 KB, CSS ~30 KB lighter.
 */
const onest = localFont({
  src: "../../fonts/onest-latin.woff2",
  variable: "--font-onest",
  weight: "100 900",
  display: "swap",
});

const reggae = localFont({
  src: "../../fonts/reggae-one-latin.woff2",
  variable: "--font-reggae",
  weight: "400",
  display: "swap",
});

// Kanji and kana only (the 層 mark, chapter marks, the nav's Japanese twins).
// Noto Serif JP 700, subset to exactly the glyphs the copy uses (~13 KB). The
// Google build is split into ~120 unicode-range slices, and their @font-face
// rules alone made two render-blocking stylesheets of ~100 KB each — on a
// phone, more than the page's whole first screen. A glyph added to the copy
// later falls back to the system serif until the subset is rebuilt:
//   fonttools varLib.instancer NotoSerifJP[wght].ttf wght=700
//   pyftsubset … --text="<every CJK glyph in src/data>" --unicodes=U+0020 --flavor=woff2
const notoSerifJp = localFont({
  src: "../../fonts/noto-serif-jp-kanji-700.woff2",
  variable: "--font-noto-serif-jp",
  weight: "700",
  display: "swap",
  preload: false,
});

export const metadata: Metadata = generateMetadata();
export const viewport: Viewport = generateViewport();

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // `data-consent` is set on <html> by CONSENT_FLAG_SCRIPT before hydration.
    <html suppressHydrationWarning lang="en">
      <body
        className={`${onest.variable} ${reggae.variable} ${notoSerifJp.variable}`}
      >
        {/* Before anything is parsed: marks a returning visitor's choice so the
            server-rendered consent banner is hidden before its first paint. */}
        <script dangerouslySetInnerHTML={{ __html: CONSENT_FLAG_SCRIPT }} />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(getSiteStructuredData()),
          }}
        />
        <ScrollLayout>
          {/* coef 1: above 1440 the layout scales 1:1 with the viewport, so wide
              screens show exactly the 1440 Figma layout, only larger. */}
          <AdaptiveGrid coef={1} />
          <ReducedMotion />
          {children}
          <CrtOverlay />
          <SocialLinks />
          <InkTransition />
        </ScrollLayout>
      </body>
    </html>
  );
}
