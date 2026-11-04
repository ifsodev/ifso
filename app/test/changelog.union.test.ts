// Each queued update adds its own "## [update-NN] title" entry at the top of CHANGELOG.md. The repo-root
// .gitattributes marks CHANGELOG.md merge=union, so when main moved (a held update, an owner fix), the release
// runner's `git cherry-pick -x` still applies the next update: both top entries are kept instead of conflicting.
// Scratch repos in a temp dir; the attribute line is read from the real .gitattributes.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const attrs = existsSync(join(ROOT, ".gitattributes")) ? readFileSync(join(ROOT, ".gitattributes"), "utf8") : "";

function git(dir: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

/** main and a queued branch both add a different top entry; cherry-pick the queued one onto main. */
function scenario(attributes: string) {
  const dir = mkdtempSync(join(tmpdir(), "ifso-changelog-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    if (attributes) writeFileSync(join(dir, ".gitattributes"), attributes);
    const base = "# Changelog\n\n## [Unreleased]\n- older entry\n";
    writeFileSync(join(dir, "CHANGELOG.md"), base);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    git(dir, "checkout", "-q", "-b", "queued");
    writeFileSync(join(dir, "CHANGELOG.md"), base.replace("## [Unreleased]", "## [update-02] second\n- b\n\n## [Unreleased]"));
    git(dir, "commit", "-q", "-am", "update-02");
    git(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "CHANGELOG.md"), base.replace("## [Unreleased]", "## [update-01] first\n- a\n\n## [Unreleased]"));
    git(dir, "commit", "-q", "-am", "update-01 (main moved)");
    const pick = git(dir, "cherry-pick", "-x", "queued");
    return { code: pick.code, text: readFileSync(join(dir, "CHANGELOG.md"), "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("CHANGELOG.md merges by union", () => {
  test("the repo-root .gitattributes sets CHANGELOG.md merge=union", () => {
    expect(attrs.split("\n").map((l) => l.trim())).toContain("CHANGELOG.md merge=union");
  });
  test("with the attribute, two different top entries cherry-pick cleanly and both are kept", () => {
    const r = scenario(attrs);
    expect(r.code).toBe(0);
    expect(r.text).toContain("## [update-01] first");
    expect(r.text).toContain("## [update-02] second");
    expect(r.text).not.toContain("<<<<<<<");
  });
  test("control: without it the same cherry-pick conflicts", () => {
    expect(scenario("").code).not.toBe(0);
  });
});
