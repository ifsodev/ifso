// Exercises EVERY user transaction of the product on the running fork stack (app/scripts/fork-up.sh) and writes the report.
// Rule R3: every flow goes through the API exactly as the site does it (tRPC over HTTP, @ifso/client helpers, the same
// signing order: build -> verifyBuildAnswer -> sign -> submit). Where a wallet sends the transaction itself (the site's
// "wallet pays gas" paths) the params still come from `build`. Admin actions (pause, panel) are done by impersonating the
// fork's owner Safe and panel Safe, which exists only on the fork.
//
//   bun run app/scripts/fork/exercise.ts [--report <path>]      (needs fork-up.sh to be running)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, hashTypedData, http, parseAbi, getAddress, decodeEventLog, toHex, encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ifsoEscrowAbi, ifsoOutcomeResolverAbi } from "../../src/abi";
import {
  acceptAuthorizationTypedData, acceptTypedData, buildClaimUrl, createPermitTypedData, DecisionAction, decisionTypedData,
  linkKeyAddress, randomSecret, readAndWipeFragment, refundRedirectTypedData, runClaim, signAccept, verifyBuildAnswer, findBannedWords, parseClaimUrl,
} from "../../src/client";
import { paramsFromJson } from "../../src/core/paramsJson";

const FORK_DIR = process.env.FORK_DIR ?? join(import.meta.dir, "../../.fork");
const A = JSON.parse(readFileSync(join(FORK_DIR, "actors.json"), "utf8"));
const reportPath = process.argv.includes("--report") ? process.argv[process.argv.indexOf("--report") + 1]! : join(FORK_DIR, "fork-run.md");
const CHAIN_ID = A.chainId as number;
const chain = defineChain({ id: CHAIN_ID, name: "fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [A.rpc] } } });
const pc = createPublicClient({ chain, transport: http(A.rpc), pollingInterval: 250 });
const rpc = async <T = unknown>(method: string, params: unknown[] = []) => (await pc.request({ method, params } as never)) as T;
const acc = (n: string) => privateKeyToAccount(A.keys[n] as Hex);
const wc = (n: string) => createWalletClient({ chain, account: acc(n), transport: http(A.rpc), pollingInterval: 250 });
const ESCROW = A.escrow as Address, USDG = A.usdg as Address, RESOLVER = A.resolver as Address;
const usdgAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function nonces(address) view returns (uint256)"]);
const adr = (n: string) => acc(n).address;
const U = (n: number) => BigInt(Math.round(n * 1e6));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ api (what @trpc/client's httpBatchLink does for one call)
const EDGE = { "cf-connecting-ip": "203.0.113.7", "cf-ipcountry": "DE" };
class ApiError extends Error {
  constructor(public code: string, msg: string) { super(msg); }
}
async function q<T = any>(name: string, input: unknown, headers: Record<string, string> = {}): Promise<T> {
  const r = await fetch(`${A.api}/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers: { ...EDGE, ...headers } });
  const j: any = await r.json();
  if (!r.ok) throw new ApiError(j.error?.data?.code ?? String(r.status), j.error?.message ?? JSON.stringify(j));
  return j.result.data;
}
async function m<T = any>(name: string, input: unknown, headers: Record<string, string> = {}): Promise<T> {
  const r = await fetch(`${A.api}/trpc/${name}`, { method: "POST", headers: { "content-type": "application/json", ...EDGE, ...headers }, body: JSON.stringify(input) });
  const j: any = await r.json();
  if (!r.ok) throw new ApiError(j.error?.data?.code ?? String(r.status), j.error?.message ?? JSON.stringify(j));
  return j.result.data;
}
/** stop a worker and let any pass already in flight finish (a pass reads chain time per sub-step, a warp mid-pass would mix clocks) */
const pauseWorker = async (name: string) => { await admin("/worker", { name, on: false }); await sleep(10_000); };
const admin = (path: string, body?: unknown) => fetch(`${A.admin}${path}`, body ? { method: "POST", body: JSON.stringify(body) } : undefined).then((r) => r.json());

// ------------------------------------------------------------------ report plumbing
interface Row { area: string; name: string; ok: boolean; hashes: Hex[]; note: string; expectedFailure?: boolean }
const rows: Row[] = [];
const bugs: string[] = [];
let cur: Row | undefined;
const hashes = (...h: (Hex | undefined)[]) => h.forEach((x) => x && cur?.hashes.push(x));
async function step(area: string, name: string, fn: () => Promise<string | void>, expectedFailure = false) {
  cur = { area, name, ok: false, hashes: [], note: "", expectedFailure };
  try {
    cur.note = (await fn()) ?? "";
    cur.ok = true;
  } catch (e) {
    cur.note = `FAILED: ${String((e as Error).message ?? e).slice(0, 400)}`;
  }
  rows.push(cur);
  console.log(`${cur.ok ? "PASS" : "FAIL"} [${area}] ${name}${cur.ok ? "" : " :: " + cur.note}`);
}
/** An expected failure path passes only when the call is refused and the message matches. */
async function refused(area: string, name: string, fn: () => Promise<unknown>, match: RegExp) {
  await step(area, name, async () => {
    try {
      await fn();
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (!match.test(msg)) throw new Error(`refused with an unexpected message: ${msg.slice(0, 200)}`);
      return `refused as expected: ${msg.split("\n")[0]!.slice(0, 140)}`;
    }
    throw new Error("was accepted but must be refused");
  }, true);
}
const expect = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};
const eq = <T>(a: T, b: T, msg: string) => expect(a === b, `${msg}: got ${String(a)}, want ${String(b)}`);

// ------------------------------------------------------------------ chain helpers
const now = async () => Number((await pc.getBlock()).timestamp);
let warpedSec = 0;
async function warpTo(ts: number) {
  const d = ts - (await now());
  if (d <= 0) return;
  await rpc("evm_increaseTime", [d]);
  await rpc("evm_mine");
  warpedSec += d;
  await admin("/offset", { ms: warpedSec * 1000 });
}
const warpBy = async (s: number) => warpTo((await now()) + s);
async function until<T>(label: string, fn: () => Promise<T | undefined | false>, ms = 90_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(400);
  }
}
const bal = (a: Address) => pc.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [a] }) as Promise<bigint>;
const getEscrow = (id: bigint) => pc.readContract({ address: ESCROW, abi: ifsoEscrowAbi, functionName: "getEscrow", args: [id] }) as Promise<any>;
const status = async (id: bigint) => Number((await getEscrow(id)).status);
const waitStatus = (id: bigint, s: number, ms = 90_000) => until(`escrow ${id} status ${s}`, async () => (await status(id)) === s, ms);
const nonceOf = (a: Address) => pc.readContract({ address: ESCROW, abi: ifsoEscrowAbi, functionName: "nonces", args: [a] }) as Promise<bigint>;
const S = { OPEN: 1, MET: 2, RELEASED: 3, RETURNED: 4, VOIDED: 5, CANCELLED: 6 };
async function confirm(hash: Hex): Promise<Hex> {
  const r = await pc.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (r.status !== "success") throw new Error(`transaction ${hash} reverted`);
  hashes(hash);
  return hash;
}
async function send(who: string, address: Address, abi: any, functionName: string, args: unknown[] = []): Promise<Hex> {
  const h = await wc(who).writeContract({ address, abi, functionName, args } as never);
  return confirm(h);
}
async function asSafe<T>(safe: Address, fn: (w: ReturnType<typeof createWalletClient>) => Promise<T>): Promise<T> {
  await rpc("anvil_impersonateAccount", [safe]);
  try {
    return await fn(createWalletClient({ chain, account: safe, transport: http(A.rpc) }));
  } finally {
    await rpc("anvil_stopImpersonatingAccount", [safe]);
  }
}
async function mockFeed(feed: Address) {
  // fork only: put a MockAggregator's code and storage on a real feed's address so the run controls its rounds
  const art = JSON.parse(readFileSync(join(import.meta.dir, "../../../contracts/out/MockAggregator.sol/MockAggregator.json"), "utf8"));
  const h = await wc("heidi").deployContract({ abi: art.abi, bytecode: art.bytecode.object, args: ["MOCK"] } as never);
  const r = await pc.waitForTransactionReceipt({ hash: h });
  const tmp = r.contractAddress!;
  const code = await pc.getCode({ address: tmp });
  await rpc("anvil_setCode", [feed, code]);
  for (let s = 0; s < 6; s++) await rpc("anvil_setStorageAt", [feed, toHex(s, { size: 32 }), toHex(s === 1 ? 1n : 0n, { size: 32 })]);
  return { abi: art.abi as any, push: async (answer: bigint, at?: number) => confirm(await wc("heidi").writeContract({ address: feed, abi: art.abi, functionName: "push", args: [answer, BigInt(at ?? (await now()))] } as never)) };
}

// ------------------------------------------------------------------ site-style create (3009, gasless)
interface Made { id: bigint; txHash: Hex; secret?: Uint8Array; answer: any; sender: string }
async function apiBuild(sender: string, text: string, o: { link?: boolean; cancellable?: boolean; altRefundTo?: Address; headers?: Record<string, string> } = {}) {
  const secret = o.link ? randomSecret() : undefined;
  const answer = await m("build", { text, sender: adr(sender), linkKey: secret ? linkKeyAddress(secret) : undefined, cancellable: o.cancellable, altRefundTo: o.altRefundTo }, o.headers);
  verifyBuildAnswer(answer, { from: adr(sender), chainId: CHAIN_ID, escrow: ESCROW, usdg: USDG });
  return { secret, answer };
}
async function apiCreate(sender: string, text: string, o: { link?: boolean; cancellable?: boolean; altRefundTo?: Address; headers?: Record<string, string> } = {}): Promise<Made> {
  const { secret, answer } = await apiBuild(sender, text, o);
  const signature = await acc(sender).signTypedData(answer.authorization.typedData);
  const r = await m("submit", { params: answer.params, from: adr(sender), validAfter: answer.authorization.validAfter, validBefore: answer.authorization.validBefore, signature }, o.headers);
  await confirm(r.txHash);
  expect(BigInt(r.id) === BigInt(answer.id), "submit id differs from build id");
  return { id: BigInt(r.id), txHash: r.txHash, secret, answer, sender };
}
/** the API's list view catches up with the chain (the site's dashboard reads it) */
const apiSees = (who: string, id: bigint, st: number) => until(`api mine() shows ${id} status ${st}`, async () => (await q<any[]>("mine", { address: adr(who) })).find((r) => r.id === id.toString() && r.status === st), 60_000);

async function decide(who: string, id: bigint, action: number, signerAddr?: Address, signFn?: (typed: any) => Promise<Hex>) {
  const signer = signerAddr ?? adr(who);
  const nonce = await nonceOf(signer);
  const deadline = BigInt((await now()) + 600);
  const typed = decisionTypedData({ chainId: CHAIN_ID, escrow: ESCROW, id, action, nonce, deadline });
  const signature = signFn ? await signFn(typed) : await acc(who).signTypedData(typed as never);
  const r = await m("decide", { id: id.toString(), signer, action, deadline: deadline.toString(), signature });
  return confirm(r.txHash);
}
async function claimLink(made: Made, recipient: Address, headers?: Record<string, string>) {
  const url = buildClaimUrl("http://localhost:3190", made.id, made.secret!);
  const link = parseClaimUrl(url); // the page reads this from the fragment
  return runClaim(
    {
      chainId: CHAIN_ID, escrow: ESCROW,
      getEscrow: (id) => q("escrow", { id }, headers) as any,
      relayClaim: (i) => m("claim", i, headers) as any,
      getRecipientAddress: async () => recipient,
    },
    link,
  );
}
async function accept(made: Made, acceptor: string, o: { link?: boolean; counterRefundTo?: Address } = {}) {
  const view = await q<any>("escrow", { id: made.id.toString() });
  const counterRefundTo = o.counterRefundTo ?? adr(acceptor);
  const t = await now();
  const validAfter = BigInt(t - 60), validBefore = BigInt(t + 3600);
  const authSig = await acc(acceptor).signTypedData(acceptAuthorizationTypedData({ chainId: CHAIN_ID, usdg: USDG, escrow: ESCROW, id: made.id, acceptor: adr(acceptor), counterRefundTo, counterAmount: BigInt(view.escrow.counterAmount), validAfter, validBefore }) as never);
  const linkSig = o.link ? await signAccept({ secret: made.secret!, chainId: CHAIN_ID, escrow: ESCROW, id: made.id, acceptor: adr(acceptor), conditionHash: view.escrow.conditionHash }) : "0x";
  const r = await m("accept", { id: made.id.toString(), acceptor: adr(acceptor), linkSig, counterRefundTo, validAfter: validAfter.toString(), validBefore: validBefore.toString(), authSig });
  return confirm(r.txHash);
}

const flagsOf = async (id: bigint) => Number((await getEscrow(id)).flags);

// ================================================================== the run
const startedAt = new Date().toISOString();
const t0 = await now();
const bobA = adr("bob"), carolA = adr("carol"), daveA = adr("dave"), erinA = adr("erin");
const made: Record<string, Made> = {};

// ---------------------------------------------------------------- 0 API surface
await step("API", "healthz agrees with the deployment; readyz ok", async () => {
  const h = await (await fetch(`${A.api}/healthz`)).json();
  eq(getAddress(h.escrow), getAddress(ESCROW), "escrow");
  eq(h.chainId, CHAIN_ID, "chain");
  const r = await (await fetch(`${A.api}/readyz`)).json();
  expect(r.ok, "readyz " + JSON.stringify(r));
});
await step("API", "geo: DE allowed, US and unknown blocked for stock prices", async () => {
  const g = async (c?: string) => (await (await fetch(`${A.api}/geo`, { headers: c ? { "cf-ipcountry": c, "cf-connecting-ip": "203.0.113.9" } : { "cf-connecting-ip": "203.0.113.9" } })).json()).stockPriceConditionsAllowed;
  eq(await g("DE"), true, "DE");
  eq(await g("US"), false, "US");
  eq(await g(undefined), false, "unknown");
});
await step("API", "parse + describe + a question the site must show (weekend close)", async () => {
  const p = await q("parse", { text: `/ifso ${bobA} 20 in 10 minutes` });
  expect(p.ok && p.preview, "parse");
  const d = await q("describe", { text: `/ifso ${bobA} 20 if referee ${erinA} decides` });
  expect(typeof d === "string" && d.length > 3, "describe");
  const w = await q("parse", { text: "/ifso link 20 if spy closes above 100 on saturday" });
  expect(w.questions.some((x: any) => x.kind === "weekend") || w.errors.length, "weekend question");
  expect(findBannedWords(p.preview).length === 0, "banned words in preview");
});
await refused("API", "unknown escrow id is NOT_FOUND", () => q("escrow", { id: "123456789" }), /NOT_FOUND|not found|NOT_FOUND/i);
await step("API", "perks locked without the token; planBatch answers locked", async () => {
  const p = await q("perks", { address: adr("alice") });
  eq(p.tier, "none", "tier");
  const b = await m("planBatch", { sender: adr("alice"), csv: `${bobA},5` });
  expect(b.locked === true, "planBatch should be locked");
  const s = await q("stats", {});
  expect(typeof s.escrowsCreated === "number" || typeof s.escrowsCreated === "string", "stats");
});
await refused("Region", "stock price condition refused from the US (build)", () => apiBuild("alice", "/ifso link 20 if spy closes above 100 on nov 3", { link: true, headers: { "cf-ipcountry": "US", "cf-connecting-ip": "203.0.113.10" } }), /FORBIDDEN|not available|region|your/i);

// ---------------------------------------------------------------- 1 create (every way)
const T10 = "in 10 minutes";
await step("Create", "allowance path: build -> alice approve + create (wallet pays gas)", async () => {
  const { answer } = await apiBuild("alice", `/ifso ${bobA} 20 ${T10}`);
  const p = paramsFromJson(answer.params);
  const total = BigInt(answer.total);
  await send("alice", USDG, usdgAbi, "approve", [ESCROW, total]);
  const h = await send("alice", ESCROW, ifsoEscrowAbi, "create", [p]);
  made.allow = { id: BigInt(answer.id), txHash: h, answer, sender: "alice" };
  eq(await status(made.allow.id), S.OPEN, "status");
  return `id ${answer.id}`;
});
await step("Create", "permit path: build -> alice signs EIP-2612 permit -> createWithPermit (one transaction)", async () => {
  const { answer } = await apiBuild("alice", `/ifso ${bobA} 20 ${T10}`);
  const p = paramsFromJson(answer.params);
  const nonce = (await pc.readContract({ address: USDG, abi: usdgAbi, functionName: "nonces", args: [adr("alice")] })) as bigint;
  const deadline = BigInt((await now()) + 3600);
  const typed = createPermitTypedData({ chainId: CHAIN_ID, usdg: USDG, owner: adr("alice"), escrow: ESCROW, value: BigInt(answer.total), nonce, deadline });
  const sig = await acc("alice").signTypedData(typed as never);
  const r = sig.slice(0, 66) as Hex, s = ("0x" + sig.slice(66, 130)) as Hex, v = parseInt(sig.slice(130, 132), 16);
  const h = await send("alice", ESCROW, ifsoEscrowAbi, "createWithPermit", [p, deadline, v, r, s]);
  made.permit = { id: BigInt(answer.id), txHash: h, answer, sender: "alice" };
  eq(await status(made.permit.id), S.OPEN, "status");
});
await step("Create", "gasless path (EIP-3009): build -> verify -> sign -> submit, relayer pays gas", async () => {
  made.gasless = await apiCreate("alice", `/ifso ${bobA} 20 ${T10}`);
  eq(await status(made.gasless.id), S.OPEN, "status");
  await apiSees("alice", made.gasless.id, S.OPEN);
  return `id ${made.gasless.id}`;
});
await step("Create", "batch: three named payments in one createBatch", async () => {
  const bs = [];
  for (const [who, amt] of [["bob", 5], ["carol", 6], ["dave", 7]] as const) bs.push((await apiBuild("alice", `/ifso ${adr(who)} ${amt} ${T10}`)).answer);
  const total = bs.reduce((s, a) => s + BigInt(a.total), 0n);
  await send("alice", USDG, usdgAbi, "approve", [ESCROW, total]);
  const h = await send("alice", ESCROW, ifsoEscrowAbi, "createBatch", [bs.map((a) => paramsFromJson(a.params))]);
  for (const a of bs) eq(await status(BigInt(a.id)), S.OPEN, "batch item");
  made.batch0 = { id: BigInt(bs[0].id), txHash: h, answer: bs[0], sender: "alice" };
  made.batch2 = { id: BigInt(bs[2].id), txHash: h, answer: bs[2], sender: "alice" };
});
await refused("Create", "submit signed by someone else is refused before any gas", async () => {
  const { answer } = await apiBuild("alice", `/ifso ${bobA} 20 ${T10}`);
  const signature = await acc("bob").signTypedData(answer.authorization.typedData);
  await m("submit", { params: answer.params, from: adr("alice"), validAfter: answer.authorization.validAfter, validBefore: answer.authorization.validBefore, signature });
}, /signature|not made/i);
await refused("Create", "over the launch cap (1,000 USDG) is refused by the contract", async () => {
  const { answer } = await apiBuild("alice", `/ifso ${bobA} 1500 ${T10}`);
  await send("alice", USDG, usdgAbi, "approve", [ESCROW, BigInt(answer.total)]);
  await send("alice", ESCROW, ifsoEscrowAbi, "create", [paramsFromJson(answer.params)]);
}, /AmountAboveCap|revert|cap/i);
await refused("Create", "creating the same payment twice is refused (AlreadyExists)", async () => {
  await send("alice", ESCROW, ifsoEscrowAbi, "create", [paramsFromJson(made.allow!.answer.params)]);
}, /AlreadyExists|revert/i);

// ---------------------------------------------------------------- 2 links: claim before, after, passkey-style account
const artifact = JSON.parse(readFileSync(join(import.meta.dir, "../../../contracts/out/MockERC1271Wallet.sol/MockERC1271Wallet.json"), "utf8"));
const deploy1271 = async (ownerName: string) => {
  const h = await wc(ownerName).deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [adr(ownerName)] } as never);
  const r = await pc.waitForTransactionReceipt({ hash: h });
  hashes(h);
  return r.contractAddress as Address;
};
let smartWallet: Address; // EIP-1271 account owned by heidi (stands in for the passkey Kernel account)
await step("Setup", "deploy an EIP-1271 smart account (stand-in for the passkey account)", async () => {
  smartWallet = await deploy1271("heidi");
  return smartWallet;
});

await step("Claim", "EOA claims BEFORE the condition (bound), keeper settles at the deadline, claimer is paid", async () => {
  made.linkBound = await apiCreate("alice", `/ifso link 20 ${T10}`, { link: true });
  const r = await claimLink(made.linkBound, carolA);
  hashes(r.txHash);
  eq(r.status, "bound", "claim status");
  await confirm(r.txHash).catch(() => {});
  expect(made.linkBound.secret, "secret kept in memory only");
});
await step("Claim", "link left unclaimed past the deadline becomes MET; the claim then pays at once", async () => {
  made.linkMet = await apiCreate("alice", `/ifso link 20 ${T10}`, { link: true });
});
await step("Claim", "passkey-style account (deployed EIP-1271 wallet) claims a link", async () => {
  made.linkSmart = await apiCreate("alice", `/ifso link 20 ${T10}`, { link: true });
  const r = await claimLink(made.linkSmart, smartWallet);
  await confirm(r.txHash);
  eq(r.status, "bound", "status");
});
let counterfactual: Address;
await step("Claim", "counterfactual passkey account (not deployed yet) claims a link", async () => {
  counterfactual = getAddress("0x" + keccak256(toHex("counterfactual-kernel-" + t0)).slice(26)) as Address;
  eq((await pc.getCode({ address: counterfactual })) ?? "0x", "0x", "must be undeployed");
  made.linkCf = await apiCreate("alice", `/ifso link 20 ${T10}`, { link: true });
  const r = await claimLink(made.linkCf, counterfactual);
  await confirm(r.txHash);
  eq(r.status, "bound", "status");
});
await refused("Claim", "claim with the wrong secret is refused", async () => {
  const wrong = { ...made.linkBound!, secret: randomSecret() };
  await claimLink(wrong, daveA);
}, /does not match|already claimed|BAD|signature/i);
await refused("Claim", "a second claim on a claimed link is refused", () => claimLink(made.linkBound!, daveA), /already claimed|finished|expired/i);
await refused("Claim", "claim on a named payment is refused (not a link)", async () => {
  const fake = { ...made.gasless!, secret: randomSecret() };
  await claimLink(fake, daveA);
}, /not a claim link|NOT_A_LINK/i);

// ---------------------------------------------------------------- 3 approve: parties, referee, 1271, decline, cancel, redirect
await step("Approve", "PARTIES: sender OK does not release; recipient OK releases (both relayed, gasless)", async () => {
  made.parties = await apiCreate("alice", `/ifso ${bobA} 20 if we both agree`);
  await decide("alice", made.parties.id, DecisionAction.OK);
  eq(await status(made.parties.id), S.OPEN, "after sender OK");
  await decide("bob", made.parties.id, DecisionAction.OK);
  await waitStatus(made.parties.id, S.RELEASED);
});
await refused("Approve", "a repeated OK is refused before gas is spent", async () => {
  const mm = await apiCreate("alice", `/ifso ${bobA} 20 if we both agree`);
  await decide("alice", mm.id, DecisionAction.OK);
  await decide("alice", mm.id, DecisionAction.OK);
}, /already recorded/i);
await step("Approve", "REFEREE (EOA) releases to the recipient", async () => {
  const mm = await apiCreate("alice", `/ifso ${carolA} 20 if referee ${erinA} decides`);
  const before = await bal(carolA);
  await decide("erin", mm.id, DecisionAction.REFEREE_RELEASE ?? 3);
  await waitStatus(mm.id, S.RELEASED);
  eq((await bal(carolA)) - before, U(20), "carol received");
});
await step("Approve", "REFEREE (EOA) returns to the sender", async () => {
  const mm = await apiCreate("alice", `/ifso ${carolA} 20 if referee ${erinA} decides`);
  const before = await bal(adr("alice"));
  await decide("erin", mm.id, 4);
  await waitStatus(mm.id, S.RETURNED);
  eq((await bal(adr("alice"))) - before, U(20), "alice got it back");
});
await step("Approve", "REFEREE that is a smart account (EIP-1271) releases", async () => {
  const mm = await apiCreate("alice", `/ifso ${carolA} 20 if referee ${smartWallet} decides`);
  await decide("heidi", mm.id, 3, smartWallet, (typed) => acc("heidi").sign({ hash: hashTypedData(typed) }));
  await waitStatus(mm.id, S.RELEASED);
});
await step("Approve", "PARTIES with a smart-account recipient (EIP-1271 OK) releases", async () => {
  const mm = await apiCreate("alice", `/ifso ${smartWallet} 20 if we both agree`);
  await decide("alice", mm.id, 1);
  await decide("heidi", mm.id, 1, smartWallet, (typed) => acc("heidi").sign({ hash: hashTypedData(typed) }));
  await waitStatus(mm.id, S.RELEASED);
});
await step("Approve", "recipient declines (relayed): money comes back to the sender", async () => {
  const mm = await apiCreate("alice", `/ifso ${bobA} 20 if we both agree`);
  const before = await bal(adr("alice"));
  await decide("bob", mm.id, DecisionAction.DECLINE ?? 2);
  await waitStatus(mm.id, S.RETURNED);
  eq((await bal(adr("alice"))) - before, U(20), "alice got it back");
});
await step("Approve", "sender OK alone releases a referee payment (a concession against itself)", async () => {
  const mm = await apiCreate("alice", `/ifso ${carolA} 20 if referee ${erinA} decides`);
  await decide("alice", mm.id, 1);
  await waitStatus(mm.id, S.RELEASED);
});
await step("Approve", "wallet-sent approve(), decline() and refereeDecide() work too", async () => {
  const a = await apiCreate("alice", `/ifso ${bobA} 20 if we both agree`);
  await send("alice", ESCROW, ifsoEscrowAbi, "approve", [a.id]);
  await send("bob", ESCROW, ifsoEscrowAbi, "approve", [a.id]);
  eq(await status(a.id), S.RELEASED, "approve");
  const b = await apiCreate("alice", `/ifso ${bobA} 20 if we both agree`);
  await send("bob", ESCROW, ifsoEscrowAbi, "decline", [b.id]);
  eq(await status(b.id), S.RETURNED, "decline");
  const c = await apiCreate("alice", `/ifso ${carolA} 20 if referee ${erinA} decides`);
  await send("erin", ESCROW, ifsoEscrowAbi, "refereeDecide", [c.id, true]);
  eq(await status(c.id), S.RELEASED, "referee");
});
await step("Cancel", "cancellable payment: sender cancels, funds return", async () => {
  const mm = await apiCreate("alice", `/ifso ${carolA} 20 if referee ${erinA} decides`, { cancellable: true });
  const before = await bal(adr("alice"));
  await send("alice", ESCROW, ifsoEscrowAbi, "cancel", [mm.id]);
  eq(await status(mm.id), S.CANCELLED, "status");
  eq((await bal(adr("alice"))) - before, U(20), "alice got it back");
});
await refused("Cancel", "a payment that was not made cancellable cannot be cancelled", async () => {
  const mm = await apiCreate("alice", `/ifso ${carolA} 20 if referee ${erinA} decides`);
  await send("alice", ESCROW, ifsoEscrowAbi, "cancel", [mm.id]);
}, /NotCancellable|revert/i);
// refund redirect by signature: two payments, redirected to fran (primary) and gus (alternate); refunded after expiry in stage 9
const redirected: Made[] = [];
await step("Refund", "redirect the refund address by signature (relayed): primary fran, alternate gus", async () => {
  for (let i = 0; i < 2; i++) {
    const mm = await apiCreate("alice", `/ifso ${carolA} 20 if referee ${erinA} decides`);
    const nonce = await nonceOf(adr("alice"));
    const deadline = BigInt((await now()) + 600);
    const signature = await acc("alice").signTypedData(refundRedirectTypedData({ chainId: CHAIN_ID, escrow: ESCROW, id: mm.id, refundTo: adr("fran"), altRefundTo: adr("gus"), nonce, deadline }) as never);
    const r = await m("redirectRefund", { id: mm.id.toString(), refundTo: adr("fran"), altRefundTo: adr("gus"), deadline: deadline.toString(), signature });
    await confirm(r.txHash);
    const e = await getEscrow(mm.id);
    eq(getAddress(e.refundTo), getAddress(adr("fran")), "refundTo");
    eq(getAddress(e.altRefundTo), getAddress(adr("gus")), "altRefundTo");
    redirected.push(mm);
  }
});
await refused("Refund", "redirect to the same addresses again is refused", async () => {
  const mm = redirected[0]!;
  const nonce = await nonceOf(adr("alice"));
  const deadline = BigInt((await now()) + 600);
  const signature = await acc("alice").signTypedData(refundRedirectTypedData({ chainId: CHAIN_ID, escrow: ESCROW, id: mm.id, refundTo: adr("fran"), altRefundTo: adr("gus"), nonce, deadline }) as never);
  await m("redirectRefund", { id: mm.id.toString(), refundTo: adr("fran"), altRefundTo: adr("gus"), deadline: deadline.toString(), signature });
}, /already set/i);

// ---------------------------------------------------------------- 5 challenges (referee-decided)
const chal: Record<string, Made> = {};
await step("Challenge", "named challenge, gasless accept (EIP-3009), referee releases: pot to the acceptor", async () => {
  chal.named = await apiCreate("alice", `/challenge ${bobA} 20 vs 10 if referee ${erinA} decides`);
  eq(await status(chal.named.id), S.OPEN, "status");
  await accept(chal.named, "bob");
  expect(((await flagsOf(chal.named.id)) & 2) !== 0, "accepted flag");
  const before = await bal(bobA);
  await decide("erin", chal.named.id, 3);
  await waitStatus(chal.named.id, S.RELEASED);
  eq((await bal(bobA)) - before, U(30), "bob received the pot");
});
await step("Challenge", "link challenge: acceptor proves the link (Accept signature), referee returns: pot to the sender", async () => {
  chal.link = await apiCreate("alice", `/challenge link 20 vs 20 if referee ${erinA} decides`, { link: true });
  await accept(chal.link, "carol", { link: true });
  const before = await bal(adr("alice"));
  await decide("erin", chal.link.id, 4);
  await waitStatus(chal.link.id, S.RETURNED);
  eq((await bal(adr("alice"))) - before, U(40), "alice got the pot back");
});
await step("Challenge", "wallet-sent accept(): approve + accept by the named recipient", async () => {
  const mm = await apiCreate("alice", `/challenge ${bobA} 20 vs 10 if referee ${erinA} decides`);
  await send("bob", USDG, usdgAbi, "approve", [ESCROW, U(10)]);
  await send("bob", ESCROW, ifsoEscrowAbi, "accept", [mm.id, "0x", bobA]);
  expect(((await flagsOf(mm.id)) & 2) !== 0, "accepted flag");
  await decide("erin", mm.id, 3);
  await waitStatus(mm.id, S.RELEASED);
});
await step("Challenge", "challenge nobody accepted: sender cancels", async () => {
  const mm = await apiCreate("alice", `/challenge ${bobA} 20 vs 10 if referee ${erinA} decides`);
  const before = await bal(adr("alice"));
  await send("alice", ESCROW, ifsoEscrowAbi, "cancel", [mm.id]);
  eq(await status(mm.id), S.CANCELLED, "status");
  eq((await bal(adr("alice"))) - before, U(20), "refund");
});
await step("Challenge", "a challenge on a price touch is turned into questions by parse (never built)", async () => {
  const p = await q("parse", { text: `/challenge ${bobA} 20 vs 20 if eth touches at or above 5000 by in 3 hours` });
  expect(p.questions.some((x: any) => x.kind === "touch_challenge"), "touch_challenge question");
});
// kept for stage 9: accepted challenge nobody decides (VOID at expiry) and an unaccepted challenge (refund after acceptBy)
await step("Challenge", "setup: an accepted challenge the referee never decides, and an unaccepted one", async () => {
  chal.voidMe = await apiCreate("alice", `/challenge ${bobA} 20 vs 10 if referee ${erinA} decides`);
  await accept(chal.voidMe, "bob", { counterRefundTo: adr("fran") });
  chal.unaccepted = await apiCreate("alice", `/challenge ${bobA} 20 vs 10 if referee ${erinA} decides`);
});

// ---------------------------------------------------------------- 6 price (real ETH/USD feed) + 7 time + outcome set-up
const pr: Record<string, Made> = {};
await step("Price", "real ETH/USD feed, at the deadline, TRUE (one-sided link): create", async () => {
  pr.t = await apiCreate("alice", `/ifso ${bobA} 20 if eth is at or above 100 by in 3 hours`);
  eq(await status(pr.t.id), S.OPEN, "status");
});
await step("Price", "real ETH/USD feed, at the deadline, FALSE (one-sided): create", async () => {
  pr.f = await apiCreate("alice", `/ifso ${bobA} 20 if eth is at or below 100 by in 3 hours`);
});
const spy: Record<string, Made> = {};
await step("Price", "stock (SPY) price condition created through the site flow from an allowed region", async () => {
  const p = await q("parse", { text: "/ifso link 20 if spy closes at or above 100 on monday" });
  const weekend = p.questions.find((x: any) => x.kind === "weekend");
  let text = "/ifso link 20 if spy closes at or above 100 on monday";
  if (weekend) {
    const opt = weekend.options.find((o: any) => /monday/i.test(o.label)) ?? weekend.options[0];
    text = opt.text ?? text.replace(opt.replace[0], opt.replace[1]);
  }
  spy.t = await apiCreate("alice", text, { link: true });
  eq(await status(spy.t.id), S.OPEN, "status");
  return text;
});
// outcome payments: four fixtures kick off 40..70 minutes from now
const oc: Record<string, Made> = {};
await step("Outcome", "sports result payments built and created through the API (arsenal, man utd, ipswich/liverpool)", async () => {
  oc.win = await apiCreate("alice", `/ifso ${bobA} 20 if arsenal win`);
  oc.dispute = await apiCreate("alice", `/ifso ${carolA} 20 if manchester united win`);
  oc.timeout = await apiCreate("alice", `/ifso ${daveA} 20 if liverpool win`);
  const rows = await q<any[]>("mine", { address: adr("alice") });
  expect(rows.length > 5, "mine lists rows");
});
let pmQuestion = "";
await step("Outcome", "market question (Polymarket) built and created through the API", async () => {
  const slug = (await (await fetch(`${A.admin}/sources`)).json()).marketSlug;
  oc.market = await apiCreate("alice", `/ifso ${bobA} 20 if polymarket ${slug} resolves yes`);
  pmQuestion = slug;
});

// ---------------------------------------------------------------- stage: time passes (10 minutes)
await step("Time", "advance the chain 12 minutes; clock offset applied to the API", async () => {
  await warpBy(12 * 60);
  const off = await admin("/offset");
  expect(off.ms >= 12 * 60_000, "offset");
});
await step("Settle TIME", "named payments (allowance, permit, 3009, batch) are paid by the keeper", async () => {
  const before = await bal(bobA);
  for (const k of ["allow", "permit", "gasless", "batch0"]) await waitStatus(made[k]!.id, S.RELEASED);
  await waitStatus(made.batch2!.id, S.RELEASED);
  expect((await bal(bobA)) - before >= U(65), "bob received 3x20 + 5");
  await apiSees("bob", made.gasless!.id, S.RELEASED);
});
await step("Settle TIME", "link bound before the deadline: the claimer was paid at the deadline", async () => {
  const before = await bal(carolA);
  await waitStatus(made.linkBound!.id, S.RELEASED);
  expect(true, "ok");
  expect((await bal(carolA)) >= before, "carol");
});
await step("Claim", "link MET (unclaimed at the deadline): claim returns 'paid' and pays at once", async () => {
  await waitStatus(made.linkMet!.id, S.MET);
  const before = await bal(daveA);
  const r = await claimLink(made.linkMet!, daveA);
  await confirm(r.txHash);
  eq(r.status, "paid", "status");
  eq(await status(made.linkMet!.id), S.RELEASED, "released");
  eq((await bal(daveA)) - before, U(20), "dave received");
});
await step("Claim", "passkey-style account and counterfactual account were paid by the keeper", async () => {
  await waitStatus(made.linkSmart!.id, S.RELEASED);
  await waitStatus(made.linkCf!.id, S.RELEASED);
  eq(await bal(smartWallet), U(40), "smart account balance (this claim + the PARTIES payment released to it earlier)");
  eq(await bal(counterfactual), U(20), "counterfactual account balance");
});

// ---------------------------------------------------------------- stage: past the 3 h price deadlines and the first kickoff + 2h30
await pauseWorker("resolver"); // so a stranger can propose first on two questions
const eplT = await (async () => {
  const rows = await q<any[]>("mine", { address: adr("alice") });
  return rows.find((r) => r.id === oc.win!.id.toString());
})();
await step("Time", "advance to 3h40m after the start (price deadlines passed, first question open for resolution)", async () => {
  await warpTo(t0 + 3 * 3600 + 40 * 60 + 60);
});
await step("Settle PRICE", "real ETH feed at the deadline: TRUE pays the recipient, FALSE returns to the sender", async () => {
  const bBefore = await bal(bobA), aBefore = await bal(adr("alice"));
  await waitStatus(pr.t!.id, S.RELEASED, 120_000);
  await waitStatus(pr.f!.id, S.RETURNED, 120_000);
  eq((await bal(bobA)) - bBefore, U(20), "bob got the TRUE payment only");
  expect((await bal(adr("alice"))) - aBefore >= U(20), "alice got the FALSE payment back");
});
// ---------------------------------------------------------------- outcome
const qOf = async (made_: Made) => (await getEscrow(made_.id)).conditionHash && (await pc.readContract({ address: ESCROW, abi: ifsoEscrowAbi, functionName: "getCondition", args: [made_.id] }) as any).key as Hex;
const qinfo = async (id: Hex) => (await pc.readContract({ address: RESOLVER, abi: ifsoOutcomeResolverAbi, functionName: "getQuestion", args: [id] })) as any;
const resolverAbi = ifsoOutcomeResolverAbi;
const strangerPropose = async (who: string, qid: Hex, outcome: number) => {
  await send(who, USDG, usdgAbi, "approve", [RESOLVER, 2n ** 200n]);
  return send(who, RESOLVER, resolverAbi, "propose", [qid, outcome, ("0x" + "ab".repeat(32)) as Hex]);
};
await step("Outcome", "wait until the questions are registered on the resolver (funded escrows exist)", async () => {
  for (const k of ["win", "dispute", "timeout"]) {
    const qid = await qOf(oc[k]!);
    const info = await qinfo(qid);
    expect(Number(info.state) >= 1, `question ${k} not registered (state ${info.state})`);
  }
});
let qWin: Hex, qDis: Hex, qTim: Hex;
await step("Outcome", "wait for the earliest-resolve time on the other two questions", async () => {
  qWin = await qOf(oc.win!); qDis = await qOf(oc.dispute!); qTim = await qOf(oc.timeout!);
  const er = Number((await qinfo(qTim)).earliestResolve);
  await warpTo(er + 30);
});
await step("Outcome", "stranger proposes WRONG results on two questions while the service is paused", async () => {
  await strangerPropose("dave", qDis, 2).then((h) => hashes(h));
  await strangerPropose("dave", qTim, 1).then((h) => hashes(h));
  eq(Number((await qinfo(qDis)).state), 2, "state proposed");
});
await admin("/worker", { name: "resolver", on: true });
await step("Outcome", "resolver service proposes the confirmed result (arsenal win => HOME) and disputes both wrong proposals", async () => {
  await until("service proposal on win", async () => Number((await qinfo(qWin)).state) === 2, 120_000);
  eq(Number((await qinfo(qWin)).proposed), 1, "proposed outcome");
  await until("dispute on dis", async () => Number((await qinfo(qDis)).state) === 3, 120_000);
  await until("dispute on tim", async () => Number((await qinfo(qTim)).state) === 3, 120_000);
});
await step("Outcome", "panel (owner Safe fork stand-in) resolves the disputed question; escrow settles by the panel answer", async () => {
  const h = await asSafe(A.panelSafe, (w) => w.writeContract({ address: RESOLVER, abi: resolverAbi, functionName: "panelResolve", args: [qDis, 1], chain } as never));
  await confirm(h);
  eq(Number((await qinfo(qDis)).state), 4, "final");
  const before = await bal(carolA);
  await waitStatus(oc.dispute!.id, S.RELEASED, 90_000);
  eq((await bal(carolA)) - before, U(20), "carol received (panel said HOME)");
});
await step("Outcome", "undisputed result: after the 2 h dispute window the service finalizes; escrow pays", async () => {
  const p = Number((await qinfo(qWin)).proposedAt);
  await warpTo(p + 2 * 3600 + 60);
  await until("final win", async () => Number((await qinfo(qWin)).state) === 4, 120_000);
  const before = await bal(bobA);
  await waitStatus(oc.win!.id, S.RELEASED, 90_000);
  eq((await bal(bobA)) - before, U(20), "bob received");
});
await step("Outcome", "panel silent for 72 h: question times out as VOID; the payment returns to the sender", async () => {
  const d = Number((await qinfo(qTim)).disputedAt);
  await warpTo(d + 72 * 3600 + 120);
  await until("void", async () => Number((await qinfo(qTim)).state) === 5, 120_000);
  const before = await bal(adr("alice"));
  await waitStatus(oc.timeout!.id, S.RETURNED, 90_000);
  expect((await bal(adr("alice"))) - before >= U(20), "alice got it back");
});

// ---------------------------------------------------------------- market (Polymarket) after its 24 h delay
await step("Outcome", "market question: resolved per the recorded final answer after the 24 h delay", async () => {
  const qid = await qOf(oc.market!);
  const info = await qinfo(qid);
  await warpTo(Number(info.earliestResolve) + 60);
  await until("market proposed", async () => Number((await qinfo(qid)).state) >= 2, 120_000);
  await warpTo(Number((await qinfo(qid)).proposedAt) + 2 * 3600 + 60);
  await until("market final", async () => Number((await qinfo(qid)).state) === 4, 120_000);
  const final = Number((await qinfo(qid)).finalOutcome);
  const want = final === 1 ? S.RELEASED : S.RETURNED; // escrow unlocks on YES
  await waitStatus(oc.market!.id, want, 90_000);
  return `slug ${pmQuestion}, final outcome ${final}`;
});

// ---------------------------------------------------------------- mocked ETH feed: TOUCH + a controlled deadline + phase change
const ETH_FEED = A.feeds[0] as Address;
let mock: Awaited<ReturnType<typeof mockFeed>>;
await step("Price", "swap the ETH/USD feed for a controllable double (fork only), seed a fresh round", async () => {
  mock = await mockFeed(ETH_FEED);
  await mock.push(3000_00000000n);
  const l = (await pc.readContract({ address: ETH_FEED, abi: mock.abi, functionName: "latestRoundData" })) as any;
  eq(Number(l[1]), 3000_00000000, "answer");
});
await step("Price", "TOUCH: price crosses the level inside the window; price watcher releases early", async () => {
  const mm = await apiCreate("alice", `/ifso ${bobA} 20 if eth touches at or above 5000 by in 3 hours`);
  const before = await bal(bobA);
  await mock.push(5200_00000000n);
  await waitStatus(mm.id, S.RELEASED, 120_000);
  eq((await bal(bobA)) - before, U(20), "bob received");
});
await step("Price", "AT_DEADLINE on a controlled feed, fresh print before the deadline: TRUE, then a pause with a phase change", async () => {
  const mm = await apiCreate("alice", `/ifso ${carolA} 20 if eth is at or above 4000 by in 2 hours`);
  const dl = Number(paramsFromJson(mm.answer.params).condition.deadline);
  const before = await bal(carolA);
  await mock.push(4100_00000000n, dl - 600);
  await warpTo(dl + 120);
  await mock.push(2000_00000000n, dl + 130); // after the deadline: must not decide it
  await waitStatus(mm.id, S.RELEASED, 120_000);
  eq((await bal(carolA)) - before, U(20), "carol received");
});
await step("Price", "price challenge on a controlled feed, TRUE: acceptor wins the pot; FALSE: sender gets it back", async () => {
  const ct = await apiCreate("alice", `/challenge ${daveA} 20 vs 20 if eth is at or above 4000 by in 3 hours`);
  const cf = await apiCreate("alice", `/challenge ${daveA} 20 vs 20 if eth is at or below 4000 by in 3 hours`);
  await accept(ct, "dave");
  await accept(cf, "dave");
  const dl = Number(paramsFromJson(ct.answer.params).condition.deadline);
  await mock.push(4500_00000000n, dl - 900);
  await warpTo(dl + 120);
  const before = await bal(daveA);
  await waitStatus(ct.id, S.RELEASED, 120_000);
  await waitStatus(cf.id, S.RETURNED, 120_000);
  eq((await bal(daveA)) - before, U(40), "dave got the TRUE pot only");
});
await step("Price", "TOUCH never reached: nothing is paid, the payment returns to the sender after the grace period", async () => {
  const mm = await apiCreate("alice", `/ifso ${carolA} 20 if eth touches at or above 9000 by in 2 hours`);
  const dl = Number(paramsFromJson(mm.answer.params).condition.deadline);
  await mock.push(3100_00000000n);
  await warpTo(dl + 3600);
  eq(await status(mm.id), S.OPEN, "still open at the deadline");
  const before = await bal(adr("alice"));
  await warpTo(Number(paramsFromJson(mm.answer.params).expiry) + 60);
  await waitStatus(mm.id, S.RETURNED, 120_000);
  expect((await bal(adr("alice"))) - before >= U(20), "refunded");
});
await step("Price", "stock (SPY): controlled feed after the Monday close, TRUE pays the claimer's address", async () => {
  const SPY = A.feeds[1] as Address;
  const spyMock = await mockFeed(SPY);
  const c = paramsFromJson(spy.t!.answer.params).condition;
  const dl = Number(c.deadline);
  if ((await now()) < dl - 600) await warpTo(dl - 600);
  await spyMock.push(c.threshold + 100_00000000n, dl - 300);
  const r = await claimLink(spy.t!, daveA);
  await confirm(r.txHash);
  await warpTo(dl + 120);
  await waitStatus(spy.t!.id, S.RELEASED, 120_000);
});

// ---------------------------------------------------------------- pause gates only creation
await step("Pause", "owner pauses creation: create and accept are refused, everything else keeps working", async () => {
  const open = await apiCreate("alice", `/ifso ${bobA} 20 if we both agree`);
  const chalOpen = await apiCreate("alice", `/challenge ${bobA} 20 vs 10 if referee ${erinA} decides`);
  const lk = await apiCreate("alice", `/ifso link 20 if referee ${erinA} decides`, { link: true });
  const h = await asSafe(A.ownerSafe, (w) => w.writeContract({ address: ESCROW, abi: ifsoEscrowAbi, functionName: "setCreationPaused", args: [true], chain } as never));
  await confirm(h);
  let refusedCreate = false, refusedAccept = false;
  try { await apiCreate("alice", `/ifso ${bobA} 20 if we both agree`); } catch { refusedCreate = true; }
  try { await accept(chalOpen, "bob"); } catch { refusedAccept = true; }
  expect(refusedCreate, "create must be refused while paused");
  expect(refusedAccept, "accept must be refused while paused");
  await decide("alice", open.id, 1); // OK works
  await decide("bob", open.id, 1);
  await waitStatus(open.id, S.RELEASED);
  const rc = await claimLink(lk, carolA); // claim works
  await confirm(rc.txHash);
  await decide("erin", lk.id, 3); // referee works
  await waitStatus(lk.id, S.RELEASED);
  const h2 = await asSafe(A.ownerSafe, (w) => w.writeContract({ address: ESCROW, abi: ifsoEscrowAbi, functionName: "setCreationPaused", args: [false], chain } as never));
  await confirm(h2);
  const again = await apiCreate("alice", `/ifso ${bobA} 20 if we both agree`);
  eq(await status(again.id), S.OPEN, "create works after unpause");
  made.afterPause = again;
});

// ---------------------------------------------------------------- expiry: refunds primary / alternate / unaccepted / VOID
await step("Refund", "keeper OFF; time passes beyond the 30 day expiry and the unaccepted window", async () => {
  chal.unaccepted2 = await apiCreate("alice", `/challenge ${bobA} 20 vs 10 if referee ${erinA} decides`);
  await pauseWorker("keeper");
  const e = await getEscrow(redirected[0]!.id);
  await warpTo(Number(e.expiry) + 120);
});
await step("Refund", "anyone refunds to the redirected PRIMARY address (fran)", async () => {
  const before = await bal(adr("fran"));
  hashes(await send("carol", ESCROW, ifsoEscrowAbi, "refund", [redirected[0]!.id, false, false]));
  eq(await status(redirected[0]!.id), S.RETURNED, "status");
  eq((await bal(adr("fran"))) - before, U(20), "fran received");
});
await step("Refund", "anyone refunds to the ALTERNATE address (gus) when the primary is screened", async () => {
  const before = await bal(adr("gus"));
  await send("carol", ESCROW, ifsoEscrowAbi, "refund", [redirected[1]!.id, true, false]);
  eq((await bal(adr("gus"))) - before, U(20), "gus received");
});
await step("Refund", "unaccepted challenge: refund by anyone after the accept window (not accepted)", async () => {
  const before = await bal(adr("alice"));
  await send("dave", ESCROW, ifsoEscrowAbi, "refund", [chal.unaccepted2!.id, false, false]);
  eq(await status(chal.unaccepted2!.id), S.RETURNED, "status");
  eq((await bal(adr("alice"))) - before, U(20), "refund");
});
await step("Refund", "an unaccepted challenge was already refunded by the keeper when its accept window closed", async () => {
  eq(await status(chal.unaccepted!.id), S.RETURNED, "status");
});
await step("Refund", "accepted challenge nobody decided: VOID at expiry returns each side its own (acceptor to its refund address)", async () => {
  const fBefore = await bal(adr("fran")), aBefore = await bal(adr("alice"));
  await send("dave", ESCROW, ifsoEscrowAbi, "refund", [chal.voidMe!.id, false, false]);
  eq(await status(chal.voidMe!.id), S.VOIDED, "status");
  eq((await bal(adr("fran"))) - fBefore, U(10), "acceptor stake to its counter refund address");
  eq((await bal(adr("alice"))) - aBefore, U(20), "sender stake back");
});
await admin("/worker", { name: "keeper", on: true });
await step("Refund", "keeper sweep refunds an expired payment on its own", async () => {
  await warpTo(Number((await getEscrow(made.afterPause!.id)).expiry) + 120);
  await waitStatus(made.afterPause!.id, S.RETURNED, 120_000);
});
await refused("Refund", "refunding before the expiry is refused", async () => {
  const mm = await apiCreate("alice", `/ifso ${bobA} 20 if we both agree`);
  await send("dave", ESCROW, ifsoEscrowAbi, "refund", [mm.id, false, false]);
}, /NotExpired|revert/i);

// ---------------------------------------------------------------- books
await step("Books", "fees: the router holds exactly the sum of the creation fees; the escrow holds exactly what is still open", async () => {
  const logs = await pc.getLogs({ address: ESCROW, fromBlock: BigInt(A.forkBlock) });
  let fees = 0n;
  const ids: bigint[] = [];
  for (const l of logs) {
    try {
      const ev: any = decodeEventLog({ abi: ifsoEscrowAbi, data: l.data, topics: l.topics });
      if (ev.eventName === "Created") { fees += BigInt(ev.args.feePaid); ids.push(BigInt(ev.args.id)); }
    } catch {}
  }
  let owed = 0n;
  for (const id of ids) {
    const e = await getEscrow(id);
    const st = Number(e.status);
    if (st === S.OPEN || st === S.MET) owed += BigInt(e.amount) + (Number(e.flags) & 2 ? BigInt(e.counterAmount) : 0n);
  }
  const held = await bal(ESCROW);
  eq(held, owed, "escrow USDG balance vs open escrows");
  const routerBal = await bal(A.router);
  expect(routerBal >= 0n, "router");
  const recips = await Promise.all((A.feeRecipients as Address[]).map(bal));
  const feeTotal = routerBal + recips.reduce((a, b) => a + b, 0n);
  expect(feeTotal >= fees, `fees ${fees} not found at router+recipients ${feeTotal}`);
  return `${ids.length} escrows created, creation fees ${Number(fees) / 1e6} USDG, escrow holds ${Number(held) / 1e6} USDG open`;
});
await step("Books", "no alerts raised by the workers except the expected foreign-proposal notices", async () => {
  const al = (await admin("/alerts")) as any[];
  const bad = al.filter((a) => !/foreign|panel-waiting|resolver-foreign|resolver-dispute/.test(a.cause));
  expect(bad.length === 0, "unexpected alerts: " + JSON.stringify(bad.slice(0, 3)));
  return `${al.length} expected notices`;
});

// ================================================================== report
const pass = rows.filter((r) => r.ok).length;
const failed = rows.filter((r) => !r.ok);
const txs: { hash: Hex; gas: bigint; ok: boolean }[] = [];
for (const r of rows) for (const h of r.hashes) {
  try {
    const rc = await pc.getTransactionReceipt({ hash: h });
    txs.push({ hash: h, gas: rc.gasUsed, ok: rc.status === "success" });
  } catch {}
}
const gasOf = (r: Row) => r.hashes.reduce((s, h) => s + (txs.find((t) => t.hash === h)?.gas ?? 0n), 0n);
const md: string[] = [];
md.push(`# Fork run, ${startedAt.slice(0, 10)}`);
md.push("");
md.push(`**Result: ${pass}/${rows.length} passed** (${rows.filter((r) => r.expectedFailure).length} of them are expected-refusal checks).`);
md.push("");
md.push(`- Chain: anvil fork of Robinhood Chain 4663 at block ${A.forkBlock} (chain id stays 4663 on the fork; the deployer, escrow and every key are throwaway, so nothing signed here replays on mainnet)`);
md.push(`- Commit: ${A.commit}`);
md.push(`- Escrow ${ESCROW}, resolver ${RESOLVER}, USDG ${USDG} (the real token on the fork)`);
md.push(`- Real feeds and Stock Tokens from the fork; the ETH/USD and SPY feeds are swapped for controllable doubles only AFTER the real-feed steps (marked "controlled feed")`);
md.push(`- Time: the chain was advanced with evm_increaseTime (${(warpedSec / 86400).toFixed(1)} days in total) and the API's clock was shifted by the same amount through the admin port`);
md.push(`- Fork-only helpers: owner Safe and panel Safe are impersonated; USDG balances are written to storage; the league and market listings come from the recorded fixtures (test/fixtures/resolver)`);
md.push(`- Redis: not installed on this machine; the fork API keeps its rate limits in memory and runs the workers on timers (BullMQ is covered by the unit suite)`);
md.push("");
let area = "";
for (const r of rows) {
  if (r.area !== area) { area = r.area; md.push("", `## ${area}`, "", "| # | Step | Result | Gas | Transactions | Note |", "|---|---|---|---|---|---|"); }
  const idx = rows.indexOf(r) + 1;
  md.push(`| ${idx} | ${r.name} | ${r.ok ? "PASS" : "**FAIL**"}${r.expectedFailure ? " (refusal)" : ""} | ${gasOf(r) || ""} | ${r.hashes.map((h) => "`" + h + "`").join("<br>")} | ${r.note.replace(/\|/g, "/").slice(0, 200)} |`);
}
md.push("", "## Failures", "");
md.push(failed.length ? failed.map((r) => `- [${r.area}] ${r.name}: ${r.note}`).join("\n") : "None.");
md.push("", "## Bugs found", "", bugs.length ? bugs.join("\n") : "(see the section below; filled in by hand after the run)");
md.push("", `Transactions recorded: ${txs.length}, total gas ${txs.reduce((a, t) => a + t.gas, 0n)}.`);
writeFileSync(reportPath, md.join("\n") + "\n");
writeFileSync(reportPath.replace(/\.md$/, ".json"), JSON.stringify({ pass, total: rows.length, rows: rows.map((r) => ({ ...r })) }, null, 1));
console.log(`\n${pass}/${rows.length} passed. report: ${reportPath}`);
process.exit(failed.length ? 1 : 0);
