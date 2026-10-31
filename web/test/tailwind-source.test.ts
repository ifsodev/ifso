import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The site stylesheet lives in src/app/(site)/. Tailwind only generates classes it finds under source(),
// so it must point at src/ or every class used in src/views and src/components is dropped.
describe("tailwind source", () => {
  it("scans all of src/", () => {
    const css = resolve(__dirname, "../src/app/(site)/globals.css");
    const rel = /@import "tailwindcss" source\("([^"]+)"\)/.exec(readFileSync(css, "utf8"))?.[1];
    expect(rel).toBeDefined();
    expect(resolve(dirname(css), rel!)).toBe(resolve(__dirname, "../src"));
  });
});
