import { NextResponse, type NextRequest } from "next/server";

import { config as ifsoConfig } from "@/lib/ifso/config";
import { SECRET_STATIC_HEADERS, isSecretPath, secretCsp } from "@/lib/ifso/csp";
import { isBotUserAgent } from "@/utils/bot-ua";

/**
 * Robots get the home page at rest (owner rule D-016).
 *
 * A crawler or a lab tool (Lighthouse, PageSpeed) asking for `/` is rewritten
 * to `/robot-view`: the same view, content, metadata and canonical — without
 * the intro and the motion a robot never watches. Both routes stay static:
 * reading the UA here, not with `headers()` in the page, keeps the human `/`
 * prerendered and CDN-cached. A person who types `/robot-view` is sent to `/`.
 */
export function proxy(request: NextRequest) {
  // The claim page and the wallet-link page hold a secret: strict CSP with a per-request nonce, no caching.
  if (isSecretPath(request.nextUrl.pathname)) {
    const nonce = btoa(crypto.randomUUID());
    const csp = secretCsp({ nonce, connectOrigins: ifsoConfig.connectOrigins, dev: process.env.NODE_ENV !== "production" });
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("content-security-policy", csp);
    const res = NextResponse.next({ request: { headers: requestHeaders } });
    for (const [k, v] of Object.entries(SECRET_STATIC_HEADERS)) res.headers.set(k, v);
    res.headers.set("Content-Security-Policy", csp);
    return res;
  }
  const bot = isBotUserAgent(request.headers.get("user-agent"));
  const { pathname } = request.nextUrl;
  if (pathname === "/" && bot) {
    return NextResponse.rewrite(new URL("/robot-view", request.url));
  }
  if (pathname === "/robot-view" && !bot) {
    return NextResponse.redirect(new URL("/", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/robot-view", "/c/:id", "/link"],
};
