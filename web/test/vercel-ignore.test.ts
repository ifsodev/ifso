// Release lesson 41: Vercel's ignoreCommand compared only HEAD^ with HEAD, so a push of several
// commits whose last one did not touch web/ was skipped (or a skipped build stayed skipped). It must compare with the
// last deployed commit, VERCEL_GIT_PREVIOUS_SHA, and fall back to HEAD^ only when Vercel has none.
import { describe, expect, test } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cmd = JSON.parse(readFileSync(join(__dirname, "../vercel.json"), "utf8")).ignoreCommand as string;

describe("vercel ignoreCommand", () => {
  test("is pinned to the last deployed commit", () => {
    expect(cmd).toBe("git diff --quiet ${VERCEL_GIT_PREVIOUS_SHA:-HEAD^} HEAD -- .");
  });

  test("builds when any commit since the last deploy touched web/, skips when none did", () => {
    const repo = mkdtempSync(join(tmpdir(), "ifso-vercel-ignore-"));
    try {
      const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: repo }).toString().trim();
      mkdirSync(join(repo, "web"));
      mkdirSync(join(repo, "app"));
      git("init", "-q");
      const commit = (file: string, body: string) => (writeFileSync(join(repo, file), body), git("add", "-A"), git("commit", "-q", "-m", file), git("rev-parse", "HEAD"));
      const deployed = commit("web/a.txt", "1");
      commit("web/a.txt", "2"); // a site change...
      commit("app/b.txt", "1"); // ...then a push whose last commit does not touch web/
      const run = (prev?: string) => spawnSync("sh", ["-c", cmd], { cwd: join(repo, "web"), env: { ...process.env, VERCEL_GIT_PREVIOUS_SHA: prev ?? "" } }).status;
      expect(run(deployed)).toBe(1); // exit 1 = build
      expect(run()).toBe(0); // the old HEAD^-only rule would have skipped it (exit 0 = skip)
      expect(run(git("rev-parse", "HEAD~1"))).toBe(0); // nothing in web/ since the last deploy: skip
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
