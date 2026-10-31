/**
 * Content-Security-Policy for the two pages that hold a secret (the claim page /c/* and /link).
 * Nothing may load from anywhere but this site, except the two origins the page talks to (the API and the chain RPC).
 * Inline scripts run only with the per-request nonce Next adds to its own bootstrap scripts.
 */
export const SECRET_ROUTES = [/^\/c\/[^/]+\/?$/, /^\/link\/?$/];
export const isSecretPath = (pathname: string) => SECRET_ROUTES.some((re) => re.test(pathname));

export function secretCsp(opts: { nonce: string; connectOrigins: string[]; dev?: boolean }): string {
  const connect = ["'self'", ...opts.connectOrigins].join(" ");
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${opts.nonce}'${opts.dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${opts.nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Headers that never change per request. Also served from next.config so they hold even if the proxy is skipped. */
export const SECRET_STATIC_HEADERS: Record<string, string> = {
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), publickey-credentials-create=(self), publickey-credentials-get=(self)",
  // baseline without script/style/connect sources: combined with the nonce policy it can only make it stricter
  "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'",
};
