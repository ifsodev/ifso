// The message a wallet signs to link itself to a Telegram account. The token comes from the bot's /link button (in the
// URL fragment, so it never reaches a server log); the API checks the signature, the token and its age.
// Review R3-I1: the message names the site (host of PUBLIC_APP_URL) and the code's expiry time, so a signature asked
// for on another site, or after the code ran out, reads as wrong to the person signing and never matches here.
export const LINK_TOKEN_TTL_SEC = 15 * 60;

export interface LinkMessageContext {
  /** Host of the site the user should be on, e.g. "app.example.com" (PUBLIC_APP_URL's host). */
  domain: string;
  /** Unix seconds when the one-time code stops working (from the /link URL fragment). */
  expiresAt: number;
}

export function linkWalletMessage(token: string, ctx: LinkMessageContext): string {
  const expires = new Date(ctx.expiresAt * 1000).toISOString().replace(/\.000Z$/, "Z");
  return [
    `${ctx.domain} asks you to link this wallet to your IFSO Telegram account.`,
    `Only sign this if you started it in the IFSO bot and this page is ${ctx.domain}.`,
    `Code: ${token}`,
    `Expires: ${expires}`,
  ].join("\n");
}

/** The host part of the public site URL, as shown in the message. */
export const linkDomain = (publicAppUrl: string) => new URL(publicAppUrl).host;

/** The /link page fragment: `<token>.<expiresAt unix seconds>` (the token is base64url, so "." never appears in it). */
export function linkFragment(token: string, expiresAt: number): string {
  return `${token}.${expiresAt}`;
}

export function parseLinkFragment(fragment: string): { token: string; expiresAt: number } | undefined {
  const m = /^#?([A-Za-z0-9_-]{43})\.(\d{9,11})$/.exec(fragment);
  return m ? { token: m[1]!, expiresAt: Number(m[2]) } : undefined;
}
