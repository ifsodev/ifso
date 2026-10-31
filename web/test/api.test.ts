import { describe, expect, test, vi } from "vitest";
import { ApiError, createApi, friendlyError } from "@/lib/ifso/api";
import { applyOption, replaceCI } from "@/lib/ifso/questions";

const ok = (data: unknown) => new Response(JSON.stringify({ result: { data } }), { status: 200 });
const fail = (code: string, message: string, status = 400) => new Response(JSON.stringify({ error: { message, data: { code } } }), { status });

describe("api client", () => {
  test("queries are GET with the input in the URL; mutations are POST with a JSON body; no cookies, no referrer", async () => {
    const f = vi.fn(async () => ok({ ok: true }));
    const api = createApi("https://api.example.test", f as never);
    await api.parse({ text: "/ifso link 20 on nov 1", tzOffsetMin: -300 });
    await api.decide({ id: "1", signer: "0x0000000000000000000000000000000000000001", action: 1, deadline: "5", signature: "0x00" });
    const [u1, i1] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(u1).toBe(`https://api.example.test/trpc/parse?input=${encodeURIComponent(JSON.stringify({ text: "/ifso link 20 on nov 1", tzOffsetMin: -300 }))}`);
    expect(i1.method).toBe("GET");
    const [u2, i2] = f.mock.calls[1] as unknown as [string, RequestInit];
    expect(u2).toBe("https://api.example.test/trpc/decide");
    expect(i2.method).toBe("POST");
    for (const i of [i1, i2]) expect(i).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
  });
  test("plain endpoints", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ country: "DE", stockPriceConditionsAllowed: true }), { status: 200 }));
    const api = createApi("https://api.example.test", f as never);
    expect(await api.geo()).toEqual({ country: "DE", stockPriceConditionsAllowed: true });
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("https://api.example.test/geo");
  });
  test("errors keep the API's own words, with calm defaults for the rest", async () => {
    const api = (r: () => Promise<Response>) => createApi("https://a.test", vi.fn(r) as never);
    const e1 = await api(async () => fail("BAD_REQUEST", "Amount is below the minimum.")).parse({ text: "x" }).catch((e) => e);
    expect(e1).toBeInstanceOf(ApiError);
    expect(friendlyError(e1)).toBe("Amount is below the minimum.");
    expect(friendlyError(await api(async () => fail("TOO_MANY_REQUESTS", "x", 429)).parse({ text: "x" }).catch((e) => e))).toMatch(/try again in a little while/i);
    expect(friendlyError(await api(async () => { throw new Error("offline"); }).parse({ text: "x" }).catch((e) => e))).toMatch(/could not be reached/);
    expect(friendlyError(await api(async () => fail("INTERNAL_SERVER_ERROR", "stack trace", 500)).parse({ text: "x" }).catch((e) => e))).not.toContain("stack trace");
    expect(friendlyError(await api(async () => fail("FORBIDDEN", "Stock price conditions are not available where you are.", 403)).parse({ text: "x" }).catch((e) => e))).toMatch(/not available where you are/);
  });
});

describe("parse questions", () => {
  test("an option with text replaces everything; one with replace edits the current text", () => {
    expect(applyOption("/ifso link 20 if eth 4000", { label: "a", text: "/ifso link 20 if eth at or above 4000 by friday" })).toBe("/ifso link 20 if eth at or above 4000 by friday");
    expect(applyOption("/ifso link 20 if ETH hits 4000", { label: "b", replace: ["eth hits", "eth at or above"] })).toBe("/ifso link 20 if eth at or above 4000");
    expect(replaceCI("Hello World", "world", "there")).toBe("Hello there");
    expect(replaceCI("abc", "zzz", "y")).toBe("abc");
  });
});
