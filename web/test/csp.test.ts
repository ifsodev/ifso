import { describe, expect, test } from "vitest";
import { NextRequest } from "next/server";
import nextConfig from "../next.config";
import { isSecretPath, secretCsp, SECRET_STATIC_HEADERS } from "@/lib/ifso/csp";
import { proxy } from "@/proxy";

const req = (path: string) => new NextRequest(`https://example.test${path}`, { headers: { "user-agent": "Mozilla/5.0" } });

describe("strict CSP on /c/* and /link", () => {
  test("which paths are secret", () => {
    expect(isSecretPath("/c/AAAA")).toBe(true);
    expect(isSecretPath("/link")).toBe(true);
    expect(isSecretPath("/dashboard")).toBe(false);
    expect(isSecretPath("/c/a/b")).toBe(false);
  });

  test("the proxy sets the nonce CSP, no-store and no-referrer, and shares the nonce with Next", () => {
    for (const path of ["/c/" + "A".repeat(43), "/link"]) {
      const res = proxy(req(path));
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toContain("default-src 'none'");
      expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("form-action 'none'");
      expect(csp).toMatch(/connect-src 'self'/);
      expect(csp).not.toContain("unsafe-inline");
      expect(csp).not.toMatch(/https?:\/\/(?!rpc\.|127\.|localhost)[^ ;]*(walletconnect|reown|google|cloudflare)/i);
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      // the request header carries the same policy: that is how Next puts the nonce on its scripts
      expect(res.headers.get("x-middleware-request-content-security-policy")).toBe(csp);
    }
  });

  test("each request gets a new nonce", () => {
    const a = proxy(req("/link")).headers.get("content-security-policy");
    const b = proxy(req("/link")).headers.get("content-security-policy");
    expect(a).not.toBe(b);
  });

  test("other pages do not get it", () => {
    expect(proxy(req("/pricing")).headers.get("content-security-policy")).toBeNull();
  });

  test("the policy only ever names this site, the API and the RPC", () => {
    const csp = secretCsp({ nonce: "n", connectOrigins: ["https://api.example.test", "https://rpc.example.test"] });
    expect(csp).toContain("connect-src 'self' https://api.example.test https://rpc.example.test");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("font-src 'self'");
    expect(csp).not.toContain("unsafe-eval");
    expect(secretCsp({ nonce: "n", connectOrigins: [], dev: true })).toContain("unsafe-eval");
  });

  test("next.config also serves the fixed headers for both routes", async () => {
    const rules = await nextConfig.headers!();
    for (const source of ["/c/:id", "/link"]) {
      const r = rules.find((x) => x.source === source)!;
      expect(r).toBeTruthy();
      const map = Object.fromEntries(r.headers.map((h) => [h.key, h.value]));
      expect(map).toEqual(SECRET_STATIC_HEADERS);
      expect(map["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    }
  });
});
