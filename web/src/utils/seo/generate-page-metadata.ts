/**
 * @fileoverview Standardised metadata + viewport generators for pages.
 *
 * `generateMetadata` builds a Next.js `Metadata` object — basic meta tags,
 * OpenGraph, Twitter cards, canonical URL, icons, robots. `metadataBase` is
 * always set (from `siteConfig`) so relative URLs (OG image, canonical)
 * resolve to absolute — required by social scrapers.
 *
 * `generateViewport` builds the `Viewport` export. `themeColor` lives here, not
 * in `Metadata` — Next deprecated it on the metadata object.
 */

import { Metadata, Viewport } from "next";

import { siteConfig } from "@/lib/site";

interface MetadataProps {
  title?: string;
  description?: string;
  /** Canonical path (e.g. `/about`) or absolute URL for this page. */
  url?: string;
  /** Open Graph / Twitter image — path under `public/` or absolute URL. */
  ogImage?: string;
  ogImageAlt?: string;
  twitterHandle?: string;
  author?: string;
  siteName?: string;
}

export function generateMetadata({
  title = siteConfig.title,
  description = siteConfig.description,
  url = "/",
  ogImage = siteConfig.ogImage,
  ogImageAlt = siteConfig.ogImageAlt,
  twitterHandle = siteConfig.twitterHandle,
  author = siteConfig.author,
  siteName = siteConfig.name,
}: MetadataProps = {}): Metadata {
  return {
    // Resolves every relative URL below to an absolute one.
    metadataBase: new URL(siteConfig.url),
    applicationName: siteName,
    title,
    description,
    keywords: [
      "animation studio",
      "2D animation",
      "hand-painted animation",
      "animated short film",
      "music video animation",
      "brand film",
    ],
    authors: [{ name: author }],
    creator: author,
    publisher: author,
    alternates: {
      canonical: url,
    },
    openGraph: {
      title,
      description,
      url,
      siteName,
      // Dimensions must match the real asset; 1200×630 is the ideal size.
      images: [{ url: ogImage, width: 1200, height: 630, alt: ogImageAlt }],
      locale: "en_US",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      ...(twitterHandle && { site: twitterHandle, creator: twitterHandle }),
      images: [{ url: ogImage, alt: ogImageAlt }],
    },
    icons: {
      icon: [{ url: "/ifso-seal-transparent.png", type: "image/png" }],
      shortcut: "/ifso-seal-transparent.png",
      apple: [{ url: "/ifso-seal-transparent.png", type: "image/png" }],
    },
    manifest: "/manifest.json",
    other: {
      "msapplication-TileColor": siteConfig.themeColor,
      "msapplication-config": "/browserconfig.xml",
    },
    robots: {
      index: true,
      follow: true,
    },
  };
}

export function generateViewport(): Viewport {
  return {
    themeColor: siteConfig.themeColor,
    width: "device-width",
    initialScale: 1,
  };
}
