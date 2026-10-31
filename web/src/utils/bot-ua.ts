/**
 * Crawlers and lab tools, told apart by user agent — the one list both the
 * request proxy (which has no `headers()`) and `isBot()` read.
 *
 * Lighthouse and PageSpeed Insights identify themselves with "Lighthouse" in
 * the UA; so do the search engines' own crawlers here.
 * AI crawlers (GPTBot, ClaudeBot, PerplexityBot, …) run no JavaScript: they get
 * the robot form too, or streamed copy reads to them as `hidden` (2026-10-02).
 */
const BOT_UA =
  /lighthouse|pagespeed|googlebot|bingbot|yandexbot|duckduckbot|baiduspider|applebot|headlesschrome|gtmetrix|pingdom|gptbot|chatgpt-user|oai-searchbot|claudebot|claude-user|claude-searchbot|anthropic-ai|perplexitybot|perplexity-user|ccbot|bytespider|amazonbot|meta-externalagent|cohere-ai|mistralai-user|youbot|diffbot/i;

export const isBotUserAgent = (userAgent: string | null | undefined): boolean =>
  BOT_UA.test(userAgent ?? "");
