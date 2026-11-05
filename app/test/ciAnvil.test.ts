// Audit I-14: the app CI job installs Foundry, so the anvil-gated suites run in CI instead of skipping. On CI a missing
// anvil or Postgres fails here, loudly, instead of turning 21 chain test files into silent skips.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { haveAnvil, havePostgres } from "./helpers/chain";

type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
// Bun.YAML exists at run time (bun 1.4.4); the pinned bun-types predate it
const { YAML } = Bun as unknown as { YAML: { parse(s: string): unknown } };
const ci = YAML.parse(readFileSync(join(import.meta.dir, "../../.github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, { steps: Step[] }> };
const foundry = (job: string) => ci.jobs[job]!.steps.find((s) => s.uses?.startsWith("foundry-rs/foundry-toolchain@"));

describe("I-14: anvil tests run in CI", () => {
  test("the app job installs the same pinned Foundry as the contracts job, before bun test", () => {
    const app = foundry("app");
    expect(app).toBeDefined();
    expect(app!.uses).toBe(foundry("contracts")!.uses!);
    expect(app!.with?.version).toBe(foundry("contracts")!.with?.version);
    const steps = ci.jobs.app!.steps;
    expect(steps.indexOf(app!)).toBeLessThan(steps.findIndex((s) => s.run?.startsWith("bun test")));
  });
  test.skipIf(!process.env.CI)("on CI, anvil and Postgres are present", () => {
    expect(haveAnvil()).toBe(true);
    expect(havePostgres()).toBe(true);
  });
});
