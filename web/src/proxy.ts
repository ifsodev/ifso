import { NextResponse, type NextRequest } from "next/server";

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
  matcher: ["/", "/robot-view"],
};
