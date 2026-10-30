// Item 17: the withdrawal path that needs no website, bot or Ifso server. Each CLI command is run against a private
// anvil (port 8946, contracts deployed by the shared harness) and the calldata it PRINTS is sent from a plain wallet,
// exactly as a user would with cast. No database, no Redis, no app server is started.
// Skips when anvil or the forge artifacts are missing.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { ifsoEscrowAbi, usdgAbi } from "../src/abi";
import { buildClaimUrl, linkKeyAddress } from "../src/core/link";
import { Status } from "../src/core/types";
import { runCli } from "../scripts/ifso-cli";

process.env.IFSO_TEST_ANVIL_PORT = "8946"; // private port for this suite; the harness reads it at import time
const h = await import("./helpers/chain");

setDefaultTimeout(120_000);

describe.skipIf(!h.haveAnvil())("ifso-cli on anvil (port 8946)", () => {
  let chain: Awaited<ReturnType<typeof h.bootChain>>;

  beforeAll(async () => {
    chain = await h.bootChain();
  });
  afterAll(() => chain?.stop());

  const base = () => ["--rpc", chain.rpc, "--escrow", chain.escrow];
  async function cli(args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli([...args, ...base()], { out: (s) => out.push(s), err: (s) => err.push(s) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }
  type Printed = { to: Address; data: Hex; value: string; fn: string; castCommand: string };
  async function call(args: string[]): Promise<Printed> {
    const r = await cli([...args, "--json"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    return JSON.parse(r.out) as Printed;
  }
  /** What the user does with their own wallet: send the printed to / data / value. */
  async function send(from: typeof chain.alice, c: Printed) {
    const w = chain.wallet(from) as unknown as { sendTransaction(a: unknown): Promise<Hex> };
    const hash = await w.sendTransaction({ to: c.to, data: c.data, value: BigInt(c.value) });
    const r = await chain.pc.waitForTransactionReceipt({ hash });
    expect(r.status).toBe("success");
  }
  const statusOf = async (id: bigint) =>
    Number(((await chain.pc.readContract({ address: chain.escrow, abi: ifsoEscrowAbi, functionName: "getEscrow", args: [id] })) as { status: number }).status);

  test("refund: refused before expiry, then a stranger sends it and the sender gets the money back", async () => {
    const t = await chain.now();
    const id = await chain.create(chain.sender, { condition: h.approveCondition(chain.bob.address), expiry: t + 7200n });
    const early = await cli(["refund", id.toString()]);
    expect(early.code).toBe(1);
    expect(early.err).toContain("not refundable yet");
    await chain.warpTo(t + 7300n);
    const c = await call(["refund", id.toString()]);
    expect(c.fn).toBe("refund(uint256,bool,bool)");
    expect(c.castCommand).toContain("cast send");
    const before = await chain.balance(chain.sender.address);
    await send(chain.bob, c); // not the sender: anyone may call it
    expect(await statusOf(id)).toBe(Status.RETURNED);
    expect((await chain.balance(chain.sender.address)) - before).toBe(20_000_000n);
    const again = await cli(["refund", id.toString()]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("already finished");
  });

  test("refund --alt-sender pays the alternate address", async () => {
    const t = await chain.now();
    const id = await chain.create(chain.sender, { condition: h.approveCondition(chain.bob.address), expiry: t + 3600n, altRefundTo: chain.bob.address });
    await chain.warpTo(t + 3700n);
    const before = await chain.balance(chain.bob.address);
    await send(chain.alice, await call(["refund", id.toString(), "--alt-sender"]));
    expect((await chain.balance(chain.bob.address)) - before).toBe(20_000_000n);
  });

  test("settle TIME: not before the date, then the printed call pays the recipient", async () => {
    const t = await chain.now();
    const deadline = t + 3600n;
    const id = await chain.create(chain.sender, { condition: h.timeCondition(deadline), expiry: deadline + 86400n });
    const early = await cli(["settle", id.toString()]);
    expect(early.code).toBe(1);
    expect(early.err).toContain("date has not been reached");
    await chain.warpTo(deadline + 10n);
    const before = await chain.balance(chain.alice.address);
    await send(chain.bob, await call(["settle", id.toString()]));
    expect(await statusOf(id)).toBe(Status.RELEASED);
    expect((await chain.balance(chain.alice.address)) - before).toBe(20_000_000n);
  });

  test("settle PRICE at the deadline across a phase change (the keeper's round finder, reused)", async () => {
    const feed = await chain.newFeed();
    const t = await chain.now();
    const deadline = t + 3600n;
    await chain.push(feed, 90_00000000n, deadline - 7200n);
    const rLast = await chain.push(feed, 95_00000000n, deadline - 2000n);
    await chain.newPhase(feed);
    await chain.push(feed, 120_00000000n, deadline + 1500n);
    const id = await chain.create(chain.sender, {
      condition: h.priceCondition({ feed, threshold: 100_00000000n, deadline, maxStale: 600, holdWindow: 86400 }),
      expiry: deadline + 3n * 86400n,
    });
    const early = await cli(["settle", id.toString()]);
    expect(early.code).toBe(1);
    await chain.warpTo(deadline + 2000n);
    const c = await call(["settle", id.toString()]);
    expect(c.data.toLowerCase()).toContain(rLast.toString(16).padStart(64, "0").slice(-20));
    const before = await chain.balance(chain.alice.address);
    await send(chain.bob, c);
    expect(await statusOf(id)).toBe(Status.RELEASED);
    expect((await chain.balance(chain.alice.address)) - before).toBe(20_000_000n);
  });

  test("settle PRICE that misses on a phase-0 feed returns the money to the sender", async () => {
    const feed = await chain.newFeed({ phase0: true, startAgg: 190n });
    const t = await chain.now();
    const deadline = t + 3600n;
    await chain.push(feed, 80_00000000n, deadline - 100n);
    await chain.push(feed, 150_00000000n, deadline + 100n);
    const id = await chain.create(chain.sender, {
      condition: h.priceCondition({ feed, threshold: 100_00000000n, deadline, maxStale: 600, holdWindow: 86400 }),
      expiry: deadline + 3n * 86400n,
    });
    await chain.warpTo(deadline + 500n);
    const before = await chain.balance(chain.sender.address);
    await send(chain.bob, await call(["settle", id.toString()]));
    expect(await statusOf(id)).toBe(Status.RETURNED);
    expect((await chain.balance(chain.sender.address)) - before).toBe(20_000_000n);
  });

  test("settle PRICE touch: proves the first round that crosses inside the window", async () => {
    const feed = await chain.newFeed();
    const t = await chain.now();
    const deadline = t + 7200n;
    await chain.push(feed, 80_00000000n, t - 100n);
    const id = await chain.create(chain.sender, {
      condition: h.priceCondition({ feed, threshold: 100_00000000n, deadline, mode: 1, start: 0n }),
      expiry: deadline + 86400n,
    });
    const quiet = await cli(["settle", id.toString()]);
    expect(quiet.code).toBe(1);
    expect(quiet.err).toContain("not touched");
    await chain.push(feed, 90_00000000n, t + 600n);
    await chain.push(feed, 110_00000000n, t + 900n);
    const before = await chain.balance(chain.alice.address);
    await send(chain.bob, await call(["settle", id.toString()]));
    expect(await statusOf(id)).toBe(Status.RELEASED);
    expect((await chain.balance(chain.alice.address)) - before).toBe(20_000_000n);
  });

  test("claim: the link's secret fragment binds the caller's address, then settle pays that address", async () => {
    const secret = Uint8Array.from({ length: 32 }, (_, i) => i + 7);
    const t = await chain.now();
    const deadline = t + 3600n;
    const id = await chain.create(chain.sender, { linkKey: linkKeyAddress(secret), condition: h.timeCondition(deadline), expiry: deadline + 86400n });
    const url = buildClaimUrl("https://example.invalid", id, secret);
    const wrong = buildClaimUrl("https://example.invalid", id, Uint8Array.from({ length: 32 }, () => 9));
    // review R2-I7: the link (it holds the secret) is read from a file or stdin, never from the command line
    const dir = mkdtempSync(join(tmpdir(), "ifso-cli-link-"));
    const file = (name: string, body: string) => (writeFileSync(join(dir, name), body), join(dir, name));
    const onArgv = await cli(["claim", id.toString(), url, "--recipient", chain.bob.address]);
    expect(onArgv.code).toBe(1);
    expect(onArgv.err).toContain("--link-file");
    const bad = await cli(["claim", id.toString(), "--link-file", file("wrong.txt", wrong + "\n"), "--recipient", chain.bob.address]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("does not match");
    const viaStdin: string[] = [];
    const sc = await runCli(["claim", id.toString(), "--link-file", "-", "--recipient", chain.bob.address, "--json", ...base()], { out: (s) => viaStdin.push(s), err: (s) => viaStdin.push(s), readStdin: async () => url + "\n" });
    expect(sc).toBe(0);
    expect((JSON.parse(viaStdin.join("\n")) as Printed).fn).toBe("claim(uint256,address,bytes)");
    const c = await call(["claim", id.toString(), "--link-file", file("link.txt", url), "--recipient", chain.bob.address]);
    expect(c.fn).toBe("claim(uint256,address,bytes)");
    expect(c.castCommand).not.toContain(Buffer.from(secret).toString("hex")); // the secret never appears in the output
    await send(chain.alice, c); // anyone may submit; the signature fixes the recipient
    const e = (await chain.pc.readContract({ address: chain.escrow, abi: ifsoEscrowAbi, functionName: "getEscrow", args: [id] })) as { recipient: Address };
    expect(e.recipient).toBe(chain.bob.address);
    await chain.warpTo(deadline + 10n);
    const before = await chain.balance(chain.bob.address);
    await send(chain.alice, await call(["settle", id.toString()]));
    expect((await chain.balance(chain.bob.address)) - before).toBe(20_000_000n);
    const twice = await cli(["claim", id.toString(), "--link-file", join(dir, "link.txt"), "--recipient", chain.alice.address]);
    expect(twice.code).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("claim-void: pays a voided challenge side that is still held, only once (review R2-I2)", async () => {
    const blockAbi = [{ type: "function", name: "setBlocked", stateMutability: "nonpayable", inputs: [{ name: "who", type: "address" }, { name: "b", type: "bool" }], outputs: [] }] as const;
    const t = await chain.now();
    const id = await chain.create(chain.sender, { condition: h.approveCondition(chain.deployer.address), recipient: chain.alice.address, twoSided: true, counterAmount: 15_000_000n, acceptBy: t + 1800n, expiry: t + 7200n });
    await chain.mint(chain.alice.address, 20);
    await chain.write(chain.alice, chain.usdg, usdgAbi as never, "approve", [chain.escrow, 2n ** 255n]);
    await chain.write(chain.alice, chain.escrow, ifsoEscrowAbi as never, "accept", [id, "0x", chain.alice.address]);
    const notYet = await cli(["claim-void", id.toString()]);
    expect(notYet.code).toBe(1);
    expect(notYet.err).toContain("not VOIDED");
    await chain.write(chain.deployer, chain.usdg, blockAbi as never, "setBlocked", [chain.alice.address, true]);
    await chain.warpTo(t + 7300n);
    await send(chain.bob, await call(["refund", id.toString()])); // VOID: the acceptor side cannot be paid, so it is held
    expect(await statusOf(id)).toBe(Status.VOIDED);
    expect((await cli(["claim-void", id.toString(), "--side", "sender"])).err).toContain("already paid");
    await chain.write(chain.deployer, chain.usdg, blockAbi as never, "setBlocked", [chain.alice.address, false]);
    const c = await call(["claim-void", id.toString()]); // the one owed side is picked by itself
    expect(c.fn).toBe("claimVoid(uint256,bool,bool)");
    const before = await chain.balance(chain.alice.address);
    await send(chain.bob, c);
    expect((await chain.balance(chain.alice.address)) - before).toBe(15_000_000n);
    expect((await cli(["claim-void", id.toString()])).err).toContain("both sides were already paid");
  });

  test("status and list read the chain logs", async () => {
    const t = await chain.now();
    const id = await chain.create(chain.alice, { condition: h.approveCondition(chain.bob.address), expiry: t + 99_000n });
    const s = JSON.parse((await cli(["status", id.toString(), "--json"])).out);
    expect(s.status).toBe("open");
    expect(s.kind).toBe("approve");
    expect(s.refundableNow).toBe(false);
    expect(s.amount).toBe("20 USDG");
    const l = JSON.parse((await cli(["list", "--sender", chain.alice.address, "--json"])).out);
    expect(l.escrows.map((x: { id: string }) => x.id)).toContain(id.toString());
    const none = JSON.parse((await cli(["list", "--sender", "0x00000000000000000000000000000000000000AA", "--json"])).out);
    expect(none.escrows).toEqual([]);
    expect((await cli(["status", "999999999"])).code).toBe(1);
  });

  test("as a real process: bun scripts/ifso-cli.ts reads deployments/<chainId>.json and needs nothing else", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ifso-cli-"));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "31337.json"), JSON.stringify({ chainId: 31337, deployBlockAtSimulation: 0, contracts: { IfsoEscrow: { address: chain.escrow } } }));
      const t = await chain.now();
      const id = await chain.create(chain.sender, { condition: h.approveCondition(chain.bob.address), expiry: t + 50_000n });
      const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/ifso-cli.ts"), "status", id.toString(), "--rpc", chain.rpc, "--deployments", dir, "--json"], {
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, // no DATABASE_URL, no REDIS_URL, nothing of the app
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(p.exitCode).toBe(0);
      expect(JSON.parse(p.stdout.toString()).escrow.toLowerCase()).toBe(chain.escrow.toLowerCase());
      const missing = Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/ifso-cli.ts"), "status", "1", "--rpc", chain.rpc], { env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe", cwd: dir });
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr.toString()).toContain("no escrow address");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
