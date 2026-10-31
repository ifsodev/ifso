// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { getAddress } from "viem";
import { buildClaimUrl, randomSecret } from "@/vendor/ifso/client";
import { ESCROW } from "./helpers";

const ID = 1234567890123456789n;
const secret = randomSecret();
const URL_WITH_SECRET = buildClaimUrl("http://localhost", ID, secret);

let seenAtFetch: { hash: string; href: string }[] = [];
const escrowAnswer = {
  escrow: { sender: getAddress("0x2222222222222222222222222222222222222222"), recipient: "0x0000000000000000000000000000000000000000", amount: "25000000", counterAmount: "0", linkKey: getAddress("0x3333333333333333333333333333333333333333"), status: 1, flags: 0, expiry: String(Math.floor(Date.now() / 1000) + 86_400), acceptBy: "0", refundTo: "0x0000000000000000000000000000000000000000", altRefundTo: "0x0000000000000000000000000000000000000000", conditionHash: "0x" + "11".repeat(32) },
  condition: { kind: 1, mode: 0, deadline: String(Math.floor(Date.now() / 1000) + 3600) },
  amountText: "25.0",
};

beforeEach(() => {
  seenAtFetch = [];
  vi.resetModules();
  window.history.replaceState(null, "", new URL(URL_WITH_SECRET).pathname + new URL(URL_WITH_SECRET).hash);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      seenAtFetch.push({ hash: window.location.hash, href: window.location.href });
      const body = String(url).includes("/healthz") ? { ok: true, chainId: 4663, escrow: ESCROW } : { result: { data: escrowAnswer } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("claim page", () => {
  test("the fragment is gone from the address bar and history before any request, and before first render", async () => {
    expect(window.location.hash).toContain("#1.");
    const { ClaimPage } = await import("@/views/secret/claim-page"); // loading the module is what wipes it
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(b64(secret));
    expect(seenAtFetch).toHaveLength(0);
    render(<ClaimPage />);
    await waitFor(() => expect(screen.getByText(/25\.0 USDG/)).toBeTruthy());
    expect(seenAtFetch.length).toBeGreaterThan(0);
    for (const s of seenAtFetch) {
      expect(s.hash).toBe("");
      expect(s.href).not.toContain(b64(secret));
    }
  });

  test("amount and condition come from the API, and no request carries the secret", async () => {
    const { ClaimPage } = await import("@/views/secret/claim-page");
    render(<ClaimPage />);
    await waitFor(() => expect(screen.getByText(/25\.0 USDG/)).toBeTruthy());
    expect(screen.getByText(/It unlocks on/)).toBeTruthy();
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => JSON.stringify(c));
    for (const c of calls) expect(c).not.toContain(b64(secret));
    // everything shown that is money or condition is the API's: nothing in the URL contained "25"
    expect(URL_WITH_SECRET).not.toContain("25.0");
  });

  test("a broken link shows a plain message and still wipes the fragment", async () => {
    window.history.replaceState(null, "", "/c/" + "A".repeat(43) + "#1.broken");
    const { ClaimPage } = await import("@/views/secret/claim-page");
    expect(window.location.hash).toBe("");
    render(<ClaimPage />);
    await waitFor(() => expect(screen.getByText(/This link does not work/)).toBeTruthy());
    expect(seenAtFetch).toHaveLength(0);
  });
});

function b64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
