/**
 * Feature switches, read once from NEXT_PUBLIC_* (inlined at build time) and exposed through the site config
 * (`config.sportsEnabled`). No imports, so the home page can read them without pulling in the chain config.
 */
export interface FeatureEnv {
  /** "1" offers the match-result condition. Anything else (or unset) hides it: the API refuses sports without ODDS_API_KEY. */
  NEXT_PUBLIC_SPORTS_ENABLED?: string;
}

export const sportsEnabledFrom = (env: FeatureEnv): boolean => env.NEXT_PUBLIC_SPORTS_ENABLED?.trim() === "1";

// Next inlines NEXT_PUBLIC_* only for literal `process.env.NAME` reads; this is the only read of this one.
export const FEATURE_ENV: FeatureEnv = { NEXT_PUBLIC_SPORTS_ENABLED: process.env.NEXT_PUBLIC_SPORTS_ENABLED };
export const SPORTS_ENABLED = sportsEnabledFrom(FEATURE_ENV);

/** Condition ids that need a sports result source. */
export const SPORTS_IDS: ReadonlySet<string> = new Set(["match"]);

/** The items the site offers: sports conditions only when sports are on. */
export const offered = <T,>(items: readonly T[], id: (item: T) => string, sportsEnabled: boolean = SPORTS_ENABLED): T[] =>
  items.filter((item) => sportsEnabled || !SPORTS_IDS.has(id(item)));
