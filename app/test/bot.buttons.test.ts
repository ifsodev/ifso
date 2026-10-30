// R6: no reply carries a Mini App / web_app / login button. Only plain URL buttons and our own callback buttons.
import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/bot-commands.json";
import { makeHarness, type Sent } from "./helpers/botHarness";

const ALLOWED = new Set(["text", "url", "callback_data"]);

function check(sent: Sent[]) {
  for (const s of sent) {
    expect(JSON.stringify(s.payload)).not.toMatch(/web_app|login_url|callback_game|switch_inline|pay"|request_contact|request_location/);
    const kb = s.payload.reply_markup;
    if (!kb) continue;
    expect(Object.keys(kb)).toEqual(["inline_keyboard"]); // no reply keyboards, no menu button payloads
    for (const b of kb.inline_keyboard.flat()) {
      expect(Object.keys(b).every((k) => ALLOWED.has(k))).toBe(true);
      expect(Boolean(b.url) !== Boolean(b.callback_data)).toBe(true);
      if (b.url) expect(b.url).toMatch(/^https:\/\/ifso\.test\//);
    }
  }
}

describe("no Mini App buttons (R6)", () => {
  test("every reply to the 100 scripted commands", async () => {
    const h = makeHarness();
    for (const c of fixture.cases as { input: string; tz?: string }[]) {
      if (c.tz) await h.say(`/tz ${c.tz}`);
      await h.say(c.input);
    }
    expect(h.sent.length).toBeGreaterThan(100);
    check(h.sent);
  });

  test("start, help, mine, tz and answers to questions", async () => {
    const h = makeHarness();
    await h.say("/start");
    await h.say("/help");
    await h.say("/tz Europe/London");
    h.store.mineRows = [{ amount: "20000000", status: 1, expiry: new Date(Date.UTC(2026, 10, 1)) }];
    await h.say("/mine");
    const q = await h.say("/ifso @mia 5 on 11/01");
    const data = q.flatMap((s) => s.payload.reply_markup.inline_keyboard.flat())[0].callback_data;
    await h.press(data);
    check(h.sent);
    expect(h.sent.filter((s) => s.payload.reply_markup).length).toBeGreaterThan(2);
  });

  test("the bot source never mentions web_app or Mini App buttons", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = new URL("../src/bot/", import.meta.url).pathname;
    for (const f of readdirSync(dir)) expect(readFileSync(dir + f, "utf8").replace(/\/\/.*$/gm, "")).not.toMatch(/web_app|webApp|login_url|setChatMenuButton/);
  });
});
