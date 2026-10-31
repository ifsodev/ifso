import { describe, expect, test, vi } from "vitest";
import { discoverWallets, ensureChain } from "@/lib/ifso/wallet";
import { CHAIN_PROFILES } from "@/lib/ifso/config";
import { STATUS_TEXT, owedVoidSide, usdgText, when } from "@/lib/ifso/status";
import { describeOnChainCondition } from "@/lib/ifso/describe";

describe("wallet list", () => {
  test("collects EIP-6963 announcements, one entry per wallet, never a generic window.ethereum button", () => {
    const target = new EventTarget() as unknown as Window;
    const seen: string[][] = [];
    target.addEventListener("eip6963:requestProvider", () => {
      for (const name of ["A", "B", "A"]) target.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: name, name: `Wallet ${name}`, icon: "data:,", rdns: `x.${name}` }, provider: { request: async () => null } } }));
    });
    const stop = discoverWallets((l) => seen.push(l.map((w) => w.info.name)), target);
    expect(seen.at(-1)).toEqual(["Wallet A", "Wallet B"]);
    stop();
  });
  test("moves the wallet to our chain, adding it when unknown", async () => {
    const calls: string[] = [];
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        calls.push(method);
        if (method === "eth_chainId") return "0x1";
        if (method === "wallet_switchEthereumChain") throw Object.assign(new Error("unknown"), { code: 4902 });
        return null;
      }),
    };
    await ensureChain(provider, CHAIN_PROFILES[4663]);
    expect(calls).toEqual(["eth_chainId", "wallet_switchEthereumChain", "wallet_addEthereumChain"]);
    const same = { request: vi.fn(async () => "0x1237") };
    await ensureChain(same, CHAIN_PROFILES[4663]);
    expect(same.request).toHaveBeenCalledTimes(1);
  });
});

describe("status wording and conditions", () => {
  test("labels", () => {
    expect(STATUS_TEXT[3]).toMatch(/Paid/);
    expect(usdgText("25000000")).toBe("25.00 USDG");
    expect(usdgText("1234567")).toBe("1.234567 USDG");
    expect(when(0)).toMatch(/1970|Dec 31, 1969/);
    expect(when("nonsense")).toBe("");
  });
  test("voided challenge: the owed side is the wallet's own", () => {
    const row = { status: 5, flags: 32, sender: "0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa" };
    expect(owedVoidSide(row, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe("sender");
    expect(owedVoidSide(row, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBeUndefined();
    expect(owedVoidSide({ ...row, status: 3 }, row.sender)).toBeUndefined();
  });
  test("condition sentences are built from chain fields", () => {
    expect(describeOnChainCondition({ kind: 1, deadline: "1800000000" })).toMatch(/^It unlocks on /);
    expect(describeOnChainCondition({ kind: 2, mode: 0, op: 0, threshold: "400000000000", deadline: "1800000000", target: "0x78F3000000000000000000000000000000d3A9" })).toMatch(/at or above 4,000 at /);
    expect(describeOnChainCondition({ kind: 3, mode: 0 })).toBe("It unlocks when both people approve.");
    expect(describeOnChainCondition({ kind: 4 })).toMatch(/two hours|2 hours/);
  });
});

import { linkDomain, linkWalletMessage, parseLinkFragment } from "@/vendor/ifso/client";
describe("/link fragment", () => {
  test("token and expiry are read from the fragment; the message names the site and the expiry", () => {
    const tok = "A".repeat(43);
    expect(parseLinkFragment(`#${tok}.1800000000`)).toEqual({ token: tok, expiresAt: 1800000000 });
    expect(parseLinkFragment(`#${tok}`)).toBeUndefined();
    const m = linkWalletMessage(tok, { domain: linkDomain("https://ifso.tech"), expiresAt: 1800000000 });
    expect(m).toContain("ifso.tech");
    expect(m).toContain("Expires: 2027-01-15T08:00:00Z");
  });
});
