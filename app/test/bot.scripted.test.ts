// R1: 100 scripted commands (test/fixtures/bot-commands.json) go through the real bot and give the expected
// preview, question or error. Expected values are written by hand in the fixture, not copied from the output.
import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/bot-commands.json";
import { buttonsOf, makeHarness, textOf } from "./helpers/botHarness";

type Cond = Record<string, unknown> & { atIso?: string; deadlineIso?: string; onIso?: string };
interface Case {
  input: string;
  tz?: string;
  expect: {
    kind: "preview" | "question" | "error";
    amount?: string;
    counter?: string;
    recipient?: string;
    cond?: Cond;
    contains?: string[];
    fee?: string;
    priceBand?: boolean;
    challenge?: boolean;
    qkind?: string;
    options?: number;
  };
}
const cases = fixture.cases as unknown as Case[];
const iso = (u: number) => new Date(u * 1000).toISOString();

describe("scripted bot commands (R1)", () => {
  test("there are 100 of them", () => expect(cases.length).toBe(100));

  for (const [n, c] of cases.entries()) {
    test(`#${n + 1} ${c.input}${c.tz ? ` [${c.tz}]` : ""}`, async () => {
      const h = makeHarness();
      if (c.tz) await h.say(`/tz ${c.tz}`);
      const out = await h.say(c.input);
      const text = textOf(out);
      const btns = buttonsOf(out);
      const e = c.expect;

      if (e.kind === "error") {
        expect(text).toContain(e.contains![0]!);
        expect(btns).toEqual([]);
        expect(h.store.intents.size).toBe(0); // nothing saved when there is nothing to sign
        return;
      }
      if (e.kind === "question") {
        expect(btns.length).toBe(e.options!);
        expect(btns.every((b) => typeof b.callback_data === "string" && b.callback_data.length <= 64 && !b.url)).toBe(true);
        expect(text).not.toContain("Send "); // a question never carries a preview
        const [intent] = [...h.store.intents.values()];
        expect((intent!.draft as { pending?: { kind: string } }).pending?.kind).toBe(e.qkind!);
        return;
      }

      // preview: exactly one URL button to the web app
      expect(btns.length).toBe(1);
      const [intent] = [...h.store.intents.values()];
      expect(btns[0].url).toBe(`https://ifso.test/new/${intent!.id}`);
      expect(btns[0].callback_data).toBeUndefined();
      expect(text).toContain(`${e.challenge ? `you chip in ${e.amount} USDG, they chip in ${e.counter} USDG` : `Send ${e.amount} USDG to ${e.recipient === "link" ? "whoever opens your link" : e.recipient}`}`);
      expect(text).toContain("comes back");
      expect(text).toContain("If it's still undecided");
      if (e.fee) expect(text).toContain(`Flat fee: ${e.fee} USDG`);
      if (e.priceBand) expect(text).toContain("within about 0.5%");
      for (const s of e.contains ?? []) expect(text).toContain(s);

      const d = intent!.draft as Record<string, unknown>;
      const { atIso, deadlineIso, onIso, ...want } = e.cond!;
      expect(d).toMatchObject(want);
      if (atIso) expect(iso(d.at as number)).toBe(atIso);
      if (deadlineIso) expect(iso(d.deadline as number)).toBe(deadlineIso);
      if (onIso) expect(iso(d.on as number)).toBe(onIso);
    });
  }
});
