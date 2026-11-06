// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SOCIAL_LINKS } from "@/lib/social";
import { SocialIconLinks, SocialLinks } from "@/components/common/social-links";
import { findBannedWords } from "@/vendor/ifso/client";

const EXPECTED = {
  "IFSO on Telegram": "https://t.me/IFSOonhood",
  "IFSO on X": "https://x.com/IfSoFinance",
  "IFSO code on GitHub": "https://github.com/ifsodev/ifso",
};

afterEach(cleanup);

describe("social links", () => {
  test("the config holds exactly the three channels", () => {
    expect(Object.fromEntries(SOCIAL_LINKS.map((l) => [l.label, l.href]))).toEqual(EXPECTED);
  });

  for (const [name, Component] of [["floating icons", SocialLinks], ["footer row", SocialIconLinks]] as const) {
    test(`${name}: three outbound links with labels`, () => {
      render(<Component />);
      const links = screen.getAllByRole("link");
      expect(links).toHaveLength(3);
      for (const [label, href] of Object.entries(EXPECTED)) {
        const a = screen.getByRole("link", { name: label });
        expect(a.getAttribute("href")).toBe(href);
        expect(a.getAttribute("target")).toBe("_blank");
        expect(a.getAttribute("rel")).toBe("noopener noreferrer");
        expect(a.querySelector("svg")).not.toBeNull();
      }
    });
  }

  test("labels follow the copy rules", () => {
    expect(SOCIAL_LINKS.flatMap((l) => [...findBannedWords(l.label), ...findBannedWords(l.name)])).toEqual([]);
  });
});
