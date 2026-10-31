/**
 * Site-wide configuration — the single source of truth for SEO.
 *
 * Consumed by the metadata generator, `robots.ts`, `sitemap.ts`, and the
 * JSON-LD structured-data helper. Update the placeholder values per project.
 */
import { getServerEnv, publicEnv } from "@/env";

/**
 * Vercel's production domain, read at build time — the fallback when a deploy
 * doesn't set `NEXT_PUBLIC_SITE_URL` (none did: the live canonical said
 * localhost). Server-only: every consumer of `siteConfig` renders on the server.
 */
const vercelProduction = getServerEnv().VERCEL_PROJECT_PRODUCTION_URL;

export const siteConfig = {
  name: "IFSO",
  /** Default page title — the name plus what the studio is. */
  title: "IFSO — Money that moves when something happens",
  description:
    "Send USDG with a condition. When it happens, the money moves.",
  /**
   * Public origin, no trailing slash. Drives canonical URLs, OG tags, the
   * sitemap, and JSON-LD. Set `NEXT_PUBLIC_SITE_URL` in production.
   */
  url:
    publicEnv.NEXT_PUBLIC_SITE_URL ??
    (vercelProduction ? `https://${vercelProduction}` : "http://localhost:3000"),
  /** Default Open Graph / Twitter share image (path under `public/`), 1200×630. */
  ogImage: "/assets/ifso/banner.png",
  ogImageAlt:
    "IFSO — Money that moves when something happens.",
  /** X/Twitter handle, e.g. "@layers". Omitted from the tags while unknown. */
  twitterHandle: undefined as string | undefined,
  author: "IFSO",
  email: "",
  /** Browser theme-color (address bar / PWA) — the site's paper. */
  themeColor: "#f4ece0",
} as const;
