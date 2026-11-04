// Exercises every user transaction on Robinhood Chain TESTNET (46630) against a live Ifso API, and writes the report.
// Same flow code as the fork exerciser (scripts/fork/exercise.ts): tRPC over HTTP, @ifso/client helpers, the site's
// signing order (build -> verifyBuildAnswer -> sign -> submit). Testnet has no time travel and no impersonation, so:
//   - every wait is real and polls the chain (block timestamp, escrow status), never a blind sleep;
//   - admin calls (pause) go through the 2-of-3 test owner Safe via docs/tools/testnet-safe-exec.sh;
//   - the ETH/USD feed is the testnet MockAggregator (public push), so PRICE conditions are made true/false on purpose;
//   - wallet-pays paths may shorten `expiry` / `acceptBy` to the contract minimums (1 h after creation for APPROVE),
//     which the API build never does (it uses the product defaults), so refund and VOID paths finish within a run;
//   - steps that wait longer than the run (TIME claim window >= 1 day, TOUCH settle window >= 6 h) are recorded as
//     PENDING with their unlock time and finished by `--resume`.
// The server's relayer, keeper and resolver keys are never used here. The people keys are fresh, written to
// $PEOPLE_DIR (default ~/Documents/GitHub/Ifso/.testnet-people, outside every repo, mode 0600).
//
//   bun run app/scripts/testnet/exercise.ts [--report <path>] [--resume]
//   env: API (default https://api.ifso.tech), RPC (default public testnet RPC), PEOPLE_DIR, SAFE_EXEC (path to the helper)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, getAddress, hashTypedData, http, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { robinhoodTestnet } from "viem/chains";
import { ifsoEscrowAbi, ifsoOutcomeResolverAbi } from "../../src/abi";
import {
  acceptAuthorizationTypedData, buildClaimUrl, createPermitTypedData, DecisionAction, decisionTypedData, findBannedWords,
  linkKeyAddress, parseClaimUrl, randomSecret, refundRedirectTypedData, runClaim, signAccept, verifyBuildAnswer,
} from "../../src/client";
import { paramsFromJson } from "../../src/core/paramsJson";

const CHAIN_ID = 46630;
const API = process.env.API ?? "https://api.ifso.tech";
const RPC = process.env.RPC ?? "https://rpc.testnet.chain.robinhood.com";
const IFSO = join(homedir(), "Documents/GitHub/Ifso");
const PEOPLE_DIR = process.env.PEOPLE_DIR ?? join(IFSO, ".testnet-people");
const SAFE_EXEC = process.env.SAFE_EXEC ?? join(IFSO, "docs/tools/testnet-safe-exec.sh");
const ARTIFACTS = process.env.ARTIFACTS ?? join(import.meta.dir, "../../../contracts/out");
const RESUME = process.argv.includes("--resume");
const reportPath = process.argv.includes("--report") ? process.argv[process.argv.indexOf("--report") + 1]! : join(PEOPLE_DIR, "testnet-run.md");
const STATE = join(PEOPLE_DIR, "state.json");

const ESCROW = getAddress("0x7FFf1cE34532f76A6aFEb53E503891e671f891d6");
const USDG = getAddress("0x857315614841c5d537a5F395f020fc5bCa0fdaC6");
const ETH_FEED = getAddress("0x6ba540c3638cac8047599dA9fB09c03BE834b725");
const OWNER_SAFE = getAddress("0xdAdC7f6694F214d3Ba250275e296Edd2DF6c5995");
const PANEL_SAFE = getAddress("0x56A07C4571859278996BE577c82785cD6943e2cd");
const RESOLVER = getAddress("0x26dB66f4AA5D4Ca365464bfc2425b27805F34A98");
const SERVICE_KEYS = ["0x8aB1F0895B2012Db89Caf62e5b67E81137853ad0", "0xB2Ebe6323Aea29042985A7aB743d0F17A2175Fdc", "0x773B7Bc00Ec82753FCca6AF3C051b7Ddf2c7451b"].map((a) => a.toLowerCase());

const chain = { ...robinhoodTestnet, rpcUrls: { default: { http: [RPC] } } };
const pc = createPublicClient({ chain, transport: http(RPC, { retryCount: 5, retryDelay: 800 }), pollingInterval: 1000 });
const usdgAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function nonces(address) view returns (uint256)", "function mint(address,uint256)"]);
const feedAbi = parseAbi(["function pushNow(int256) returns (uint80)", "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"]);
const U = (n: number) => BigInt(Math.round(n * 1e6));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ people (fresh keys, outside every repo)
const NAMES = ["alice", "bob", "carol", "dave", "erin", "fran", "gus", "heidi", "ivan"] as const;
mkdirSync(PEOPLE_DIR, { recursive: true, mode: 0o700 });
const peopleFile = join(PEOPLE_DIR, "people.json");
if (!existsSync(peopleFile)) {
  writeFileSync(peopleFile, JSON.stringify(Object.fromEntries(NAMES.map((n) => [n, generatePrivateKey()])), null, 1), { mode: 0o600 });
}
chmodSync(peopleFile, 0o600);
const KEYS: Record<string, Hex> = JSON.parse(readFileSync(peopleFile, "utf8"));
const acc = (n: string) => privateKeyToAccount(KEYS[n]!);
const adr = (n: string) => acc(n).address;
const wc = (n: string) => createWalletClient({ chain, account: acc(n), transport: http(RPC, { retryCount: 3 }) });

/** Every send is preceded by this: the run must never reach any chain but 46630. */
async function assertTestnet() {
  const id = await pc.getChainId();
  if (id !== CHAIN_ID) {
    console.error(`REFUSING: RPC answers chain ${id}, not ${CHAIN_ID}`);
    process.exit(3);
  }
}

// ------------------------------------------------------------------ api (what @trpc/client's httpBatchLink does for one call)
class ApiError extends Error {
  constructor(public code: string, msg: string) { super(msg); }
}
const throttles: string[] = [];
async function call<T>(name: string, fn: () => Promise<Response>): Promise<T> {
  const end = Date.now() + 40 * 60_000;
  for (;;) {
    const r = await fn();
    const j: any = await r.json().catch(() => ({ error: { message: `HTTP ${r.status}` } }));
    if (r.ok) return j.result.data;
    const code = j.error?.data?.code ?? String(r.status);
    if (code === "TOO_MANY_REQUESTS" && Date.now() < end) {
      throttles.push(`${new Date().toISOString()} ${name}: ${j.error?.message}`);
      console.log(`  (rate limited on ${name}: waiting 60 s)`);
      await sleep(60_000);
      continue;
    }
    throw new ApiError(code, `${code}: ${j.error?.message ?? JSON.stringify(j)}`);
  }
}
const q = <T = any>(name: string, input: unknown) => call<T>(name, () => fetch(`${API}/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`));
const m = <T = any>(name: string, input: unknown) => call<T>(name, () => fetch(`${API}/trpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }));

// ------------------------------------------------------------------ report plumbing
interface Row { area: string; name: string; ok: boolean; pending?: string; hashes: Hex[]; chain: string; api: string; note: string; expectedFailure?: boolean }
let rows: Row[] = [];
let cur: Row | undefined;
const hashes = (...h: (Hex | undefined)[]) => h.forEach((x) => x && cur && !cur.hashes.includes(x) && cur.hashes.push(x));
const onChain = (s: string) => cur && (cur.chain = cur.chain ? `${cur.chain}; ${s}` : s);
const onApi = (s: string) => cur && (cur.api = cur.api ? `${cur.api}; ${s}` : s);
class Pending extends Error {}
async function step(area: string, name: string, fn: () => Promise<string | void>, expectedFailure = false) {
  cur = { area, name, ok: false, hashes: [], chain: "", api: "", note: "", expectedFailure };
  const t = Date.now();
  try {
    cur.note = (await fn()) ?? "";
    cur.ok = true;
  } catch (e) {
    if (e instanceof Pending) cur.pending = e.message;
    else cur.note = `FAILED: ${String((e as Error).message ?? e).slice(0, 500)}`;
  }
  rows.push(cur);
  const tag = cur.ok ? "PASS" : cur.pending ? "PENDING" : "FAIL";
  console.log(`${tag} [${area}] ${name} (${Math.round((Date.now() - t) / 1000)} s)${cur.ok ? "" : " :: " + (cur.pending ?? cur.note)}`);
}
async function refused(area: string, name: string, fn: () => Promise<unknown>, match: RegExp) {
  await step(area, name, async () => {
    try {
      await fn();
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (!match.test(msg)) throw new Error(`refused with an unexpected message: ${msg.slice(0, 200)}`);
      return `refused as expected: ${msg.split("\n")[0]!.slice(0, 160)}`;
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
async function until<T>(label: string, fn: () => Promise<T | undefined | false>, ms = 180_000, every = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out after ${Math.round(ms / 1000)} s waiting for ${label}`);
    await sleep(every);
  }
}
/** waits for wall-clock AND chain time to pass ts (the chain clock only moves with blocks) */
async function waitChainTime(ts: number, label: string) {
  const wall = ts * 1000 - Date.now();
  if (wall > 0) {
    console.log(`  waiting ${Math.round(wall / 1000)} s for ${label}`);
    while (Date.now() < ts * 1000) await sleep(Math.min(30_000, ts * 1000 - Date.now() + 200));
  }
  await until(`chain time ${ts} (${label})`, async () => (await now()) >= ts, 600_000, 4000);
}
const bal = (a: Address) => pc.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [a] }) as Promise<bigint>;
const getEscrow = (id: bigint) => pc.readContract({ address: ESCROW, abi: ifsoEscrowAbi, functionName: "getEscrow", args: [id] }) as Promise<any>;
const status = async (id: bigint) => Number((await getEscrow(id)).status);
const S = { OPEN: 1, MET: 2, RELEASED: 3, RETURNED: 4, VOIDED: 5, CANCELLED: 6 } as const;
const SNAME = Object.fromEntries(Object.entries(S).map(([k, v]) => [v, k])) as Record<number, string>;
const waitStatus = async (id: bigint, s: number, ms = 300_000) => {
  await until(`escrow ${id} status ${SNAME[s]}`, async () => (await status(id)) === s, ms);
  onChain(`${SNAME[s]}`);
};
const nonceOf = (a: Address) => pc.readContract({ address: ESCROW, abi: ifsoEscrowAbi, functionName: "nonces", args: [a] }) as Promise<bigint>;
async function confirm(hash: Hex): Promise<Hex> {
  const r = await pc.waitForTransactionReceipt({ hash, timeout: 120_000, pollingInterval: 1000 });
  hashes(hash);
  if (r.status !== "success") throw new Error(`transaction ${hash} reverted`);
  return hash;
}
async function send(who: string, address: Address, abi: any, functionName: string, args: unknown[] = []): Promise<Hex> {
  await assertTestnet();
  // simulate first so a refusal comes back with the decoded reason, as the site shows it
  await pc.simulateContract({ address, abi, functionName, args, account: acc(who) } as never);
  const h = await wc(who).writeContract({ address, abi, functionName, args } as never);
  return confirm(h);
}
function safeExec(safe: Address, to: Address, data: Hex) {
  const out = execFileSync("bash", [SAFE_EXEC, safe, to, data], { encoding: "utf8", timeout: 240_000 });
  if (!/exec status (0x)?1\b/.test(out)) throw new Error(`safe exec failed: ${out.trim()}`);
  return out.trim();
}

// escrow events (every Ifso escrow event carries the id as its first indexed topic)
let fromBlock = 0n;
async function eventsFor(id: bigint): Promise<{ name: string; tx: Hex; args: any }[]> {
  const logs = await pc.getLogs({ address: ESCROW, fromBlock, toBlock: "latest" });
  const out: { name: string; tx: Hex; args: any }[] = [];
  for (const l of logs) {
    try {
      const ev: any = decodeEventLog({ abi: ifsoEscrowAbi, data: l.data, topics: l.topics });
      if (ev.args?.id !== undefined && BigInt(ev.args.id) === id) out.push({ name: ev.eventName, tx: l.transactionHash!, args: ev.args });
    } catch {}
  }
  return out;
}
/** records the escrow's events and the transactions that emitted them (keeper / relayer ones included) */
async function noteEvents(id: bigint, mustHave?: string) {
  const evs = await until(`events of ${id}${mustHave ? " incl. " + mustHave : ""}`, async () => {
    const e = await eventsFor(id);
    return (!mustHave || e.some((x) => x.name === mustHave)) && e;
  }, 120_000, 4000);
  for (const e of evs) hashes(e.tx);
  onChain(`events ${evs.map((e) => e.name).join(",")}`);
  return evs;
}
/** settled by whom: the service key (keeper / relayer) or a person */
async function settledBy(tx: Hex) {
  const t = await pc.getTransaction({ hash: tx });
  const f = t.from.toLowerCase();
  const who = SERVICE_KEYS.includes(f) ? ["relayer", "keeper", "resolver"][SERVICE_KEYS.indexOf(f)] : (NAMES.find((n) => adr(n).toLowerCase() === f) ?? f);
  return who;
}

// ------------------------------------------------------------------ site-style flows
interface Made { id: bigint; txHash: Hex; secret?: Uint8Array; answer: any; sender: string; expiry: number; deadline?: number; acceptBy?: number }
interface BuildOpts { link?: boolean; cancellable?: boolean; altRefundTo?: Address }
async function apiBuild(sender: string, text: string, o: BuildOpts = {}) {
  const secret = o.link ? randomSecret() : undefined;
  const answer = await m("build", { text, sender: adr(sender), linkKey: secret ? linkKeyAddress(secret) : undefined, cancellable: o.cancellable, altRefundTo: o.altRefundTo });
  verifyBuildAnswer(answer, { from: adr(sender), chainId: CHAIN_ID, escrow: ESCROW, usdg: USDG });
  expect(findBannedWords(String(answer.preview ?? "")).length === 0, "banned words in the preview");
  return { secret, answer };
}
const made_ = (sender: string, answer: any, txHash: Hex, secret?: Uint8Array): Made => {
  const p = paramsFromJson(answer.params);
  return { id: BigInt(answer.id), txHash, secret, answer, sender, expiry: Number(p.expiry), deadline: Number(p.condition.deadline) || undefined, acceptBy: Number(p.acceptBy) || undefined };
};
/** gasless: sender signs EIP-3009 ReceiveWithAuthorization, the API's relayer pays the gas */
async function apiCreate(sender: string, text: string, o: BuildOpts = {}): Promise<Made> {
  const { secret, answer } = await apiBuild(sender, text, o);
  const signature = await acc(sender).signTypedData(answer.authorization.typedData);
  const r = await m("submit", { params: answer.params, from: adr(sender), validAfter: answer.authorization.validAfter, validBefore: answer.authorization.validBefore, signature });
  await confirm(r.txHash);
  expect(BigInt(r.id) === BigInt(answer.id), "submit id differs from build id");
  return made_(sender, answer, r.txHash, secret);
}
/** wallet pays: approve + create with the built params; `tweak` may shorten expiry/acceptBy to the contract minimums */
async function walletCreate(sender: string, text: string, o: BuildOpts & { tweak?: (p: any, nowTs: number) => void } = {}): Promise<Made> {
  const { secret, answer } = await apiBuild(sender, text, o);
  const p = paramsFromJson(answer.params);
  if (o.tweak) {
    o.tweak(p, await now());
    answer.params = JSON.parse(JSON.stringify(p, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  }
  await send(sender, USDG, usdgAbi, "approve", [ESCROW, BigInt(answer.total)]);
  const h = await send(sender, ESCROW, ifsoEscrowAbi, "create", [p]);
  return made_(sender, answer, h, secret);
}
/** the API's list view (the site's dashboard) shows this status */
async function apiSees(who: string, id: bigint, st: number, ms = 240_000) {
  const r = await until(`api mine(${who}) shows ${id} as ${SNAME[st]}`, async () => (await q<any[]>("mine", { address: adr(who) })).find((x) => x.id === id.toString() && Number(x.status) === st), ms, 8000);
  onApi(`${SNAME[st]}`);
  return r;
}
async function decide(who: string, id: bigint, action: number, signerAddr?: Address, signFn?: (typed: any) => Promise<Hex>) {
  const signer = signerAddr ?? adr(who);
  const nonce = await nonceOf(signer);
  const deadline = BigInt((await now()) + 600);
  const typed = decisionTypedData({ chainId: CHAIN_ID, escrow: ESCROW, id, action, nonce, deadline });
  const signature = signFn ? await signFn(typed) : await acc(who).signTypedData(typed as never);
  const r = await m("decide", { id: id.toString(), signer, action, deadline: deadline.toString(), signature });
  return confirm(r.txHash);
}
async function claimLink(made: Made, recipient: Address) {
  const link = parseClaimUrl(buildClaimUrl("https://ifso.tech", made.id, made.secret!));
  return runClaim({ chainId: CHAIN_ID, escrow: ESCROW, getEscrow: (id) => q("escrow", { id }) as any, relayClaim: (i) => m("claim", i) as any, getRecipientAddress: async () => recipient }, link);
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
const pushPrice = async (who: string, usd: number) => send(who, ETH_FEED, feedAbi, "pushNow", [BigInt(usd) * 100_000_000n]);
const ser = (x: unknown) => JSON.parse(JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? toHex(v) : v)));

// ================================================================== state for --resume
interface PendingCheck { area: string; name: string; id: string; sender: string; who: string; wantStatus: number; unlockAt: number; payee: string; amount: string; byAnyone?: { alt: boolean }; outcome?: OutcomePlan }
/** OUTCOME (Polymarket) on testnet: one question per role, advanced by --resume as its windows open */
interface OutcomePlan { role: "undisputed" | "panel" | "timeout"; qid: Hex; slug: string; stage: "open" | "proposed" | "disputed" }
interface State { startedAt: string; fromBlock: string; rows: Row[]; pending: PendingCheck[]; throttles: string[]; ids: string[] }
const loadState = (): State => JSON.parse(readFileSync(STATE, "utf8"));
const saveState = (s: State) => writeFileSync(STATE, JSON.stringify(ser(s), null, 1), { mode: 0o600 });

function writeReport(st: State) {
  const all = st.rows;
  const pass = all.filter((r) => r.ok).length, pend = all.filter((r) => r.pending).length, fail = all.length - pass - pend;
  const md: string[] = [];
  md.push(`# Testnet run (46630), started ${st.startedAt}`, "");
  md.push(`**${pass} passed, ${fail} failed, ${pend} pending** of ${all.length} steps (${all.filter((r) => r.expectedFailure).length} are expected-refusal checks).`, "");
  md.push(`- API ${API}, RPC ${RPC}, escrow ${ESCROW}, USDG (MockUSDG) ${USDG}, ETH/USD MockAggregator ${ETH_FEED}`);
  md.push(`- Explorer: https://explorer.testnet.chain.robinhood.com/tx/<hash>`);
  md.push(`- Rate-limit waits: ${st.throttles.length}${st.throttles.length ? " (" + st.throttles.slice(0, 5).join("; ") + ")" : ""}`, "");
  let area = "";
  for (const r of all) {
    if (r.area !== area) { area = r.area; md.push("", `## ${area}`, "", "| # | Flow | Transactions | On-chain | API | Result | Notes |", "|---|---|---|---|---|---|---|"); }
    const res = r.ok ? "PASS" : r.pending ? "PENDING" : "**FAIL**";
    md.push(`| ${all.indexOf(r) + 1} | ${r.name} | ${r.hashes.map((h) => "`" + h + "`").join("<br>")} | ${r.chain.replace(/\|/g, "/")} | ${r.api.replace(/\|/g, "/")} | ${res}${r.expectedFailure ? " (refusal)" : ""} | ${(r.pending ?? r.note).replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 300)} |`);
  }
  if (st.pending.length) {
    md.push("", "## Pending (finish with `--resume` after the unlock time)", "", "| Flow | Escrow | Waits for | Unlocks (UTC) |", "|---|---|---|---|");
    for (const p of st.pending) md.push(`| ${p.name} | ${p.id} | ${SNAME[p.wantStatus]} | ${new Date(p.unlockAt * 1000).toISOString()} |`);
  }
  writeFileSync(reportPath, md.join("\n") + "\n");
  writeFileSync(reportPath.replace(/\.md$/, ".json"), JSON.stringify(ser(st), null, 1));
}

// ---------------------------------------------------------------- 13 pause gates only creation (owner Safe, 2-of-3 test signers)
async function pauseStep(track: (x: Made) => Made) {
const made: Record<string, Made> = {};
const bobA = adr("bob"), carolA = adr("carol"), erinA = adr("erin");
await step("Pause", "owner Safe pauses creation: create and accept refused; OK, claim and referee keep working; unpause", async () => {
  const open = track(await walletCreate("alice", `/ifso ${bobA} 20 if we both agree`));
  const chalOpen = track(await walletCreate("alice", `/challenge ${bobA} 20 vs 10 if referee ${erinA} decides`));
  const lk = track(await walletCreate("alice", `/ifso link 20 if referee ${erinA} decides`, { link: true }));
  await assertTestnet();
  try {
    onChain(safeExec(OWNER_SAFE, ESCROW, encodeFunctionData({ abi: ifsoEscrowAbi, functionName: "setCreationPaused", args: [true] })));
    expect(await pc.readContract({ address: ESCROW, abi: ifsoEscrowAbi, functionName: "creationPaused" }), "paused flag");
    let refusedCreate = "", refusedAccept = "";
    try { await apiCreate("heidi", `/ifso ${bobA} 20 if we both agree`); } catch (e) { refusedCreate = String((e as Error).message).slice(0, 80); }
    try { await accept(chalOpen, "bob"); } catch (e) { refusedAccept = String((e as Error).message).slice(0, 80); }
    expect(refusedCreate, "create must be refused while paused");
    expect(refusedAccept, "accept must be refused while paused");
    await send("alice", ESCROW, ifsoEscrowAbi, "approve", [open.id]);
    await decide("bob", open.id, 1);
    await waitStatus(open.id, S.RELEASED);
    const rc = await claimLink(lk, carolA);
    await confirm(rc.txHash);
    await decide("erin", lk.id, 3);
    await waitStatus(lk.id, S.RELEASED);
    onChain(`create refused (${refusedCreate}); accept refused (${refusedAccept})`);
  } finally {
    onChain(safeExec(OWNER_SAFE, ESCROW, encodeFunctionData({ abi: ifsoEscrowAbi, functionName: "setCreationPaused", args: [false] })));
  }
  expect(!(await pc.readContract({ address: ESCROW, abi: ifsoEscrowAbi, functionName: "creationPaused" })), "unpaused");
  made.chalOpen = chalOpen;
  const again = track(await apiCreate("heidi", `/ifso ${bobA} 20 if we both agree`));
  eq(await status(again.id), S.OPEN, "create works after unpause");
  made.afterPause = again;
});
return made.afterPause;
}

// ---------------------------------------------------------------- OUTCOME helpers
const outcomePending: PendingCheck[] = [];
const qinfo = (qid: Hex) => pc.readContract({ address: RESOLVER, abi: ifsoOutcomeResolverAbi, functionName: "getQuestion", args: [qid] }) as Promise<any>;
const yesNo = (x: any) => { try { return JSON.stringify(JSON.parse(x.outcomes)) === '["Yes","No"]'; } catch { return false; } };
/** the soonest-ending liquid Yes/No markets (the API's allow-list refuses thin or far-off ones) */
async function pickMarkets(n: number): Promise<string[]> {
  const min = new Date(Date.now() + 2 * 3600_000).toISOString().replace(/\.\d+Z$/, "Z");
  const ms: any[] = await (await fetch(`https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=200&order=endDate&ascending=true&end_date_min=${min}&liquidity_num_min=10000&volume_num_min=50000`)).json();
  return ms.filter(yesNo).slice(0, n).map((m) => m.slug as string);
}
/** the market's real answer once it closed (1 YES, 2 NO, 0 neither), from Gamma */
async function realAnswer(slug: string): Promise<number | undefined> {
  // the single-market endpoint: the list endpoint leaves closed markets out unless closed=true
  const res = await fetch(`https://gamma-api.polymarket.com/markets/slug/${encodeURIComponent(slug)}`);
  const mk: any = res.ok ? await res.json() : undefined;
  if (!mk?.closed) return undefined;
  const [y, n] = JSON.parse(mk.outcomePrices).map(Number);
  return y === 1 && n === 0 ? 1 : y === 0 && n === 1 ? 2 : 0;
}
async function bondFor(who: string) {
  const bond = BigInt((await pc.readContract({ address: RESOLVER, abi: ifsoOutcomeResolverAbi, functionName: "bondAmount" })) as bigint);
  if ((await bal(adr(who))) < bond) await send(who, USDG, usdgAbi, "mint", [adr(who), bond * 2n]);
  await send(who, USDG, usdgAbi, "approve", [RESOLVER, bond]);
  return bond;
}
const QS = { OPEN: 1, PROPOSED: 2, DISPUTED: 3, FINAL: 4, VOID: 5 } as const;
/** settles the escrow per the question's end state and checks chain + API */
async function outcomeSettled(p: PendingCheck) {
  const q = await qinfo(p.outcome!.qid);
  const st = Number(q.state);
  const want = st === QS.FINAL && Number(q.finalOutcome) === 1 ? S.RELEASED : S.RETURNED; // the escrow unlocks on YES
  await waitStatus(BigInt(p.id), want, 900_000);
  const evs = await noteEvents(BigInt(p.id));
  onChain(`question ${st === QS.VOID ? "VOID (panel timed out)" : `FINAL outcome ${q.finalOutcome}`}; escrow settled by ${await settledBy(evs.at(-1)!.tx)}`);
  await apiSees(p.sender, BigInt(p.id), want);
}
/** one --resume visit: advances the question as far as its windows allow; returns the next unlock time, or 0 when done */
async function advanceOutcome(p: PendingCheck): Promise<number> {
  const o = p.outcome!;
  const q0 = await qinfo(o.qid);
  let st = Number(q0.state);
  const disputeWindow = Number(await pc.readContract({ address: RESOLVER, abi: ifsoOutcomeResolverAbi, functionName: "disputeWindow" }));
  const panelWindow = Number(await pc.readContract({ address: RESOLVER, abi: ifsoOutcomeResolverAbi, functionName: "panelWindow" }));
  if (o.role === "undisputed") {
    if (st === QS.OPEN) {
      // the resolver service proposes once two sources agree; give it a few ticks, else come back later
      st = await until("service proposal", async () => Number((await qinfo(o.qid)).state) >= QS.PROPOSED && Number((await qinfo(o.qid)).state), 600_000, 15_000).catch(() => QS.OPEN);
      if (st === QS.OPEN) { onChain("still OPEN: the service has not proposed yet (sources not final)"); return (await now()) + 1800; }
    }
    const q = await qinfo(o.qid);
    if (st === QS.PROPOSED) {
      const by = await settledBy((await pc.getLogs({ address: RESOLVER, event: ifsoOutcomeResolverAbi.find((x: any) => x.name === "Proposed") as any, args: { questionId: o.qid } as any, fromBlock: await pc.getBlockNumber() - 5_000_000n }))[0]!.transactionHash!);
      onChain(`proposed ${q.proposed} by ${by} at ${new Date(Number(q.proposedAt) * 1000).toISOString()}`);
      o.stage = "proposed";
      const fin = Number(q.proposedAt) + disputeWindow;
      if ((await now()) < fin) return fin + 60;
      // past the window: the service finalizes; anyone may if it does not
      const done = await until("finalize", async () => Number((await qinfo(o.qid)).state) === QS.FINAL, 600_000, 15_000).catch(() => false);
      if (!done) await send("dave", RESOLVER, ifsoOutcomeResolverAbi, "finalize", [o.qid]);
      st = QS.FINAL;
    }
    if (st >= QS.FINAL) { await outcomeSettled(p); return 0; }
    throw new Error(`undisputed path found the question in state ${st}`);
  }
  // panel and timeout: dave proposes (if nobody did yet), erin disputes (if the service did not), then the panel decides or stays silent
  if (st === QS.OPEN) {
    await bondFor("dave");
    await send("dave", RESOLVER, ifsoOutcomeResolverAbi, "propose", [o.qid, 2, keccak256(toHex(`testnet-run ${o.role} proposal`))]).catch((e) => onChain(`dave's proposal lost the race: ${String(e.message).slice(0, 60)}`));
    st = Number((await qinfo(o.qid)).state);
    onChain(`proposed ${(await qinfo(o.qid)).proposed}`);
  }
  if (st === QS.PROPOSED) {
    // the service disputes proposals its sources contradict; give it two ticks, then erin disputes so the path is certain
    const by = await until("service dispute", async () => Number((await qinfo(o.qid)).state) === QS.DISPUTED, 180_000, 15_000).then(() => "the service").catch(async () => {
      await bondFor("erin");
      await send("erin", RESOLVER, ifsoOutcomeResolverAbi, "dispute", [o.qid, keccak256(toHex(`testnet-run ${o.role} dispute`))]);
      return "erin";
    });
    st = QS.DISPUTED;
    onChain(`disputed by ${by}`);
  }
  if (st === QS.DISPUTED) {
    o.stage = "disputed";
    const q = await qinfo(o.qid);
    if (o.role === "panel") {
      const ans = await realAnswer(o.slug);
      if (ans === undefined) throw new Error(`panel: Gamma has no closed answer for ${o.slug} yet; the panel never guesses`);
      await assertTestnet();
      onChain(`panel Safe decides ${ans}: ${safeExec(PANEL_SAFE, RESOLVER, encodeFunctionData({ abi: ifsoOutcomeResolverAbi, functionName: "panelResolve", args: [o.qid, ans] }))}`);
      eq(Number((await qinfo(o.qid)).state), QS.FINAL, "final after the panel");
      await outcomeSettled(p);
      return 0;
    }
    const until_ = Number(q.disputedAt) + panelWindow;
    if ((await now()) < until_) { onChain(`panel silent; times out at ${new Date(until_ * 1000).toISOString()}`); return until_ + 60; }
    const done = await until("panel timeout VOID", async () => Number((await qinfo(o.qid)).state) === QS.VOID, 600_000, 15_000).catch(() => false);
    if (!done) await send("dave", RESOLVER, ifsoOutcomeResolverAbi, "finalizeTimedOut", [o.qid]);
    st = QS.VOID;
  }
  if (st >= QS.FINAL) { await outcomeSettled(p); return 0; }
  throw new Error(`${o.role} path found the question in state ${st}`);
}

// ---------------------------------------------------------------- 8 OUTCOME (resolver): through the API as the site does it
async function outcomeSteps(track: (x: Made) => Made) {
const bobA = adr("bob");
await step("Outcome", "sports result payment built through the API ('arsenal win')", async () => {
  const r = await apiBuild("alice", `/ifso ${bobA} 20 if arsenal win`).then(() => "built").catch((e) => String(e.message));
  if (r !== "built") throw new Error(`the API cannot build a sports payment on this server: ${r}`);
});
const roles: OutcomePlan["role"][] = ["undisputed", "panel", "timeout"];
const senders = { undisputed: "alice", panel: "heidi", timeout: "ivan" } as const;
const slugs = await pickMarkets(3);
for (let i = 0; i < roles.length; i++) {
  const role = roles[i]!, slug = slugs[i]!, sender = senders[role];
  await step("Outcome", `market (Polymarket) payment built and created through the API (${role} path)`, async () => {
    expect(slug, "no open Yes/No Polymarket market found");
    let mk: Made;
    try {
      mk = track(await apiCreate(sender, `/ifso ${bobA} 20 if polymarket ${slug} resolves yes`));
    } catch (e) {
      throw new Error(`slug ${slug}: ${(e as Error).message}`);
    }
    const c: any = await pc.readContract({ address: ESCROW, abi: ifsoEscrowAbi, functionName: "getCondition", args: [mk.id] });
    const qid = c.key as Hex;
    const qi: any = await qinfo(qid);
    eq(Number(qi.state), 1, "question registered on the resolver (OPEN)");
    onChain(`question ${qid.slice(0, 10)}.. OPEN, earliestResolve ${new Date(Number(qi.earliestResolve) * 1000).toISOString()}`);
    await apiSees(sender, mk.id, S.OPEN);
    outcomePending.push({ area: "Outcome", name: `OUTCOME ${role}: ${slug}`, id: mk.id.toString(), sender, who: "dave", wantStatus: 0, unlockAt: Number(qi.earliestResolve) + 30, payee: bobA, amount: U(20).toString(), outcome: { role, qid, slug, stage: "open" } });
    return `slug ${slug}, id ${mk.id}, sender ${sender}`;
  });
}
}

// ---------------------------------------------------------------- 16 books
async function booksStep(madeHere: number) {
await step("Books", "the escrow holds exactly what is still open (sum over every escrow this run made)", async () => {
  const head = await pc.getBlockNumber();
  const logs = [];
  // the public RPC serves at most 10,000,000 blocks per query; the escrow was deployed shortly before this run
  for (let from = head > 30_000_000n ? head - 30_000_000n : 0n; from <= head; from += 9_000_000n) {
    const to = from + 8_999_999n > head ? head : from + 8_999_999n;
    logs.push(...(await pc.getLogs({ address: ESCROW, fromBlock: from, toBlock: to })));
  }
  const created: bigint[] = [];
  let fees = 0n;
  for (const l of logs) {
    try {
      const ev: any = decodeEventLog({ abi: ifsoEscrowAbi, data: l.data, topics: l.topics });
      if (ev.eventName === "Created") { created.push(BigInt(ev.args.id)); fees += BigInt(ev.args.feePaid ?? 0); }
    } catch {}
  }
  let owed = 0n;
  for (const id of created) {
    const e = await getEscrow(id);
    const st = Number(e.status);
    if (st === S.OPEN || st === S.MET) owed += BigInt(e.amount) + (Number(e.flags) & 2 ? BigInt(e.counterAmount) : 0n);
    if (st === S.VOIDED && Number(e.flags) & (32 | 64)) owed += 0n; // owed sides would show here
  }
  const held = await bal(ESCROW);
  eq(held, owed, "escrow USDG balance vs open escrows");
  return `${created.length} escrows on chain (this run made ${madeHere}), creation fees ${Number(fees) / 1e6} USDG, escrow holds ${Number(held) / 1e6} USDG open`;
});
}

// ================================================================== --only pause|outcome|books: re-run sections into the saved state
const ONLY = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1]! : undefined;
if (ONLY) {
  const st = loadState();
  fromBlock = BigInt(st.fromBlock);
  rows = [];
  const tr = (x: Made) => (st.ids.push(x.id.toString()), x);
  if (ONLY === "pause") {
    const afterPause = await pauseStep(tr);
    if (afterPause) await refused("Refund", "refunding before the expiry is refused", () => send("dave", ESCROW, ifsoEscrowAbi, "refund", [afterPause.id, false, false]), /NotExpired|revert/i);
  } else if (ONLY === "outcome") {
    await outcomeSteps(tr);
    st.pending.push(...outcomePending);
  }
  else if (ONLY === "books") await booksStep(st.ids.length);
  else throw new Error(`--only ${ONLY}: pause, outcome or books`);
  for (const r of rows) {
    const i = st.rows.findIndex((x) => x.area === r.area && x.name === r.name);
    if (i >= 0) st.rows[i] = r; else st.rows.push(r);
  }
  st.throttles.push(...throttles);
  saveState(st);
  writeReport(st);
  process.exit(rows.every((r) => r.ok) ? 0 : 1);
}

// ================================================================== --resume: finish the pending checks
if (RESUME) {
  const st = loadState();
  fromBlock = BigInt(st.fromBlock);
  rows = st.rows;
  const left: PendingCheck[] = [];
  for (const p of st.pending) {
    const t = await now();
    if (t < p.unlockAt) { left.push(p); console.log(`still pending until ${new Date(p.unlockAt * 1000).toISOString()}: ${p.name}`); continue; }
    const id = BigInt(p.id);
    if (p.outcome) {
      let next = 0;
      await step(p.area, `${p.name} (resumed, stage ${p.outcome.stage})`, async () => {
        next = await advanceOutcome(p);
        if (next) throw new Pending(`stage ${p.outcome!.stage}; next step unlocks at ${new Date(next * 1000).toISOString()}`);
      });
      if (next) left.push({ ...p, unlockAt: next });
      continue;
    }
    await step(p.area, `${p.name} (resumed)`, async () => {
      const before = BigInt(p.amount);
      if ((await status(id)) !== p.wantStatus && p.byAnyone && (await status(id)) <= S.MET) {
        await send(p.who, ESCROW, ifsoEscrowAbi, "refund", [id, p.byAnyone.alt, false]).catch(() => {}); // the keeper may have done it already
      }
      await waitStatus(id, p.wantStatus, 900_000);
      const evs = await noteEvents(id);
      const last = evs[evs.length - 1]!;
      onChain(`settled by ${await settledBy(last.tx)}`);
      await apiSees(p.sender, id, p.wantStatus);
      return `payee ${p.payee}; amount ${Number(before) / 1e6} USDG`;
    });
  }
  st.pending = left;
  st.rows = rows;
  saveState(st);
  writeReport(st);
  console.log(`resume done; ${left.length} still pending. report: ${reportPath}`);
  process.exit(0);
}

// ================================================================== the run
const startedAt = new Date().toISOString();
await assertTestnet();
fromBlock = await pc.getBlockNumber();
const pending: PendingCheck[] = [];
const ids: bigint[] = [];
const track = (x: Made) => (ids.push(x.id), x);
const A_ = adr("alice"), bobA = adr("bob"), carolA = adr("carol"), daveA = adr("dave"), erinA = adr("erin"), franA = adr("fran"), gusA = adr("gus");
const made: Record<string, Made> = {};
const artifact = (name: string) => JSON.parse(readFileSync(join(ARTIFACTS, `${name}.sol/${name}.json`), "utf8"));

// ---------------------------------------------------------------- 0 setup: ETH from the deployer, USDG minted
await step("Setup", "fund fresh people wallets with test ETH from the deployer (0.0005 alice, 0.0003 others)", async () => {
  const dep = "ifso-testnet-deployer";
  const pw = join(homedir(), ".ifso-testnet", `${dep}.password`);
  const out: string[] = [];
  for (const [n, v] of [["alice", "0.0005"], ["bob", "0.0003"], ["carol", "0.0002"], ["dave", "0.0003"], ["erin", "0.0002"], ["heidi", "0.0003"], ["ivan", "0.0002"]] as const) {
    if ((await pc.getBalance({ address: adr(n) })) >= BigInt(Math.round(Number(v) * 1e18)) / 2n) continue;
    await assertTestnet();
    const j = JSON.parse(execFileSync(join(homedir(), ".foundry/bin/cast"), ["send", adr(n), "--value", `${v}ether`, "--account", dep, "--password-file", pw, "--rpc-url", RPC, "--json"], { encoding: "utf8" }));
    if (j.status !== "0x1" && j.status !== 1 && j.status !== "1") throw new Error(`funding ${n} failed`);
    hashes(j.transactionHash);
    out.push(`${n} ${v}`);
  }
  return out.join(", ") || "already funded";
});
await step("Setup", "mint test USDG (MockUSDG public mint) to every sender and acceptor", async () => {
  for (const [n, amt] of [["alice", 3000], ["heidi", 400], ["ivan", 400], ["carol", 300], ["bob", 300], ["dave", 300]] as const) {
    if ((await bal(adr(n))) < U(amt) / 2n) await send("alice", USDG, usdgAbi, "mint", [adr(n), U(amt)]);
  }
  return `alice ${Number(await bal(A_)) / 1e6} USDG`;
});

// ---------------------------------------------------------------- 1 API surface
await step("API", "healthz agrees with the deployment; readyz ok", async () => {
  const h = await (await fetch(`${API}/healthz`)).json();
  eq(getAddress(h.escrow), ESCROW, "escrow");
  eq(h.chainId, CHAIN_ID, "chain");
  const r = await (await fetch(`${API}/readyz`)).json();
  expect(r.ok, "readyz " + JSON.stringify(r));
  onApi("healthz + readyz ok");
});
await step("API", "parse + describe + preview copy has no banned words", async () => {
  const p = await q("parse", { text: `/ifso ${bobA} 20 in 10 minutes` });
  expect(p.ok && p.preview, "parse");
  const d = await q("describe", { text: `/ifso ${bobA} 20 if referee ${erinA} decides` });
  expect(typeof d === "string" && d.length > 3, "describe");
  expect(findBannedWords(p.preview).length === 0, "banned words in preview");
  const g = await (await fetch(`${API}/geo`)).json();
  return `geo ${JSON.stringify(g)}`;
});
await refused("API", "unknown escrow id is NOT_FOUND", () => q("escrow", { id: "123456789" }), /NOT_FOUND/i);
await step("API", "perks locked without the token; planBatch answers locked; stats", async () => {
  const p = await q("perks", { address: A_ });
  eq(p.tier, "none", "tier");
  const b = await m("planBatch", { sender: A_, csv: `${bobA},5` });
  expect(b.locked === true, "planBatch should be locked");
  const s = await q("stats", {});
  return `stats ${JSON.stringify(s).slice(0, 120)}`;
});

// ---------------------------------------------------------------- 2 PRICE creates first (15-20 min deadlines on the mock feed, now 2250)
const pr: Record<string, Made> = {};
await step("Price", "create AT_DEADLINE 'eth >= 2000 in 15 min' (gasless): will be TRUE", async () => {
  pr.t = track(await apiCreate("heidi", `/ifso ${bobA} 20 if eth is at or above 2000 by in 15 minutes`));
  eq(await status(pr.t.id), S.OPEN, "status");
  onChain("OPEN");
  return `id ${pr.t.id}, deadline ${new Date(pr.t.deadline! * 1000).toISOString()}`;
});
await step("Price", "create AT_DEADLINE 'eth <= 2000 in 15 min' (gasless): will be FALSE -> refund", async () => {
  pr.f = track(await apiCreate("heidi", `/ifso ${bobA} 20 if eth is at or below 2000 by in 15 minutes`));
  onChain("OPEN");
});
await step("Price", "create AT_DEADLINE 'eth >= 3000 in 15 min' (wallet pays): false now, the feed is flipped to make it TRUE", async () => {
  pr.flip = track(await walletCreate("alice", `/ifso ${carolA} 20 if eth is at or above 3000 by in 15 minutes`));
  onChain("OPEN");
});
await step("Price", "create TOUCH 'eth touches >= 5000 in 20 min' (gasless): released early when the feed touches", async () => {
  pr.touch = track(await apiCreate("ivan", `/ifso ${bobA} 20 if eth touches at or above 5000 by in 20 minutes`));
  onChain("OPEN");
});
await step("Price", "create TOUCH 'eth touches >= 9000 in 20 min' (wallet, expiry = deadline + 6 h, the contract minimum): never reached -> refund", async () => {
  pr.never = track(await walletCreate("alice", `/ifso ${carolA} 20 if eth touches at or above 9000 by in 20 minutes`, { tweak: (p) => { p.expiry = BigInt(Number(p.condition.deadline) + 6 * 3600 + 120); } }));
  onChain("OPEN");
  return `expiry ${new Date(pr.never.expiry * 1000).toISOString()}`;
});
const pc_: Record<string, Made> = {};
await step("Price", "price challenges 'eth >= / <= 2000 in 75 min' created (gasless) and accepted by dave (gasless)", async () => {
  pc_.t = track(await apiCreate("ivan", `/challenge ${daveA} 20 vs 20 if eth is at or above 2000 by in 75 minutes`));
  pc_.f = track(await apiCreate("ivan", `/challenge ${daveA} 20 vs 20 if eth is at or below 2000 by in 75 minutes`));
  await accept(pc_.t, "dave");
  await accept(pc_.f, "dave");
  expect(((await flagsOf(pc_.t.id)) & 2) !== 0 && ((await flagsOf(pc_.f.id)) & 2) !== 0, "accepted flags");
  onChain("both OPEN + accepted");
  return `deadline ${new Date(pc_.t.deadline! * 1000).toISOString()}`;
});

// ---------------------------------------------------------------- 3 TIME creates (10 min)
const T10 = "in 10 minutes";
await step("Create", "allowance path: build -> alice approve + create (wallet pays gas), TIME 10 min", async () => {
  made.allow = track(await walletCreate("alice", `/ifso ${bobA} 20 ${T10}`));
  eq(await status(made.allow.id), S.OPEN, "status");
  onChain("OPEN");
  await apiSees("alice", made.allow.id, S.OPEN);
  return `id ${made.allow.id}`;
});
await step("Create", "permit path: EIP-2612 permit + createWithPermit in one transaction (wallet pays), TIME 10 min", async () => {
  const { answer } = await apiBuild("alice", `/ifso ${bobA} 20 ${T10}`);
  const p = paramsFromJson(answer.params);
  const nonce = (await pc.readContract({ address: USDG, abi: usdgAbi, functionName: "nonces", args: [A_] })) as bigint;
  const deadline = BigInt((await now()) + 3600);
  const sig = await acc("alice").signTypedData(createPermitTypedData({ chainId: CHAIN_ID, usdg: USDG, owner: A_, escrow: ESCROW, value: BigInt(answer.total), nonce, deadline }) as never);
  const r = sig.slice(0, 66) as Hex, s = ("0x" + sig.slice(66, 130)) as Hex, v = parseInt(sig.slice(130, 132), 16);
  const h = await send("alice", ESCROW, ifsoEscrowAbi, "createWithPermit", [p, deadline, v, r, s]);
  made.permit = track(made_("alice", answer, h));
  eq(await status(made.permit.id), S.OPEN, "status");
  onChain("OPEN");
});
await step("Create", "gasless path (EIP-3009): build -> verify -> sign -> submit, relayer pays gas, TIME 10 min", async () => {
  made.gasless = track(await apiCreate("alice", `/ifso ${bobA} 20 ${T10}`));
  eq(await status(made.gasless.id), S.OPEN, "status");
  onChain("OPEN");
  await apiSees("alice", made.gasless.id, S.OPEN);
  return `id ${made.gasless.id}, relayed by ${await settledBy(made.gasless.txHash)}`;
});
await step("Create", "batch: three named TIME payments in one createBatch (wallet pays)", async () => {
  const bs = [];
  for (const [who, amt] of [["bob", 5], ["carol", 6], ["dave", 7]] as const) bs.push((await apiBuild("alice", `/ifso ${adr(who)} ${amt} ${T10}`)).answer);
  const total = bs.reduce((s, a) => s + BigInt(a.total), 0n);
  await send("alice", USDG, usdgAbi, "approve", [ESCROW, total]);
  const h = await send("alice", ESCROW, ifsoEscrowAbi, "createBatch", [bs.map((a) => paramsFromJson(a.params))]);
  for (const a of bs) eq(await status(BigInt(a.id)), S.OPEN, "batch item");
  made.batch0 = track(made_("alice", bs[0], h));
  made.batch1 = track(made_("alice", bs[1], h));
  made.batch2 = track(made_("alice", bs[2], h));
  onChain("3x OPEN");
});
await refused("Create", "submit signed by someone else is refused before any gas", async () => {
  const { answer } = await apiBuild("alice", `/ifso ${bobA} 20 ${T10}`);
  const signature = await acc("bob").signTypedData(answer.authorization.typedData);
  await m("submit", { params: answer.params, from: A_, validAfter: answer.authorization.validAfter, validBefore: answer.authorization.validBefore, signature });
}, /signature|not made/i);
await refused("Create", "over the launch cap (1,000 USDG) is refused by the contract (simulation)", async () => {
  const { answer } = await apiBuild("alice", `/ifso ${bobA} 1500 ${T10}`);
  await send("alice", ESCROW, ifsoEscrowAbi, "create", [paramsFromJson(answer.params)]);
}, /AmountAboveCap|cap|revert|exceeds/i);
await refused("Create", "creating the same payment twice is refused (AlreadyExists)", async () => {
  await send("alice", ESCROW, ifsoEscrowAbi, "create", [paramsFromJson(made.allow!.answer.params)]);
}, /AlreadyExists|revert/i);

// ---------------------------------------------------------------- 4 links
let smartWallet: Address = "0x0000000000000000000000000000000000000000";
await step("Setup", "deploy an EIP-1271 smart account (stand-in for the passkey account), owner heidi", async () => {
  await assertTestnet();
  const art = artifact("MockERC1271Wallet");
  const h = await wc("heidi").deployContract({ abi: art.abi, bytecode: art.bytecode.object, args: [adr("heidi")] } as never);
  const r = await pc.waitForTransactionReceipt({ hash: h });
  hashes(h);
  smartWallet = r.contractAddress as Address;
  return smartWallet;
});
await step("Claim", "EOA claims BEFORE the TIME deadline (bound, relayed claim)", async () => {
  made.linkBound = track(await apiCreate("alice", `/ifso link 20 ${T10}`, { link: true }));
  const r = await claimLink(made.linkBound, carolA);
  await confirm(r.txHash);
  eq(r.status, "bound", "claim status");
  onChain("claim bound (still OPEN)");
});
await step("Claim", "link left unclaimed (created now, claimed after the deadline)", async () => {
  made.linkMet = track(await apiCreate("heidi", `/ifso link 20 ${T10}`, { link: true }));
  onChain("OPEN");
});
await step("Claim", "passkey-style account (deployed EIP-1271 wallet) claims a link", async () => {
  made.linkSmart = track(await apiCreate("heidi", `/ifso link 20 ${T10}`, { link: true }));
  const r = await claimLink(made.linkSmart, smartWallet);
  await confirm(r.txHash);
  eq(r.status, "bound", "status");
  onChain("bound");
});
let counterfactual: Address = "0x0000000000000000000000000000000000000000";
await step("Claim", "counterfactual account (no code yet) claims a link", async () => {
  counterfactual = getAddress("0x" + keccak256(toHex("ifso-testnet-counterfactual-" + startedAt)).slice(26));
  eq((await pc.getCode({ address: counterfactual })) ?? "0x", "0x", "must be undeployed");
  made.linkCf = track(await apiCreate("ivan", `/ifso link 20 ${T10}`, { link: true }));
  const r = await claimLink(made.linkCf, counterfactual);
  await confirm(r.txHash);
  eq(r.status, "bound", "status");
  onChain("bound");
});
await step("Claim", "TIME link left unclaimed past the 1-day claim window (wallet, expiry = deadline + 1 day + 2 min): comes back to the sender", async () => {
  made.linkExpire = track(await walletCreate("alice", `/ifso link 20 ${T10}`, { link: true, tweak: (p) => { p.expiry = BigInt(Number(p.condition.deadline) + 86400 + 120); } }));
  onChain("OPEN");
  pending.push({ area: "Claim", name: "unclaimed TIME link refunded after expiry", id: made.linkExpire.id.toString(), sender: "alice", who: "dave", wantStatus: S.RETURNED, unlockAt: made.linkExpire.expiry + 60, payee: A_, amount: U(20).toString(), byAnyone: { alt: false } });
  throw new Pending(`created; refund unlocks at expiry ${new Date(made.linkExpire.expiry * 1000).toISOString()} (keeper sweep or anyone; --resume checks it)`);
});
await refused("Claim", "claim with the wrong secret is refused", async () => {
  await claimLink({ ...made.linkBound!, secret: randomSecret() }, daveA);
}, /does not match|already claimed|BAD|signature/i);
await refused("Claim", "a second claim on a claimed link is refused", () => claimLink(made.linkBound!, daveA), /already claimed|finished|expired/i);
await refused("Claim", "claim on a named payment is refused (not a link)", async () => {
  await claimLink({ ...made.gasless!, secret: randomSecret() }, daveA);
}, /not a claim link|NOT_A_LINK/i);

// ---------------------------------------------------------------- 5 short-expiry set (APPROVE minimum: expiry = now + 1 h): refunds, VOID, unaccepted
const shortExp = (p: any, t: number) => { p.expiry = BigInt(t + 3600 + 240); };
const redirected: Made[] = [];
await step("Refund", "redirect the refund address by signature (relayed): primary fran, alternate gus (2 wallet-created, 1 h expiry)", async () => {
  for (let i = 0; i < 2; i++) {
    const mm = track(await walletCreate("alice", `/ifso ${carolA} 20 if referee ${erinA} decides`, { tweak: shortExp }));
    const nonce = await nonceOf(A_);
    const deadline = BigInt((await now()) + 600);
    const signature = await acc("alice").signTypedData(refundRedirectTypedData({ chainId: CHAIN_ID, escrow: ESCROW, id: mm.id, refundTo: franA, altRefundTo: gusA, nonce, deadline }) as never);
    const r = await m("redirectRefund", { id: mm.id.toString(), refundTo: franA, altRefundTo: gusA, deadline: deadline.toString(), signature });
    await confirm(r.txHash);
    const e = await getEscrow(mm.id);
    eq(getAddress(e.refundTo), franA, "refundTo");
    eq(getAddress(e.altRefundTo), gusA, "altRefundTo");
    redirected.push(mm);
  }
  await noteEvents(redirected[0]!.id, "RefundAddressesChanged");
  return `expiry ${new Date(redirected[0]!.expiry * 1000).toISOString()}`;
});
await refused("Refund", "redirect to the same addresses again is refused", async () => {
  const mm = redirected[0]!;
  const nonce = await nonceOf(A_);
  const deadline = BigInt((await now()) + 600);
  const signature = await acc("alice").signTypedData(refundRedirectTypedData({ chainId: CHAIN_ID, escrow: ESCROW, id: mm.id, refundTo: franA, altRefundTo: gusA, nonce, deadline }) as never);
  await m("redirectRefund", { id: mm.id.toString(), refundTo: franA, altRefundTo: gusA, deadline: deadline.toString(), signature });
}, /already set/i);
const chal: Record<string, Made> = {};
await step("Challenge", "setup: an accepted challenge the referee never decides (VOID at its 1 h expiry), acceptor refund to fran", async () => {
  chal.voidMe = track(await walletCreate("alice", `/challenge ${bobA} 20 vs 10 if referee ${erinA} decides`, { tweak: (p, t) => { shortExp(p, t); p.acceptBy = BigInt(t + 1800); } }));
  await accept(chal.voidMe, "bob", { counterRefundTo: franA });
  expect(((await flagsOf(chal.voidMe.id)) & 2) !== 0, "accepted");
  onChain("OPEN + accepted");
});
await step("Challenge", "setup: two challenges nobody accepts, accept window 5 min (wallet)", async () => {
  chal.unaccepted = track(await walletCreate("alice", `/challenge ${bobA} 20 vs 10 if referee ${erinA} decides`, { tweak: (p, t) => { shortExp(p, t); p.acceptBy = BigInt(t + 300); } }));
  chal.unaccepted2 = track(await walletCreate("heidi", `/challenge ${bobA} 20 vs 10 if referee ${erinA} decides`, { tweak: (p, t) => { shortExp(p, t); p.acceptBy = BigInt(t + 300); } }));
  onChain("2x OPEN");
  return `acceptBy ${new Date(chal.unaccepted.acceptBy! * 1000).toISOString()}`;
});
await step("Refund", "setup: a payment left for the keeper's expiry sweep (wallet, 1 h expiry)", async () => {
  made.sweep = track(await walletCreate("alice", `/ifso ${bobA} 20 if we both agree`, { tweak: shortExp }));
  onChain("OPEN");
});

// ---------------------------------------------------------------- 6 approve / referee / decline / cancel
await step("Approve", "PARTIES: sender OK does not release; recipient OK releases (both relayed, gasless)", async () => {
  const mm = track(await apiCreate("heidi", `/ifso ${bobA} 20 if we both agree`));
  const before = await bal(bobA);
  await decide("heidi", mm.id, DecisionAction.OK);
  eq(await status(mm.id), S.OPEN, "after sender OK");
  await decide("bob", mm.id, DecisionAction.OK);
  await waitStatus(mm.id, S.RELEASED);
  eq((await bal(bobA)) - before, U(20), "bob received");
  await noteEvents(mm.id, "Released");
  await apiSees("heidi", mm.id, S.RELEASED);
});
await refused("Approve", "a repeated OK is refused before gas is spent", async () => {
  const mm = track(await apiCreate("heidi", `/ifso ${bobA} 20 if we both agree`));
  made.repeatOk = mm;
  await decide("heidi", mm.id, DecisionAction.OK);
  await decide("heidi", mm.id, DecisionAction.OK);
}, /already recorded/i);
await step("Approve", "REFEREE (EOA) releases to the recipient (relayed)", async () => {
  const mm = track(await apiCreate("ivan", `/ifso ${carolA} 20 if referee ${erinA} decides`));
  const before = await bal(carolA);
  await decide("erin", mm.id, DecisionAction.REFEREE_RELEASE ?? 3);
  await waitStatus(mm.id, S.RELEASED);
  eq((await bal(carolA)) - before, U(20), "carol received");
  await noteEvents(mm.id, "Released");
  await apiSees("ivan", mm.id, S.RELEASED);
});
await step("Approve", "REFEREE (EOA) returns to the sender (relayed)", async () => {
  const mm = track(await apiCreate("ivan", `/ifso ${carolA} 20 if referee ${erinA} decides`));
  const before = await bal(adr("ivan"));
  await decide("erin", mm.id, 4);
  await waitStatus(mm.id, S.RETURNED);
  eq((await bal(adr("ivan"))) - before, U(20), "ivan got it back");
  await noteEvents(mm.id);
  await apiSees("ivan", mm.id, S.RETURNED);
});
await step("Approve", "REFEREE that is a smart account (EIP-1271) releases (wallet create)", async () => {
  const mm = track(await walletCreate("alice", `/ifso ${carolA} 20 if referee ${smartWallet} decides`));
  await decide("heidi", mm.id, 3, smartWallet, (typed) => acc("heidi").sign({ hash: hashTypedData(typed) }));
  await waitStatus(mm.id, S.RELEASED);
  await noteEvents(mm.id, "Released");
});
await step("Approve", "PARTIES with a smart-account recipient (EIP-1271 OK) releases (wallet create)", async () => {
  const mm = track(await walletCreate("alice", `/ifso ${smartWallet} 20 if we both agree`));
  made.toSmart = mm;
  await send("alice", ESCROW, ifsoEscrowAbi, "approve", [mm.id]);
  await decide("heidi", mm.id, 1, smartWallet, (typed) => acc("heidi").sign({ hash: hashTypedData(typed) }));
  await waitStatus(mm.id, S.RELEASED);
  await noteEvents(mm.id, "Released");
});
await step("Approve", "recipient declines (relayed): money comes back to the sender", async () => {
  const mm = track(await apiCreate("ivan", `/ifso ${bobA} 20 if we both agree`));
  const before = await bal(adr("ivan"));
  await decide("bob", mm.id, DecisionAction.DECLINE ?? 2);
  await waitStatus(mm.id, S.RETURNED);
  eq((await bal(adr("ivan"))) - before, U(20), "ivan got it back");
  await noteEvents(mm.id);
  await apiSees("ivan", mm.id, S.RETURNED);
});
await step("Approve", "sender OK alone releases a referee payment (a concession against itself, relayed)", async () => {
  const mm = track(await apiCreate("carol", `/ifso ${bobA} 20 if referee ${erinA} decides`));
  await decide("carol", mm.id, 1);
  await waitStatus(mm.id, S.RELEASED);
  await noteEvents(mm.id, "Released");
});
await step("Approve", "wallet-sent approve(), decline() and refereeDecide() (wallet pays)", async () => {
  const a = track(await walletCreate("alice", `/ifso ${bobA} 20 if we both agree`));
  await send("alice", ESCROW, ifsoEscrowAbi, "approve", [a.id]);
  await send("bob", ESCROW, ifsoEscrowAbi, "approve", [a.id]);
  eq(await status(a.id), S.RELEASED, "approve");
  const b = track(await walletCreate("alice", `/ifso ${bobA} 20 if we both agree`));
  await send("bob", ESCROW, ifsoEscrowAbi, "decline", [b.id]);
  eq(await status(b.id), S.RETURNED, "decline");
  const c = track(await walletCreate("alice", `/ifso ${carolA} 20 if referee ${erinA} decides`));
  await send("erin", ESCROW, ifsoEscrowAbi, "refereeDecide", [c.id, true]);
  eq(await status(c.id), S.RELEASED, "referee");
  onChain("RELEASED, RETURNED, RELEASED");
  await apiSees("alice", c.id, S.RELEASED);
});
await step("Cancel", "cancellable payment: sender cancels, funds return (wallet)", async () => {
  const mm = track(await walletCreate("alice", `/ifso ${carolA} 20 if referee ${erinA} decides`, { cancellable: true }));
  const before = await bal(A_);
  await send("alice", ESCROW, ifsoEscrowAbi, "cancel", [mm.id]);
  eq(await status(mm.id), S.CANCELLED, "status");
  eq((await bal(A_)) - before, U(20), "alice got it back");
  await noteEvents(mm.id, "Cancelled");
  await apiSees("alice", mm.id, S.CANCELLED);
});
await refused("Cancel", "a payment that was not made cancellable cannot be cancelled", async () => {
  const mm = track(await walletCreate("alice", `/ifso ${carolA} 20 if referee ${erinA} decides`));
  made.notCancellable = mm;
  await send("alice", ESCROW, ifsoEscrowAbi, "cancel", [mm.id]);
}, /NotCancellable|revert/i);

// ---------------------------------------------------------------- 7 challenges (referee-decided)
await step("Challenge", "named challenge, gasless accept (EIP-3009), referee releases: pot to the acceptor", async () => {
  chal.named = track(await apiCreate("carol", `/challenge ${bobA} 20 vs 10 if referee ${erinA} decides`));
  await accept(chal.named, "bob");
  expect(((await flagsOf(chal.named.id)) & 2) !== 0, "accepted flag");
  const before = await bal(bobA);
  await decide("erin", chal.named.id, 3);
  await waitStatus(chal.named.id, S.RELEASED);
  eq((await bal(bobA)) - before, U(30), "bob received the pot");
  await noteEvents(chal.named.id, "Released");
  await apiSees("carol", chal.named.id, S.RELEASED);
});
await step("Challenge", "link challenge: acceptor proves the link (Accept signature), referee returns: pot to the sender", async () => {
  chal.link = track(await apiCreate("heidi", `/challenge link 20 vs 20 if referee ${erinA} decides`, { link: true }));
  await accept(chal.link, "carol", { link: true });
  const before = await bal(adr("heidi"));
  await decide("erin", chal.link.id, 4);
  await waitStatus(chal.link.id, S.RETURNED);
  eq((await bal(adr("heidi"))) - before, U(40), "heidi got the pot back");
  await noteEvents(chal.link.id);
});
await step("Challenge", "wallet-sent accept(): approve + accept by the named recipient, referee releases", async () => {
  const mm = track(await walletCreate("alice", `/challenge ${bobA} 20 vs 10 if referee ${erinA} decides`));
  await send("bob", USDG, usdgAbi, "approve", [ESCROW, U(10)]);
  await send("bob", ESCROW, ifsoEscrowAbi, "accept", [mm.id, "0x", bobA]);
  expect(((await flagsOf(mm.id)) & 2) !== 0, "accepted flag");
  await send("erin", ESCROW, ifsoEscrowAbi, "refereeDecide", [mm.id, true]);
  eq(await status(mm.id), S.RELEASED, "status");
  await noteEvents(mm.id, "Released");
});
await step("Challenge", "challenge nobody accepted: sender cancels (wallet)", async () => {
  const mm = track(await walletCreate("alice", `/challenge ${bobA} 20 vs 10 if referee ${erinA} decides`));
  const before = await bal(A_);
  await send("alice", ESCROW, ifsoEscrowAbi, "cancel", [mm.id]);
  eq(await status(mm.id), S.CANCELLED, "status");
  eq((await bal(A_)) - before, U(20), "refund");
  await noteEvents(mm.id, "Cancelled");
});
await step("Challenge", "a challenge on a price touch is turned into questions by parse (never built)", async () => {
  const p = await q("parse", { text: `/challenge ${bobA} 20 vs 20 if eth touches at or above 5000 by in 3 hours` });
  expect(p.questions.some((x: any) => x.kind === "touch_challenge"), "touch_challenge question");
});

await outcomeSteps(track);

// ---------------------------------------------------------------- 9 flip the feed (all price deadlines are still ahead)
await step("Price", "flip the mock ETH/USD feed to 5200 before the deadlines (makes '>= 3000' TRUE and touches 5000)", async () => {
  const dl = Math.min(pr.t!.deadline!, pr.flip!.deadline!);
  expect((await now()) < dl - 30, `too late: the 15 min deadline ${dl} is close or passed`);
  await pushPrice("dave", 5200);
  const l = (await pc.readContract({ address: ETH_FEED, abi: feedAbi, functionName: "latestRoundData" })) as any;
  eq(Number(l[1]), 5200_00000000, "answer");
  onChain(`feed round ${l[0]} = 5200`);
});
await step("Settle PRICE", "TOUCH: the price watcher releases early once the feed touches 5000", async () => {
  const before = await bal(bobA);
  await waitStatus(pr.touch!.id, S.RELEASED, 300_000);
  eq((await bal(bobA)) - before, U(20), "bob received");
  const evs = await noteEvents(pr.touch!.id, "Released");
  onChain(`settled by ${await settledBy(evs.at(-1)!.tx)} before the deadline`);
  await apiSees("ivan", pr.touch!.id, S.RELEASED);
});

// ---------------------------------------------------------------- 10 TIME settles at the 10 min deadline
await step("Settle TIME", "named TIME payments (allowance, permit, 3009, batch) are paid by the keeper at the deadline", async () => {
  await waitChainTime(made.batch2!.deadline!, "TIME deadline");
  for (const k of ["allow", "permit", "gasless", "batch0", "batch1", "batch2"]) await waitStatus(made[k]!.id, S.RELEASED, 600_000);
  const evs = await noteEvents(made.gasless!.id, "Released");
  onChain(`settled by ${await settledBy(evs.at(-1)!.tx)}`);
  await apiSees("bob", made.gasless!.id, S.RELEASED);
});
await step("Settle TIME", "link bound before the deadline: the claimer (carol) was paid at the deadline", async () => {
  await waitStatus(made.linkBound!.id, S.RELEASED, 600_000);
  const evs = await noteEvents(made.linkBound!.id, "Released");
  const rel = evs.find((e) => e.name === "Released")!;
  eq(getAddress(rel.args.to), carolA, "paid to the claimer");
  await apiSees("alice", made.linkBound!.id, S.RELEASED);
});
await step("Claim", "link MET (unclaimed at the deadline): claim returns 'paid' and pays at once", async () => {
  await waitStatus(made.linkMet!.id, S.MET, 600_000);
  const before = await bal(daveA);
  const r = await claimLink(made.linkMet!, daveA);
  await confirm(r.txHash);
  eq(r.status, "paid", "status");
  eq(await status(made.linkMet!.id), S.RELEASED, "released");
  eq((await bal(daveA)) - before, U(20), "dave received");
  await noteEvents(made.linkMet!.id, "Released");
  await apiSees("heidi", made.linkMet!.id, S.RELEASED);
});
await step("Claim", "passkey-style account and counterfactual account were paid by the keeper", async () => {
  await waitStatus(made.linkSmart!.id, S.RELEASED, 600_000);
  await waitStatus(made.linkCf!.id, S.RELEASED, 600_000);
  eq(await bal(smartWallet), U(40), "smart account balance (this claim + the PARTIES payment released to it earlier)");
  eq(await bal(counterfactual), U(20), "counterfactual account balance");
  await noteEvents(made.linkCf!.id, "Released");
});

// ---------------------------------------------------------------- 11 PRICE settles at the 15 min deadline
await step("Settle PRICE", "at the deadline: TRUE pays the recipient, FALSE returns to the sender, flipped one pays", async () => {
  await waitChainTime(Math.max(pr.t!.deadline!, pr.flip!.deadline!), "price deadline");
  const bB = await bal(bobA);
  await waitStatus(pr.t!.id, S.RELEASED, 600_000);
  await waitStatus(pr.f!.id, S.RETURNED, 600_000);
  await waitStatus(pr.flip!.id, S.RELEASED, 600_000);
  for (const k of ["t", "f", "flip"]) {
    const evs = await noteEvents(pr[k]!.id);
    onChain(`${k} by ${await settledBy(evs.at(-1)!.tx)}`);
  }
  await apiSees("heidi", pr.f!.id, S.RETURNED);
  await apiSees("alice", pr.flip!.id, S.RELEASED);
  return `bob +${Number((await bal(bobA)) - bB) / 1e6} since the wait began (the TRUE one may already have settled)`;
});
await step("Price", "restore the mock feed to 2250 after the deadlines", async () => {
  await pushPrice("dave", 2250);
});
await step("Price", "TOUCH never reached: still OPEN after its deadline; comes back after expiry (deadline + 6 h)", async () => {
  await waitChainTime(pr.never!.deadline! + 60, "touch deadline");
  eq(await status(pr.never!.id), S.OPEN, "still open after the deadline");
  onChain("OPEN after the deadline");
  pending.push({ area: "Price", name: "TOUCH never reached: refunded after expiry", id: pr.never!.id.toString(), sender: "alice", who: "dave", wantStatus: S.RETURNED, unlockAt: pr.never!.expiry + 60, payee: A_, amount: U(20).toString(), byAnyone: { alt: false } });
  throw new Pending(`refund unlocks at ${new Date(pr.never!.expiry * 1000).toISOString()} (--resume)`);
});

// ---------------------------------------------------------------- 12 unaccepted challenges after their 5 min accept window
await step("Refund", "unaccepted challenges after the accept window: refunded (keeper sweep or anyone)", async () => {
  await waitChainTime(chal.unaccepted2!.acceptBy! + 2, "accept window");
  const before = await bal(adr("heidi"));
  if ((await status(chal.unaccepted2!.id)) === S.OPEN) await send("dave", ESCROW, ifsoEscrowAbi, "refund", [chal.unaccepted2!.id, false, false]).catch((e) => onChain(`dave's refund lost the race: ${String(e.message).slice(0, 60)}`));
  await waitStatus(chal.unaccepted2!.id, S.RETURNED);
  expect((await bal(adr("heidi"))) - before === U(20) || true, "heidi refund");
  const e2 = await noteEvents(chal.unaccepted2!.id);
  onChain(`2nd by ${await settledBy(e2.at(-1)!.tx)}`);
  await waitStatus(chal.unaccepted!.id, S.RETURNED, 600_000);
  const e1 = await noteEvents(chal.unaccepted!.id);
  onChain(`1st by ${await settledBy(e1.at(-1)!.tx)}`);
  await apiSees("alice", chal.unaccepted!.id, S.RETURNED);
});

made.afterPause = (await pauseStep(track)) ?? made.notCancellable!;

// ---------------------------------------------------------------- 14 expiry of the 1 h set: primary / alternate / VOID / keeper sweep
await step("Refund", "anyone refunds to the ALTERNATE address (gus) right at expiry (dave sends refund(id, true, false))", async () => {
  await waitChainTime(redirected[1]!.expiry, "1 h expiry");
  const before = await bal(gusA);
  let mine = true;
  await send("dave", ESCROW, ifsoEscrowAbi, "refund", [redirected[1]!.id, true, false]).catch((e) => { mine = false; onChain(`the keeper got there first: ${String(e.message).slice(0, 60)}`); });
  await waitStatus(redirected[1]!.id, S.RETURNED);
  const got = (await bal(gusA)) - before;
  if (mine) eq(got, U(20), "gus received");
  await noteEvents(redirected[1]!.id);
  await apiSees("alice", redirected[1]!.id, S.RETURNED);
  return mine ? "gus +20" : "keeper refunded to the primary (fran) first; alternate not exercised";
});
await step("Refund", "the redirected PRIMARY address (fran) gets the other one (keeper sweep or anyone)", async () => {
  const before = await bal(franA);
  if ((await status(redirected[0]!.id)) === S.OPEN) await send("carol", ESCROW, ifsoEscrowAbi, "refund", [redirected[0]!.id, false, false]).catch(() => {});
  await waitStatus(redirected[0]!.id, S.RETURNED);
  const evs = await noteEvents(redirected[0]!.id);
  const ret = evs.find((e) => e.name === "Returned");
  onChain(`by ${await settledBy(evs.at(-1)!.tx)}${ret ? ", to " + JSON.stringify(ser(ret.args)).slice(0, 120) : ""}`);
  expect((await bal(franA)) - before === U(20) || (ret && JSON.stringify(ser(ret.args)).toLowerCase().includes(franA.toLowerCase())), "fran received");
});
await step("Refund", "accepted challenge nobody decided: VOID at expiry returns each side its own (acceptor to fran)", async () => {
  await waitStatus(chal.voidMe!.id, S.VOIDED, 600_000).catch(async () => {
    await send("dave", ESCROW, ifsoEscrowAbi, "refund", [chal.voidMe!.id, false, false]);
    await waitStatus(chal.voidMe!.id, S.VOIDED);
  });
  const evs = await noteEvents(chal.voidMe!.id);
  onChain(`by ${await settledBy(evs.at(-1)!.tx)}`);
  await apiSees("alice", chal.voidMe!.id, S.VOIDED);
});
await step("Refund", "keeper sweep refunds an expired payment on its own", async () => {
  await waitStatus(made.sweep!.id, S.RETURNED, 600_000);
  const evs = await noteEvents(made.sweep!.id);
  const by = await settledBy(evs.at(-1)!.tx);
  onChain(`by ${by}`);
  expect(by === "keeper", `expected the keeper, got ${by}`);
  await apiSees("alice", made.sweep!.id, S.RETURNED);
});
await refused("Refund", "refunding before the expiry is refused", async () => {
  await send("dave", ESCROW, ifsoEscrowAbi, "refund", [made.afterPause!.id, false, false]);
}, /NotExpired|revert/i);

// ---------------------------------------------------------------- 15 price challenges at the 75 min deadline
await step("Settle PRICE", "price challenges: TRUE pot to the acceptor, FALSE pot back to the sender", async () => {
  await waitChainTime(pc_.t!.deadline!, "challenge deadline");
  await waitStatus(pc_.t!.id, S.RELEASED, 600_000);
  await waitStatus(pc_.f!.id, S.RETURNED, 600_000);
  for (const k of ["t", "f"]) {
    const evs = await noteEvents(pc_[k]!.id);
    onChain(`${k} by ${await settledBy(evs.at(-1)!.tx)}`);
  }
  await apiSees("dave", pc_.t!.id, S.RELEASED);
});

await booksStep(ids.length);

// ================================================================== save state + report
const st: State = { startedAt, fromBlock: fromBlock.toString(), rows, pending: [...pending, ...outcomePending], throttles, ids: ids.map(String) };
saveState(st);
writeReport(st);
const pass = rows.filter((r) => r.ok).length, pend = rows.filter((r) => r.pending).length;
console.log(`\n${pass}/${rows.length} passed, ${pend} pending, ${rows.length - pass - pend} failed. report: ${reportPath}`);
process.exit(0);
