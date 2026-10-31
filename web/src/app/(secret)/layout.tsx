import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { FRAGMENT_STASH_SCRIPT } from "@/lib/ifso/csp";
import "./secret.css";

/*
 * The claim page and /link hold a secret (in the address bar fragment or in memory). This layout is deliberately bare:
 * no scripts, fonts, analytics or widgets from anywhere, no site chrome. Reading the request headers makes the page
 * dynamic, so Next puts the per-request CSP nonce (set in src/proxy.ts) on its own bootstrap scripts.
 */
export const metadata: Metadata = {
  title: "IFSO",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#f4ece0" };

export default async function SecretLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en">
      <head>
        <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: FRAGMENT_STASH_SCRIPT }} />
      </head>
      <body className="sx">
        <main className="sx-main">{children}</main>
      </body>
    </html>
  );
}
