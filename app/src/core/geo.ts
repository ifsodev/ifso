// Front-end region gate for Stock Token PRICE conditions: UK and CH only. The US, Canada and the UAE are open: the owner
// confirmed permission to launch there (DECISIONS #41, 2026-11-01). IP-based, self-declared, no KYC: a courtesy gate,
// not an on-chain control. Fails closed when the country is unknown.
export const PRICE_GATED_COUNTRIES = new Set(["GB", "CH"]);

export function countryFromHeaders(h: Headers | Record<string, string | undefined>): string | undefined {
  const get = (k: string) => (h instanceof Headers ? h.get(k) ?? undefined : h[k] ?? h[k.toLowerCase()]);
  // Edge-set headers only (never x-country). The API reads them through api/clientIp.trustedCountry, which TRUST_PROXY gates.
  const c = get("cf-ipcountry") ?? get("x-vercel-ip-country");
  return c && /^[A-Za-z]{2}$/.test(c) && c.toUpperCase() !== "XX" ? c.toUpperCase() : undefined;
}

export function stockPriceConditionAllowed(country: string | undefined): boolean {
  if (!country) return false;
  return !PRICE_GATED_COUNTRIES.has(country);
}
