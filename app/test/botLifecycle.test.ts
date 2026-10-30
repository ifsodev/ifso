// Group chats, other commands, /tz, and the env template the coordinator asked about.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { loadEnv } from "../src/config/env";
import { buttonsOf, makeHarness, textOf } from "./helpers/botHarness";

describe("group chats", () => {
  test("a command with our @botname works; one addressed to another bot, and plain text, are ignored", async () => {
    const h = makeHarness();
    const mine = await h.say("/ifso@ifso_bot @jake 20 if arsenal win", { chatType: "group", chatId: -100, userId: 9 });
    expect(buttonsOf(mine)[0].url).toContain("/new/");
    expect([...h.store.intents.values()][0]!.tgChatId).toBe(-100n);
    expect(await h.say("/ifso@other_bot @jake 20 if arsenal win", { chatType: "group", chatId: -100 })).toEqual([]);
    expect(await h.say("ifso @jake 20 if arsenal win", { chatType: "group", chatId: -100 })).toEqual([]);
    expect(await h.say("hey /ifso is cool", { chatType: "group", chatId: -100 })).toEqual([]);
  });

  test("/mine lists payments for the chat, or says there are none", async () => {
    const h = makeHarness();
    expect(textOf(await h.say("/mine"))).toBe("No if-so payments yet.");
    h.store.mineRows = [{ amount: "20000000", status: 1, expiry: new Date(Date.UTC(2026, 10, 1)) }];
    const out = await h.say("/mine");
    expect(textOf(out)).toBe("20 USDG · open · comes back 2026-11-01");
    expect(buttonsOf(out)[0].url).toBe("https://ifso.test/mine");
  });

  test("/start and /help", async () => {
    const h = makeHarness();
    expect(textOf(await h.say("/start"))).toContain("never holds your keys");
    expect(textOf(await h.say("/help"))).toContain("/tz");
  });
});

describe("/tz", () => {
  test("an IANA zone is stored and used for dates, and the preview shows both the zone and UTC", async () => {
    const h = makeHarness();
    expect(textOf(await h.say("/tz asia/dubai"))).toBe("Time zone set to Asia/Dubai (UTC+4 right now).");
    expect(h.store.users.get(7n)).toMatchObject({ tz: "Asia/Dubai", tzOffsetMin: 240 });
    const out = await h.say("/ifso @mia 5 on nov 14 at 6pm");
    expect(textOf(out)).toContain("2026-11-14 18:00 Asia/Dubai (2026-11-14 14:00 UTC)");
  });

  test("daylight saving follows the date, not today's offset", async () => {
    const h = makeHarness(); // 'now' is in October (EDT); the deadline is in January (EST)
    await h.say("/tz America/New_York");
    const jan = textOf(await h.say("/ifso @mia 5 on jan 15 at 9am"));
    expect(jan).toContain("2027-01-15 09:00 America/New_York (2027-01-15 14:00 UTC)");
    const oct = textOf(await h.say("/ifso @mia 5 on oct 30 at 9am"));
    expect(oct).toContain("2026-10-30 09:00 America/New_York (2026-10-30 13:00 UTC)");
  });

  test("the intent keeps the offset used, so the web build reads the same instant", async () => {
    const h = makeHarness();
    await h.say("/tz America/New_York");
    await h.say("/ifso @mia 5 on jan 15 at 9am");
    expect([...h.store.intents.values()][0]!.tzOffsetMin).toBe(-300);
  });

  test("plain offsets still work, bad names are refused, and no argument shows the current setting", async () => {
    const h = makeHarness();
    expect(textOf(await h.say("/tz"))).toContain("No time zone set yet");
    expect(textOf(await h.say("/tz +4"))).toBe("Time zone set to UTC+4 (UTC+4 right now).");
    expect(textOf(await h.say("/tz -5:30"))).toContain("UTC-5:30");
    expect(h.store.users.get(7n)).toMatchObject({ tz: null, tzOffsetMin: -330 });
    expect(textOf(await h.say("/tz Mars/Olympus"))).toContain("don't know the time zone");
    expect(textOf(await h.say("/tz +99"))).toContain("don't know");
    await h.say("/tz Europe/London");
    expect(textOf(await h.say("/tz"))).toContain("Europe/London");
  });
});

describe(".env.example", () => {
  const parse = (text: string) =>
    Object.fromEntries(
      text
        .split("\n")
        .filter((l) => l.trim() && !l.trim().startsWith("#"))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
    );
  const example = parse(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));

  test("copied as is, it parses: empty address lines mean 'not set'", () => {
    expect(example.ESCROW_ADDRESS).toBe(""); // really is an empty line in the template
    const env = loadEnv(example);
    expect(env.ESCROW_ADDRESS).toBeUndefined();
    expect(env.RESOLVER_ADDRESS).toBeUndefined();
    expect(env.EVALUATOR_ADDRESS).toBeUndefined();
    expect(env.RELAYER_PK).toBeUndefined();
    expect(env.PORT).toBe(8080);
    expect(env.ESCROW_DEPLOY_BLOCK).toBe(0n);
    expect(env.RHC_RPC_URLS.split(",").length).toBe(2);
  });

  test("an empty value never overrides a default, and a real value still wins", () => {
    expect(loadEnv({ PORT: "", USDG_ADDRESS: "" }).PORT).toBe(8080);
    expect(loadEnv({ ESCROW_ADDRESS: "0x00000000000000000000000000000000000e5c20" }).ESCROW_ADDRESS).toBe("0x00000000000000000000000000000000000e5c20");
    expect(() => loadEnv({ ESCROW_ADDRESS: "0xnothex" })).toThrow();
  });

  test("a role that needs the address still refuses to start without it", () => {
    expect(() => loadEnv(example, "bot")).toThrow(/ESCROW_ADDRESS/);
  });
});
