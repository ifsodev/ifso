// Who is calling, and from where. Rate limits and the region gate must never trust a header the client can set.
// TRUST_PROXY says which single hop in front of the API is trusted, and only that hop's header is read:
//   none        socket address only (headers ignored). Country is unknown, so the Stock Token gate stays closed.
//   cloudflare  cf-connecting-ip (IP) and cf-ipcountry (country), both set by Cloudflare. Origin must accept Cloudflare only.
//   vercel      x-real-ip (falls back to the LAST x-forwarded-for entry) and x-vercel-ip-country.
//   caddy       the LAST x-forwarded-for entry: the address the reverse proxy itself appended. No country header.
// The first x-forwarded-for entry is whatever the client wrote and is never used.
import { isIP } from "node:net";

export type TrustProxy = "none" | "cloudflare" | "vercel" | "caddy";
export const UNKNOWN_IP = "unknown";

/** IPv4 as is; IPv4-mapped IPv6 as IPv4; any other IPv6 reduced to its /64 (a user owns the whole /64). */
export function normaliseIp(raw: string | undefined): string {
  const ip = (raw ?? "").trim().replace(/^\[|\]$/g, "").split("%")[0]!;
  const v = isIP(ip);
  if (v === 4) return ip;
  if (v !== 6) return UNKNOWN_IP;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped && isIP(mapped[1]!) === 4) return mapped[1]!;
  // expand "::" then keep the first four 16-bit groups
  let head = ip;
  let tail = "";
  if (ip.includes("::")) [head, tail] = ip.split("::") as [string, string];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  const net = groups.slice(0, 4).map((g) => parseInt(g || "0", 16).toString(16));
  return `${net.join(":")}::/64`;
}

const lastForwarded = (headers: Headers): string | undefined => {
  const parts = (headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - 1];
};

export function clientIp(headers: Headers, trust: TrustProxy, socketIp?: string): string {
  const socket = normaliseIp(socketIp);
  switch (trust) {
    case "cloudflare": {
      const ip = normaliseIp(headers.get("cf-connecting-ip") ?? undefined);
      return ip !== UNKNOWN_IP ? ip : socket;
    }
    case "vercel": {
      const ip = normaliseIp(headers.get("x-real-ip") ?? lastForwarded(headers));
      return ip !== UNKNOWN_IP ? ip : socket;
    }
    case "caddy": {
      const ip = normaliseIp(lastForwarded(headers));
      return ip !== UNKNOWN_IP ? ip : socket;
    }
    default:
      return socket;
  }
}

/** Country from the trusted proxy's own header only. Anything else is unknown (callers fail closed). */
export function trustedCountry(headers: Headers, trust: TrustProxy): string | undefined {
  const raw = trust === "cloudflare" ? headers.get("cf-ipcountry") : trust === "vercel" ? headers.get("x-vercel-ip-country") : null;
  return raw && /^[A-Za-z]{2}$/.test(raw) && raw.toUpperCase() !== "XX" && raw.toUpperCase() !== "T1" ? raw.toUpperCase() : undefined;
}
