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

/**
 * Runs first in <head> of the secret pages, before Next's own scripts. Next's router records the address it booted with
 * (fragment included) and writes it back into the address bar, so the fragment has to be gone BEFORE it starts. The
 * script moves the fragment into one window variable and clears the address bar and the history entry; the page's
 * code takes it from there once and deletes the variable (see lib/ifso/claimLink.ts and views/secret/link-page.tsx).
 */
export const FRAGMENT_STASH_VAR = "__ifsoFragment";
export const FRAGMENT_STASH_SCRIPT = `(function(){try{var h=location.hash;if(h){window.${FRAGMENT_STASH_VAR}=h;history.replaceState(null,"",location.pathname+location.search)}}catch(e){}})()`;
