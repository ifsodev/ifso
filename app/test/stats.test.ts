// Real-user counter rules on hand-made events (the anvil suite checks the same rules against a real chain).
import { describe, expect, test } from "bun:test";
import { computeUserStats, type StatEvent } from "../src/core/stats";
import { internalAddresses, loadEnv } from "../src/config/env";

const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const ZERO = A(0);
const DAY = 86400;
const D1 = 1_793_000_000 - (1_793_000_000 % DAY); // a UTC midnight
const created = (id: number, sender: number, recipient: number, amount: number, t: number, counter = 0): StatEvent => ({ name: "Created", blockTime: t, args: { id: String(id), sender: A(sender), recipient: A(recipient), amount: String(amount * 1e6), counterAmount: String(counter * 1e6) } });
const accepted = (id: number, acceptor: number, t: number): StatEvent => ({ name: "Accepted", blockTime: t, args: { id: String(id), acceptor: A(acceptor) } });
const claimed = (id: number, recipient: number, t: number): StatEvent => ({ name: "Claimed", blockTime: t, args: { id: String(id), recipient: A(recipient) } });

describe("computeUserStats", () => {
  const evs: StatEvent[] = [
    created(1, 1, 10, 20, D1 + 10),
    created(2, 1, 11, 5, D1 + 20), // same sender again
    created(3, 2, 0, 7, D1 + 30), // link payment, recipient not bound yet
    claimed(3, 12, D1 + 40),
    created(4, 3, 13, 10, D1 + DAY + 5, 4), // challenge with a counter side
    accepted(4, 13, D1 + DAY + 50),
  ];

  test("totals", () => {
    const s = computeUserStats(evs, []);
    expect(s).toMatchObject({ uniqueSenders: 3, uniqueRecipients: 4, uniqueAcceptors: 1, escrowsCreated: 4, volumeUsdg: String((20 + 5 + 7 + 10 + 4) * 1e6) });
  });

  test("per day", () => {
    const s = computeUserStats(evs, []);
    expect(s.perDay.map((d) => d.day)).toEqual([new Date(D1 * 1000).toISOString().slice(0, 10), new Date((D1 + DAY) * 1000).toISOString().slice(0, 10)]);
    expect(s.perDay[0]).toMatchObject({ uniqueSenders: 2, escrowsCreated: 3, uniqueRecipients: 3, volumeUsdg: String(32e6) });
    expect(s.perDay[1]).toMatchObject({ uniqueSenders: 1, escrowsCreated: 1, uniqueAcceptors: 1, volumeUsdg: String(14e6) });
  });

  test("internal addresses are excluded everywhere (sender, recipient, acceptor, claimer)", () => {
    const s = computeUserStats(evs, [A(1).toUpperCase().replace("0X", "0x"), A(12)]);
    // sender 1 leaves escrows 1 and 2; claimer 12 leaves recipients
    expect(s).toMatchObject({ uniqueSenders: 2, escrowsCreated: 2, uniqueRecipients: 1, /* only 13 */ volumeUsdg: String((7 + 10 + 4) * 1e6) });
    const s2 = computeUserStats(evs, [A(13)]);
    expect(s2.uniqueAcceptors).toBe(0);
    expect(s2.uniqueRecipients).toBe(3); // 10, 11, 12
  });

  test("since drops older events; unknown block times are skipped then", () => {
    const s = computeUserStats([...evs, { name: "Created", blockTime: null, args: { id: "9", sender: A(9), recipient: A(0), amount: "1000000", counterAmount: "0" } }], [], D1 + DAY);
    expect(s).toMatchObject({ uniqueSenders: 1, escrowsCreated: 1, uniqueAcceptors: 1 });
    expect(computeUserStats([{ name: "Created", blockTime: null, args: { id: "9", sender: A(9), recipient: ZERO, amount: "1000000", counterAmount: "0" } }], []).escrowsCreated).toBe(1);
  });

  test("the same log read twice counts once; other event names are ignored", () => {
    const s = computeUserStats([...evs, ...evs, { name: "Released", blockTime: D1, args: { id: "1", to: A(77), amount: "1" } }], []);
    expect(s.escrowsCreated).toBe(4);
    expect(s.uniqueRecipients).toBe(4);
  });

  test("INTERNAL_ADDRESSES env: parsed, lowercased, validated", () => {
    expect(internalAddresses(loadEnv({ INTERNAL_ADDRESSES: `${A(1).toUpperCase().replace("0X", "0x")}, ${A(2)}` }))).toEqual([A(1), A(2)]);
    expect(() => loadEnv({ INTERNAL_ADDRESSES: "0x123" })).toThrow();
    expect(internalAddresses(loadEnv({}))).toEqual([]);
  });
});
