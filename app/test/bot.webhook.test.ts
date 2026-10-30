// R3: the webhook route sits at a secret path and rejects a wrong or missing secret token with 401.
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/api/app";
import { RateLimiter } from "../src/api/rateLimit";
import { webhookPath } from "../src/bot/webhook";
import { makeHarness } from "./helpers/botHarness";

const update = {
  update_id: 1,
  message: { message_id: 1, date: 0, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false, first_name: "T" }, text: "/help", entities: [{ type: "bot_command", offset: 0, length: 5 }] },
};
const post = (app: ReturnType<typeof createApp>, path: string, token?: string) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-telegram-bot-api-secret-token": token } : {}) },
    body: JSON.stringify(update),
  });

describe("telegram webhook (R3)", () => {
  const h = makeHarness();
  const app = createApp(h.deps, new RateLimiter(), h.bot);
  const path = webhookPath(h.env)!;

  test("the path is secret: /tg/<32 hex>, derived from the secret and token", () => {
    expect(path).toMatch(/^\/tg\/[0-9a-f]{32}$/);
    expect(webhookPath({ ...h.env, TELEGRAM_WEBHOOK_SECRET: "other" })).not.toBe(path);
    expect(webhookPath({ ...h.env, TELEGRAM_WEBHOOK_SECRET: undefined })).toBeUndefined();
  });

  test("a wrong secret token gets 401 and nothing is sent", async () => {
    const r = await post(app, path, "not-the-secret");
    expect(r.status).toBe(401);
    expect(h.sent.length).toBe(0);
  });

  test("a missing secret token gets 401", async () => {
    expect((await post(app, path)).status).toBe(401);
    expect(h.sent.length).toBe(0);
  });

  test("the right token is accepted and the update is handled", async () => {
    const r = await post(app, path, "hook-secret");
    expect(r.status).toBe(200);
    expect(h.sent.some((s) => s.method === "sendMessage")).toBe(true);
  });

  test("the right token on the wrong path is a 404, and the old fixed path is gone", async () => {
    expect((await post(app, "/tg/webhook", "hook-secret")).status).toBe(404);
    expect((await post(app, path.slice(0, -1) + "0x", "hook-secret")).status).toBe(404);
  });

  test("no webhook secret configured: no route at all", async () => {
    const bare = createApp({ ...h.deps, env: { ...h.env, TELEGRAM_WEBHOOK_SECRET: undefined } }, new RateLimiter(), h.bot);
    expect((await post(bare, path, "hook-secret")).status).toBe(404);
  });
});
