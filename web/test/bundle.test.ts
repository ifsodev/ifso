import { describe, expect, test } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Needs a production build (`bun run build`); CI builds first. Skipped when there is no .next folder.
const next = join(__dirname, "../.next");
const manifests = { "/c/[id]": "server/app/(secret)/c/[id]/page_client-reference-manifest.js", "/link": "server/app/(secret)/link/page_client-reference-manifest.js" };
const built = existsSync(join(next, manifests["/c/[id]"]));

const FORBIDDEN = [/walletconnect\.(com|org)/i, /@walletconnect/i, /reown/i, /appkit/i, /UniversalProvider/, /googletagmanager|google-analytics|gtag\(/i, /fonts\.(googleapis|gstatic)\.com/i, /plausible|segment\.(io|com)|mixpanel|hotjar|sentry\.io|posthog/i, /_vercel\/(insights|speed-insights)/];

function chunksOf(manifest: string): string[] {
  const text = readFileSync(join(next, manifest), "utf8");
  return [...new Set([...text.matchAll(/\/_next\/static\/[^"\\]+\.js/g)].map((m) => m[0]))].map((c) => join(next, c.replace("/_next/", "")));
}

describe.skipIf(!built)("secret routes ship no third-party code", () => {
  for (const [route, manifest] of Object.entries(manifests)) {
    test(`${route}: no AppKit, WalletConnect, analytics or remote font code in its JavaScript`, () => {
      const files = chunksOf(manifest);
      expect(files.length).toBeGreaterThan(3);
      for (const f of files) {
        const code = readFileSync(f, "utf8");
        for (const re of FORBIDDEN) expect(re.test(code), `${f.split("/").pop()} matches ${re}`).toBe(false);
      }
    });
  }
  test("the AppKit code exists in the build (so the checks above can fail) and is not in either secret route", () => {
    const dir = join(next, "static/chunks");
    const withAppKit = readdirSync(dir).filter((n) => n.endsWith(".js") && /@reown|appkit/i.test(readFileSync(join(dir, n), "utf8")));
    expect(withAppKit.length).toBeGreaterThan(0);
    for (const manifest of Object.values(manifests)) {
      const used = chunksOf(manifest).map((f) => f.split("/").pop()!);
      for (const n of withAppKit) expect(used).not.toContain(n);
    }
  });
});
