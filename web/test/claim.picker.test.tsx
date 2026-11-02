// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getAddress } from "viem";
import { buildClaimUrl, randomSecret } from "@/vendor/ifso/client";
import { ESCROW } from "./helpers";

// Found by the demo recordings (2026-11-01): the main button read "Claiming…" while the wallet picker was open.
const ID = 1234567890123456789n;
const URL_WITH_SECRET = buildClaimUrl("http://localhost", ID, randomSecret());
const WALLET_ACCOUNT = getAddress("0x7777777777777777777777777777777777777777");
const escrowAnswer = {
  escrow: { sender: getAddress("0x2222222222222222222222222222222222222222"), recipient: "0x0000000000000000000000000000000000000000", amount: "25000000", counterAmount: "0", linkKey: getAddress("0x3333333333333333333333333333333333333333"), status: 1, flags: 0, expiry: String(Math.floor(Date.now() / 1000) + 86_400), acceptBy: "0", refundTo: "0x0000000000000000000000000000000000000000", altRefundTo: "0x0000000000000000000000000000000000000000", conditionHash: "0x" + "11".repeat(32) },
  condition: { kind: 1, mode: 0, deadline: String(Math.floor(Date.now() / 1000) + 3600) },
  amountText: "25.0",
};

let answerAccounts: (a: string[]) => void = () => {};
const announce = () =>
  window.dispatchEvent(
    new CustomEvent("eip6963:announceProvider", {
      detail: {
        info: { uuid: "test-wallet", name: "Test Wallet", icon: "data:image/png;base64,", rdns: "test.wallet" },
        // the wallet's own account picker stays open until the test answers it
        provider: { request: () => new Promise<string[]>((r) => (answerAccounts = r)) },
      },
    }),
  );

beforeEach(() => {
  vi.resetModules();
  window.history.replaceState(null, "", new URL(URL_WITH_SECRET).pathname + new URL(URL_WITH_SECRET).hash);
  window.addEventListener("eip6963:requestProvider", announce);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = String(url).includes("/healthz") ? { ok: true, chainId: 4663, escrow: ESCROW } : { result: { data: escrowAnswer } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  window.removeEventListener("eip6963:requestProvider", announce);
  vi.unstubAllGlobals();
});

describe("claim page: choosing a wallet is not claiming", () => {
  test("while the wallet picker is open the main button never reads Claiming…", async () => {
    const { ClaimPage } = await import("@/views/secret/claim-page");
    render(<ClaimPage />);
    const pick = await screen.findByRole("button", { name: /Test Wallet/ });
    fireEvent.click(pick);
    await waitFor(() => expect(screen.queryByText("Claiming…")).toBeNull());
    expect(screen.getByRole("button", { name: "CHOOSE WHERE IT GOES" })).toBeTruthy();
    await act(async () => answerAccounts([WALLET_ACCOUNT]));
    await waitFor(() => expect(screen.getByRole("button", { name: /^CLAIM 25\.0 USDG TO/ })).toBeTruthy());
    expect(screen.queryByText("Claiming…")).toBeNull();
  });
});
