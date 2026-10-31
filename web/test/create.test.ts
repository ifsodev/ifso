import { describe, expect, test, vi } from "vitest";
import { getAddress } from "viem";
import { buildAndVerify, signAndSubmit } from "@/lib/ifso/create";
import { reviveTypedData } from "@/lib/ifso/typed";
import { b64urlEncode } from "@/vendor/ifso/client";
import { CHAIN_ID, ESCROW, SENDER, SIG, USDG, realBuildAnswer } from "./helpers";

const deps = (api: Record<string, unknown>, sign = vi.fn(async () => SIG)) => ({ api: api as never, chainId: CHAIN_ID, escrow: ESCROW, usdg: USDG, sign, origin: "https://example.test" });

describe("create flow", () => {
  test("the secret is made here and only its derived address is sent to build", async () => {
    let sent: Record<string, unknown> | undefined;
    const api = { build: vi.fn(async (i: Record<string, unknown>) => ((sent = i), realBuildAnswer({ linkKey: i.linkKey as never }))), submit: vi.fn() };
    const built = await buildAndVerify(deps(api), { text: "/ifso link 20 on nov 1", sender: SENDER });
    expect(built.secret).toBeInstanceOf(Uint8Array);
    expect(built.secret!.length).toBe(32);
    expect(sent!.linkKey).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(JSON.stringify(sent)).not.toContain(b64urlEncode(built.secret!));
  });

  test("signed payload equals the build answer (after verifyBuildAnswer), and the link carries the secret only in the fragment", async () => {
    let answer = realBuildAnswer();
    const api = { build: vi.fn(async (i: Record<string, unknown>) => (answer = realBuildAnswer({ linkKey: i.linkKey as never }))), submit: vi.fn(async () => ({ txHash: SIG, id: answer.id })) };
    const sign = vi.fn(async () => SIG);
    const d = deps(api, sign);
    const input = { text: "/ifso link 20 on nov 1", sender: SENDER };
    const built = await buildAndVerify(d, input);
    const out = await signAndSubmit(d, input, built);
    // what the wallet signed is the typed data build returned (numbers revived), nothing assembled locally
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign.mock.calls[0]![0]).toEqual(reviveTypedData(answer.authorization.typedData as never));
    expect(api.submit).toHaveBeenCalledWith({ params: answer.params, from: SENDER, validAfter: answer.authorization.validAfter, validBefore: answer.authorization.validBefore, signature: SIG });
    expect(out.claimUrl).toMatch(/^https:\/\/example\.test\/c\/[A-Za-z0-9_-]{43}#1\.[A-Za-z0-9_-]+$/);
    // the secret is not part of anything sent to the service
    expect(JSON.stringify([api.build.mock.calls, api.submit.mock.calls])).not.toContain(out.claimUrl!.split("#1.")[1]!);
  });

  test("an answer for a different claim link than the one made here is refused (audit L-3)", async () => {
    const api = { build: vi.fn(async () => realBuildAnswer({ linkKey: getAddress("0x8888888888888888888888888888888888888888") })), submit: vi.fn() };
    await expect(buildAndVerify(deps(api), { text: "/ifso link 20 on nov 1", sender: SENDER })).rejects.toThrow(/nothing was signed/);
    expect(api.submit).not.toHaveBeenCalled();
  });

  test("a tampered build answer is refused before anything is signed", async () => {
    // the answer carries the link key this page made, so only the tampered field can be the reason for the refusal
    const bad = (i: Record<string, unknown>) => { const a = realBuildAnswer({ linkKey: i.linkKey as never }); a.authorization.typedData.message.to = getAddress("0x9999999999999999999999999999999999999999"); return a; };
    const api = { build: vi.fn(async (i: Record<string, unknown>) => bad(i)), submit: vi.fn() };
    await expect(buildAndVerify(deps(api), { text: "/ifso link 20 on nov 1", sender: SENDER })).rejects.toThrow(/nothing was signed/);
    const wrongAmount = (i: Record<string, unknown>) => { const a = realBuildAnswer({ linkKey: i.linkKey as never }); a.authorization.typedData.message.value = "1"; return a; };
    const api2 = { build: vi.fn(async (i: Record<string, unknown>) => wrongAmount(i)), submit: vi.fn() };
    await expect(buildAndVerify(deps(api2), { text: "/ifso link 20 on nov 1", sender: SENDER })).rejects.toThrow(/nothing was signed/);
    expect(api.submit).not.toHaveBeenCalled();
  });

  test("a named recipient gets no link key and no claim link", async () => {
    const recipient = getAddress("0x4444444444444444444444444444444444444444");
    let sent: Record<string, unknown> | undefined;
    const answer = realBuildAnswer({ recipient });
    const api = { build: vi.fn(async (i: Record<string, unknown>) => ((sent = i), answer)), submit: vi.fn(async () => ({ txHash: SIG, id: answer.id })) };
    const d = deps(api);
    const input = { text: `/ifso ${recipient} 20 on nov 1`, sender: SENDER, recipient };
    const built = await buildAndVerify(d, input);
    expect(built.secret).toBeUndefined();
    expect(sent!.linkKey).toBeUndefined();
    expect((await signAndSubmit(d, input, built)).claimUrl).toBeUndefined();
  });

  test("a wrong network or token in the answer is refused", async () => {
    const answer = realBuildAnswer();
    const api = { build: vi.fn(async () => answer), submit: vi.fn() };
    await expect(buildAndVerify({ ...deps(api), chainId: 46630 }, { text: "x", sender: SENDER })).rejects.toThrow(/wrong network/);
    await expect(buildAndVerify({ ...deps(api), usdg: getAddress("0x5555555555555555555555555555555555555555") }, { text: "x", sender: SENDER })).rejects.toThrow(/wrong token/);
  });
});
