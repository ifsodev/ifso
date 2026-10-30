// Prints the Telegram webhook URL and the setWebhook call for this environment. Makes no network request:
// run the printed curl yourself, from the machine that holds the bot token.
//   PUBLIC_API_URL=https://api.example.com bun run scripts/webhook-url.ts
import { loadEnv } from "../src/config/env";
import { webhookPath } from "../src/bot/webhook";

const env = loadEnv();
const path = webhookPath(env);
if (!path || !env.TELEGRAM_BOT_TOKEN) {
  console.error("set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET first");
  process.exit(1);
}
const base = (process.env.PUBLIC_API_URL ?? "https://YOUR-API-HOST").replace(/\/$/, "");
console.log(`webhook url:  ${base}${path}`);
console.log(`register it:  curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" -d "url=${base}${path}" -d "secret_token=$TELEGRAM_WEBHOOK_SECRET" -d 'allowed_updates=["message","callback_query"]'`);
