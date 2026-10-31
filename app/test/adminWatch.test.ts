// The admin-event monitor: every owner / panel change reaches the ops chat in plain words, once, and the monitor starts from the
// head (no replay of history) and follows its cursor. Logs are encoded with the real contract ABIs and fed through a stub client.
import { describe, expect, test } from "bun:test";
import { encodeEventTopics, encodeAbiParameters, type Abi, type AbiEvent, type Address, type Hex } from "viem";
import { feeRouterAbi, ifsoConditionEvaluatorAbi, ifsoEscrowAbi, ifsoOutcomeResolverAbi } from "../src/abi";
import { loadEnv } from "../src/config/env";
import { ADMIN_EVENTS, adminWatchTick, describeAdminEvent, type ContractLabel } from "../src/workers/adminWatch";
import type { Deps } from "../src/workers/deps";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const ESCROW = A(0xe5c), EVAL = A(0xe7a), RES = A(0x4e5), ROUTER = A(0xf0e);

function log(abi: Abi, address: Address, name: string, args: Record<string, unknown>, block: bigint, logIndex = 0) {
  const ev = abi.find((i): i is AbiEvent => i.type === "event" && i.name === name)!;
  const indexed = ev.inputs.filter((i) => i.indexed);
  const topics = encodeEventTopics({ abi: [ev], eventName: name, args: Object.fromEntries(indexed.map((i) => [i.name, args[i.name!]])) } as never);
  const data = encodeAbiParameters(ev.inputs.filter((i) => !i.indexed), ev.inputs.filter((i) => !i.indexed).map((i) => args[i.name!]) as never);
  return { address, topics, data, blockNumber: block, logIndex, transactionHash: (`0x${block.toString(16).padStart(62, "0")}${logIndex.toString(16).padStart(2, "0")}`) as Hex };
}

function world(head: bigint, logs: ReturnType<typeof log>[]) {
  const cursorRows = new Map<string, bigint>();
  const alerts: [string, string][] = [];
  const reads: { address: Address; from: bigint; to: bigint }[] = [];
  const deps = {
    env: loadEnv({ CONFIRMATIONS: "0" }),
    log: () => {},
    alert: async (c: string, t: string) => (alerts.push([c, t]), true),
    db: {
      select: () => ({ from: () => ({ where: async () => [...cursorRows].map(([name, block]) => ({ name, block, hash: null })) }) }),
      insert: () => ({ values: (v: { name: string; block: bigint }) => ({ onConflictDoUpdate: async () => void cursorRows.set(v.name, v.block) }) }),
    },
    clients: {
      escrow: ESCROW, evaluator: EVAL, resolverContract: RES, feeRouter: ROUTER,
      publicClient: {
        getBlockNumber: async () => head,
        getLogs: async ({ address, fromBlock, toBlock }: { address: Address; fromBlock: bigint; toBlock: bigint }) => {
          reads.push({ address, from: fromBlock, to: toBlock });
          return logs.filter((l) => l.address === address && l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
        },
      },
    },
  } as unknown as Deps;
  return { deps, alerts, cursorRows, reads, setHead: (h: bigint) => void ((deps.clients.publicClient as unknown as { getBlockNumber: () => Promise<bigint> }).getBlockNumber = async () => h) };
}

describe("admin-event monitor", () => {
  test("first run only sets the cursor at the head: no replay, no alert", async () => {
    const w = world(100n, [log(ifsoEscrowAbi as Abi, ESCROW, "CreationPaused", { paused: true }, 50n)]);
    expect(await adminWatchTick(w.deps)).toBe(0);
    expect(w.cursorRows.get("admin-watch")).toBe(100n);
    expect(w.alerts).toEqual([]);
  });

  test("every admin event on every contract raises one plain-words alert; ordinary events do not", async () => {
    const logs = [
      log(ifsoEscrowAbi as Abi, ESCROW, "OwnershipTransferStarted", { previousOwner: A(1), newOwner: A(2) }, 101n),
      log(ifsoEscrowAbi as Abi, ESCROW, "OwnershipTransferred", { previousOwner: A(1), newOwner: A(2) }, 101n, 1),
      log(ifsoEscrowAbi as Abi, ESCROW, "FeesUpdated", { creationFee: 250_000n, resolverFee: 0n }, 102n),
      log(ifsoEscrowAbi as Abi, ESCROW, "CreationPaused", { paused: true }, 103n),
      log(ifsoEscrowAbi as Abi, ESCROW, "MaxAmountUpdated", { maxAmount: 0n }, 104n),
      log(ifsoEscrowAbi as Abi, ESCROW, "Claimed", { id: 1n, recipient: A(9) }, 104n, 1), // not an admin event
      log(ifsoConditionEvaluatorAbi as Abi, EVAL, "FeedSet", { feed: A(7), allowed: true, stockToken: A(8) }, 105n),
      log(ifsoConditionEvaluatorAbi as Abi, EVAL, "ResolverSet", { resolver: A(6), allowed: false }, 105n, 1),
      log(ifsoOutcomeResolverAbi as Abi, RES, "CreatorSet", { creator: A(5), allowed: true }, 106n),
      log(ifsoOutcomeResolverAbi as Abi, RES, "BondAmountSet", { bondAmount: 50_000_000n }, 106n, 1),
      log(ifsoOutcomeResolverAbi as Abi, RES, "PanelChangeQueued", { panel: A(4), executableAt: 1234n }, 107n),
      log(ifsoOutcomeResolverAbi as Abi, RES, "PanelChanged", { panel: A(4) }, 107n, 1),
      log(feeRouterAbi as Abi, ROUTER, "RecipientsSet", { work: A(1), treasury: A(2), perks: A(3), burn: A(4) }, 108n),
    ];
    const w = world(100n, logs);
    await adminWatchTick(w.deps); // sets cursor
    w.setHead(110n);
    expect(await adminWatchTick(w.deps)).toBe(12);
    expect(w.alerts.length).toBe(12);
    expect(new Set(w.alerts.map(([c]) => c)).size).toBe(12); // distinct cause per log
    const all = w.alerts.map(([, t]) => t).join("\n");
    expect(all).toContain("PAUSED");
    expect(all).toContain("launch cap on payment size was REMOVED");
    expect(all).toContain("0.25 USDG");
    expect(all).toContain("48 hour delay");
    expect(all).toContain("being handed from");
    expect(w.cursorRows.get("admin-watch")).toBe(110n);
    // a second pass at the same head reads nothing and alerts nothing
    expect(await adminWatchTick(w.deps)).toBe(0);
    expect(w.alerts.length).toBe(12);
  });

  test("a long gap is read in steps and the cursor only moves over blocks that were read", async () => {
    const w = world(0n, []);
    await adminWatchTick(w.deps);
    w.setHead(50_000n);
    await adminWatchTick(w.deps);
    expect(w.cursorRows.get("admin-watch")).toBe(20_000n);
    await adminWatchTick(w.deps);
    expect(w.cursorRows.get("admin-watch")).toBe(40_000n);
  });

  test("with no contract configured it does nothing", async () => {
    const w = world(10n, []);
    (w.deps.clients as unknown as Record<string, unknown>).escrow = undefined;
    (w.deps.clients as unknown as Record<string, unknown>).evaluator = undefined;
    (w.deps.clients as unknown as Record<string, unknown>).resolverContract = undefined;
    (w.deps.clients as unknown as Record<string, unknown>).feeRouter = undefined;
    expect(await adminWatchTick(w.deps)).toBe(0);
    expect(w.cursorRows.size).toBe(0);
  });

  test("every listed admin event has a specific wording and exists in the contract ABI", () => {
    const abis: Record<ContractLabel, Abi> = { escrow: ifsoEscrowAbi as Abi, conditions: ifsoConditionEvaluatorAbi as Abi, questions: ifsoOutcomeResolverAbi as Abi, "fee router": feeRouterAbi as Abi };
    for (const [label, names] of Object.entries(ADMIN_EVENTS) as [ContractLabel, readonly string[]][]) {
      for (const n of names) {
        expect(abis[label].some((i) => i.type === "event" && i.name === n)).toBe(true);
        expect(describeAdminEvent(label, n, { creationFee: 0n, resolverFee: 0n, maxAmount: 1n, bondAmount: 1n, amount: 1n })).not.toStartWith("Admin event");
      }
    }
    expect(describeAdminEvent("escrow", "Something", {})).toStartWith("Admin event Something");
  });

  test("wording for the remaining cases: pause lifted, a cap, a removed feed, a pyth id, a sweep", () => {
    expect(describeAdminEvent("escrow", "CreationPaused", { paused: false })).toContain("open again");
    expect(describeAdminEvent("escrow", "MaxAmountUpdated", { maxAmount: 100_000_000n })).toContain("100 USDG");
    expect(describeAdminEvent("conditions", "FeedSet", { feed: A(1), allowed: false, stockToken: A(2) })).toContain("removed");
    expect(describeAdminEvent("conditions", "PythIdSet", { priceId: "0xab", allowed: true, stockToken: A(2) })).toContain("ALLOWED");
    expect(describeAdminEvent("fee router", "Swept", { token: A(1), to: A(2), amount: 5_000_000n })).toContain("5 USDG");
  });
});
