// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { sportsEnabledFrom } from "@/lib/ifso/features";
import { loadConfig } from "@/lib/ifso/config";
import { ALL_KINDS, offeredKinds } from "@/lib/ifso/text";

// Football is off at launch (DECISIONS row 44): the API refuses sports conditions without ODDS_API_KEY,
// so the site offers the match condition only when NEXT_PUBLIC_SPORTS_ENABLED=1.

describe("NEXT_PUBLIC_SPORTS_ENABLED", () => {
  test("only the exact value 1 turns sports on", () => {
    for (const v of [undefined, "", "0", "true", "yes", "on", "11"]) expect(sportsEnabledFrom({ NEXT_PUBLIC_SPORTS_ENABLED: v }), String(v)).toBe(false);
    expect(sportsEnabledFrom({ NEXT_PUBLIC_SPORTS_ENABLED: "1" })).toBe(true);
    expect(sportsEnabledFrom({ NEXT_PUBLIC_SPORTS_ENABLED: " 1 " })).toBe(true);
  });
  test("the site config carries it, default off", () => {
    expect(loadConfig({}).sportsEnabled).toBe(false);
    expect(loadConfig({ NEXT_PUBLIC_SPORTS_ENABLED: "1" }).sportsEnabled).toBe(true);
  });
  test("composer kinds: no match when off, all six exactly as before when on", () => {
    expect(offeredKinds(false).map(([v]) => v)).toEqual(["date", "price", "approval", "referee", "market"]);
    expect(offeredKinds(true)).toEqual(ALL_KINDS);
    expect(offeredKinds(true)).toContainEqual(["match", "A match ends", "arsenal win"]);
  });
});

for (const state of ["off", "on"] as const) {
  describe(`pages with sports ${state}`, () => {
    const on = state === "on";
    beforeEach(() => {
      vi.resetModules();
      if (on) vi.stubEnv("NEXT_PUBLIC_SPORTS_ENABLED", "1");
      else vi.stubEnv("NEXT_PUBLIC_SPORTS_ENABLED", "");
      vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
      vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
    });
    afterEach(() => {
      cleanup();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    test("config and composer kinds", async () => {
      const { config } = await import("@/lib/ifso/config");
      const { KINDS } = await import("@/lib/ifso/text");
      expect(config.sportsEnabled).toBe(on);
      expect(KINDS.some(([v]) => v === "match")).toBe(on);
      expect(KINDS).toHaveLength(on ? 6 : 5);
    });

    test("home condition films", async () => {
      const { worksContent } = await import("@/data/home/story");
      const films = worksContent.films;
      expect(films.some((f) => f.href === "/conditions#match")).toBe(on);
      expect(films.map((f) => f.year)).toEqual(on ? ["01", "02", "03", "04", "05", "06"] : ["01", "02", "03", "04", "05"]);
      expect(films.at(-1)?.title).toBe("A question resolves");
    });

    test("conditions page", async () => {
      const { FoldersView } = await import("@/views/ifso/folders");
      render(<FoldersView />);
      expect(screen.queryByText("Match result") !== null).toBe(on);
      expect(screen.queryByText(/Arsenal/) !== null).toBe(on);
      expect(screen.getByText(on ? "Six ways to give a payment a reason to move." : "Five ways to give a payment a reason to move.")).toBeTruthy();
      expect(screen.getByText(on ? "IFSO / FIELD NOTES / 01—06" : "IFSO / FIELD NOTES / 01—05")).toBeTruthy();
      expect(screen.getByText("Market question")).toBeTruthy();
    });
  });
}
