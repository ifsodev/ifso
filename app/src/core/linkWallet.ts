// The message a wallet signs to link itself to a Telegram account. The token comes from the bot's /link button (in the
// URL fragment, so it never reaches a server log); the API checks the signature, the token and its age.
export const LINK_TOKEN_TTL_SEC = 15 * 60;

export function linkWalletMessage(token: string): string {
  return `Link this wallet to my IFSO Telegram account.\nOnly sign this if you started it in the IFSO bot.\nCode: ${token}`;
}
