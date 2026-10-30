// Ifso command line: get your money back (or move a payment along) with no website, no bot and no Ifso server.
//
// Needs only bun, viem and a public RPC. It reads the chain, builds the exact call, checks it with a dry run, and
// PRINTS it (to, data, value and a `cast send` line). It never signs and never sends: you send it with your own wallet.
//
//   bun scripts/ifso-cli.ts status <id>
//   bun scripts/ifso-cli.ts refund <id> [--alt-sender] [--alt-counter]
//   bun scripts/ifso-cli.ts settle <id>
//   bun scripts/ifso-cli.ts claim  <id> --link-file <file|-> --recipient <your address>
//   bun scripts/ifso-cli.ts claim-void <id> [--side sender|counter] [--alt]
//   bun scripts/ifso-cli.ts list --sender <address> [--from-block <n>]
//
// Flags: --rpc <url> (default https://rpc.mainnet.chain.robinhood.com), --escrow <address> (else deployments/<chainId>.json
// next to the contracts), --from <address> (dry-run caller), --json (machine readable output).
// <id> is the escrow number: decimal, 0x hex, or the id part of a claim link.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  isAddress,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { ifsoEscrowAbi, ifsoOutcomeResolverAbi } from "../src/abi";
import { erc8056Abi } from "../src/abi/external";
import { getLogsChunked } from "../src/chain/rpc";
import { parseClaimUrl, signClaim, linkKeyAddress } from "../src/core/link";
import { evaluatePrice } from "../src/core/price";
import { Kind, PRICE_AT_DEADLINE, PRICE_TOUCH, SRC_PYTH, Status, Verdict, ZERO_ADDRESS, type Condition } from "../src/core/types";
import type { Deps } from "../src/workers/deps";
import { chainSource, decideAtDeadline, earliestRound, lastRoundAtOrBefore, roundsAfter } from "../src/workers/rounds";

export const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";
const RESOLVER_FINAL = 4;
const RESOLVER_VOID = 5;
const DEAD_FROM = "0x000000000000000000000000000000000000dEaD" as Address;

export interface UnsignedCall {
  to: Address;
  data: Hex;
  value: string; // wei, decimal string
  fn: string; // function signature
  args: string[]; // as cast takes them
  chainId: number;
}

export class CliError extends Error {}

// ------------------------------------------------------------------------------------------------ args
export interface Parsed {
  cmd: string;
  pos: string[];
  flags: Record<string, string | true>;
}

const VALUE_FLAGS = new Set(["rpc", "escrow", "from", "sender", "recipient", "from-block", "deployments", "keystore", "link-file", "side"]);

export function parseArgs(argv: string[]): Parsed {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) flags[name] = a.slice(eq + 1);
      else if (VALUE_FLAGS.has(name)) {
        const v = argv[++i];
        if (v === undefined || v.startsWith("--")) throw new CliError(`--${name} needs a value`);
        flags[name] = v;
      } else flags[name] = true;
    } else pos.push(a);
  }
  const [cmd = "", ...rest] = pos;
  return { cmd, pos: rest, flags };
}

const flagStr = (p: Parsed, n: string): string | undefined => (typeof p.flags[n] === "string" ? (p.flags[n] as string) : undefined);

function parseId(s: string | undefined): bigint {
  if (!s) throw new CliError("missing <id>");
  try {
    if (/^(0x[0-9a-fA-F]+|\d+)$/.test(s)) return BigInt(s);
  } catch {}
  throw new CliError(`bad id "${s}": use a number or 0x hex`);
}

function parseAddr(label: string, s: string | undefined): Address {
  if (!s || !isAddress(s)) throw new CliError(`${label} must be an address (0x...)`);
  return getAddress(s);
}

// ------------------------------------------------------------------------------------------------ setup
interface Ctx {
  pc: PublicClient;
  rpc: string;
  chainId: number;
  escrow: Address;
  deployBlock?: bigint;
  from: Address;
}

function findDeployment(chainId: number, dir?: string): { escrow?: Address; block?: bigint } {
  const here = import.meta.dir;
  const dirs = [dir, join(process.cwd(), "contracts/deployments"), join(here, "../../contracts/deployments"), join(process.cwd(), "../contracts/deployments")].filter(Boolean) as string[];
  for (const d of dirs) {
    const f = join(d, `${chainId}.json`);
    if (!existsSync(f)) continue;
    try {
      const j = JSON.parse(readFileSync(f, "utf8"));
      const a = j?.contracts?.IfsoEscrow?.address;
      const b = j?.deployBlockAtSimulation;
      return { escrow: a && isAddress(a) ? getAddress(a) : undefined, block: b !== undefined ? BigInt(b) : undefined };
    } catch {}
  }
  return {};
}

async function setup(p: Parsed, rpcOverride?: PublicClient): Promise<Ctx> {
  const rpc = flagStr(p, "rpc") ?? process.env.IFSO_RPC ?? DEFAULT_RPC;
  const pc = rpcOverride ?? (createPublicClient({ transport: http(rpc, { retryCount: 3 }) }) as PublicClient);
  const chainId = await pc.getChainId().catch((e) => {
    throw new CliError(`cannot reach the RPC ${rpc}: ${(e as Error).message.split("\n")[0]}`);
  });
  const dep = findDeployment(chainId, flagStr(p, "deployments"));
  const given = flagStr(p, "escrow") ?? process.env.IFSO_ESCROW;
  const escrow = given ? parseAddr("--escrow", given) : dep.escrow;
  if (!escrow) throw new CliError(`no escrow address: pass --escrow <address> (no deployments/${chainId}.json found)`);
  const code = await pc.getCode({ address: escrow });
  if (!code || code === "0x") throw new CliError(`no contract at ${escrow} on chain ${chainId}`);
  const from = flagStr(p, "from") ? parseAddr("--from", flagStr(p, "from")) : DEAD_FROM;
  return { pc, rpc, chainId, escrow, deployBlock: dep.block, from };
}

// ------------------------------------------------------------------------------------------------ chain reads
type EscrowRow = {
  sender: Address;
  amount: bigint;
  recipient: Address;
  counterAmount: bigint;
  linkKey: Address;
  activeFrom: bigint;
  status: number;
  flags: number;
  refundTo: Address;
  expiry: bigint;
  altRefundTo: Address;
  acceptBy: bigint;
  counterRefundTo: Address;
  conditionHash: Hex;
};

const F_TWO_SIDED = 1;
const F_ACCEPTED = 2;

async function readEscrow(c: Ctx, id: bigint): Promise<EscrowRow> {
  const e = (await c.pc.readContract({ address: c.escrow, abi: ifsoEscrowAbi, functionName: "getEscrow", args: [id] })) as unknown as EscrowRow;
  if (Number(e.status) === Status.NONE) throw new CliError(`escrow ${id} does not exist on this contract`);
  return e;
}

async function readCondition(c: Ctx, id: bigint): Promise<Condition> {
  return (await c.pc.readContract({ address: c.escrow, abi: ifsoEscrowAbi, functionName: "getCondition", args: [id] })) as unknown as Condition;
}

const chainTime = async (c: Ctx) => (await c.pc.getBlock({ blockTag: "latest" })).timestamp;
const iso = (t: bigint) => (t === 0n ? "-" : new Date(Number(t) * 1000).toISOString());
const usdg = (v: bigint) => `${formatUnits(v, 6)} USDG`;
const STATUS_NAMES = ["none", "open", "met (waiting for a recipient)", "released", "returned to the sender", "voided (both sides returned)", "cancelled"];
const KIND_NAMES = ["none", "time", "price", "approve", "outcome"];

// ------------------------------------------------------------------------------------------------ call building
async function buildCall(c: Ctx, fn: string, args: unknown[], display: string[], extra?: { value?: bigint; abi?: Abi }): Promise<UnsignedCall> {
  const data = encodeFunctionData({ abi: ifsoEscrowAbi as Abi, functionName: fn, args });
  const value = extra?.value ?? 0n;
  // Dry run: the contract's own checks decide, not this tool.
  try {
    await c.pc.call({ account: c.from, to: c.escrow, data, value });
  } catch (e) {
    const msg = String((e as { shortMessage?: string }).shortMessage ?? (e as Error).message).split("\n")[0];
    throw new CliError(`the contract would reject this call right now: ${msg}`);
  }
  const sig = (ifsoEscrowAbi as readonly { type: string; name?: string; inputs?: readonly { type: string }[] }[]).find((x) => x.type === "function" && x.name === fn)!;
  return { to: c.escrow, data, value: value.toString(), fn: `${fn}(${sig.inputs!.map((i) => i.type).join(",")})`, args: display, chainId: c.chainId };
}

// ------------------------------------------------------------------------------------------------ commands
export async function cmdStatus(c: Ctx, id: bigint) {
  const e = await readEscrow(c, id);
  const cond = await readCondition(c, id);
  const now = await chainTime(c);
  const twoSided = (Number(e.flags) & F_TWO_SIDED) !== 0;
  const accepted = (Number(e.flags) & F_ACCEPTED) !== 0;
  const live = Number(e.status) === Status.OPEN || Number(e.status) === Status.MET;
  const unaccepted = twoSided && !accepted && now > e.acceptBy;
  const refundable = live && (now >= e.expiry || unaccepted);
  const info = {
    id: id.toString(),
    escrow: c.escrow,
    chainId: c.chainId,
    status: STATUS_NAMES[Number(e.status)] ?? String(e.status),
    statusCode: Number(e.status),
    kind: KIND_NAMES[Number(cond.kind)] ?? String(cond.kind),
    sender: e.sender,
    recipient: e.recipient,
    isClaimLink: e.linkKey !== ZERO_ADDRESS,
    amount: usdg(e.amount),
    counterAmount: usdg(e.counterAmount),
    twoSided,
    accepted,
    refundTo: e.refundTo,
    altRefundTo: e.altRefundTo,
    deadline: iso(cond.deadline),
    expiry: iso(e.expiry),
    chainTime: iso(now),
    refundableNow: refundable,
    next: refundable
      ? `Anyone can send the money back now: ifso-cli refund ${id}`
      : live
        ? `Not refundable until ${iso(e.expiry)}. If the condition is decided before then: ifso-cli settle ${id}`
        : "Finished: nothing left to do.",
  };
  return info;
}

export async function cmdRefund(c: Ctx, id: bigint, senderAlt: boolean, counterAlt: boolean) {
  const e = await readEscrow(c, id);
  const now = await chainTime(c);
  const st = Number(e.status);
  if (st !== Status.OPEN && st !== Status.MET) throw new CliError(`escrow ${id} is already finished (${STATUS_NAMES[st]}): nothing to refund`);
  const twoSided = (Number(e.flags) & F_TWO_SIDED) !== 0;
  const accepted = (Number(e.flags) & F_ACCEPTED) !== 0;
  const unaccepted = twoSided && !accepted && now > e.acceptBy;
  if (now < e.expiry && !unaccepted) throw new CliError(`not refundable yet: expiry is ${iso(e.expiry)} (chain time ${iso(now)})`);
  return buildCall(c, "refund", [id, senderAlt, counterAlt], [id.toString(), String(senderAlt), String(counterAlt)]);
}

/** The settle proof for this escrow, built the way the keeper builds it (same round finder, same evaluator rules). */
export async function cmdSettle(c: Ctx, id: bigint) {
  const e = await readEscrow(c, id);
  const cond = await readCondition(c, id);
  const now = await chainTime(c);
  if (Number(e.status) !== Status.OPEN) throw new CliError(`escrow ${id} is ${STATUS_NAMES[Number(e.status)]}: it cannot be settled`);
  if (now >= e.expiry) throw new CliError(`escrow ${id} has expired: use refund instead`);
  if (((Number(e.flags) & F_TWO_SIDED) !== 0) && (Number(e.flags) & F_ACCEPTED) === 0) throw new CliError("this challenge has not been accepted yet");
  const kind = Number(cond.kind);
  let proof: Hex = "0x";
  let note = "";
  let value = 0n;
  if (kind === Kind.TIME) {
    if (now <= cond.deadline) throw new CliError(`the date has not been reached: ${iso(cond.deadline)} (chain time ${iso(now)})`);
    note = "date reached";
  } else if (kind === Kind.OUTCOME) {
    const [state] = (await c.pc.readContract({ address: cond.target, abi: ifsoOutcomeResolverAbi, functionName: "outcomeOf", args: [cond.key] })) as unknown as [number];
    if (Number(state) !== RESOLVER_FINAL && Number(state) !== RESOLVER_VOID) throw new CliError(`the result is not final yet (resolver state ${state})`);
    note = "result is final";
  } else if (kind === Kind.PRICE) {
    if (cond.source === SRC_PYTH) throw new CliError("this condition uses a Pyth price update, which needs a signed update from Pyth's service: the CLI cannot build it");
    ({ proof, note } = await priceProof(c, e, cond, now));
  } else if (kind === Kind.APPROVE) {
    throw new CliError("this payment unlocks by OK from the parties or a referee (approve / decline / refereeDecide), not by settle");
  } else throw new CliError("unknown condition kind");
  const call = await buildCall(c, "settle", [id, proof, false], [id.toString(), proof, "false"], { value });
  return { call, note };
}

async function priceProof(c: Ctx, e: EscrowRow, cond: Condition, now: bigint): Promise<{ proof: Hex; note: string }> {
  // The shared round finder only needs the public client; it never touches the database.
  const deps = { clients: { publicClient: c.pc } } as unknown as Deps;
  const src = chainSource(deps, cond.target);
  const multiplier = cond.stockToken !== ZERO_ADDRESS ? ((await c.pc.readContract({ address: cond.stockToken, abi: erc8056Abi, functionName: "uiMultiplier" })) as bigint) : 0n;
  const ctx = { now, createdAt: e.activeFrom, currentMultiplier: multiplier };
  let proofId: bigint | undefined;
  let verdict: Verdict;
  let reason: string;
  if (cond.mode === PRICE_AT_DEADLINE) {
    const ev = await decideAtDeadline(src, cond, ctx);
    proofId = ev.proofRoundId;
    verdict = ev.verdict;
    reason = ev.reason;
  } else if (cond.mode === PRICE_TOUCH) {
    const from = cond.start > e.activeFrom ? cond.start : e.activeFrom;
    const before = await lastRoundAtOrBefore(src, from - 1n);
    const first = before ?? (await earliestRound(src));
    const startId = before ? before.roundId : first ? first.roundId - 1n : undefined;
    if (startId === undefined) throw new CliError("the price feed has no readable rounds");
    const rounds = await roundsAfter(src, startId, 5000);
    const ev = evaluatePrice(cond, rounds, ctx);
    proofId = ev.proofRoundId;
    verdict = ev.verdict;
    reason = ev.reason;
  } else throw new CliError("unknown price mode");
  if (verdict === Verdict.PENDING || proofId === undefined) throw new CliError(`not decidable yet: ${reason}`);
  return { proof: encodeAbiParameters([{ type: "uint80" }], [proofId]), note: `${reason}; verdict ${Verdict[verdict]}; proof round ${proofId}` };
}

export async function cmdClaim(c: Ctx, id: bigint | undefined, url: string, recipient: Address) {
  const parsed = parseClaimUrl(url);
  if (id !== undefined && id !== parsed.id) throw new CliError("the id you gave is not the id inside the claim link");
  const e = await readEscrow(c, parsed.id);
  if (e.linkKey === ZERO_ADDRESS) throw new CliError("this payment is not a claim link");
  if (linkKeyAddress(parsed.secret) !== e.linkKey) throw new CliError("this claim link does not match the payment (wrong link or wrong chain/contract)");
  if (e.recipient !== ZERO_ADDRESS) throw new CliError(`already claimed: bound to ${e.recipient}`);
  const sig = await signClaim({ secret: parsed.secret, chainId: c.chainId, escrow: c.escrow, id: parsed.id, recipient, conditionHash: e.conditionHash });
  return buildCall(c, "claim", [parsed.id, recipient, sig], [parsed.id.toString(), recipient, sig]);
}

const F_SENDER_OWED = 32;
const F_COUNTER_OWED = 64;

/** claimVoid: pays a VOIDED challenge side whose refund could not be sent (DECISIONS #22 shutdown path, review R2-I2). */
export async function cmdClaimVoid(c: Ctx, id: bigint, side: "sender" | "counter" | undefined, alt: boolean) {
  const e = await readEscrow(c, id);
  if (Number(e.status) !== Status.VOIDED) throw new CliError(`escrow ${id} is ${STATUS_NAMES[Number(e.status)]}, not VOIDED: nothing is held for a side`);
  const owed = { sender: (Number(e.flags) & F_SENDER_OWED) !== 0, counter: (Number(e.flags) & F_COUNTER_OWED) !== 0 };
  if (!owed.sender && !owed.counter) throw new CliError(`escrow ${id}: both sides were already paid`);
  const pick = side ?? (owed.sender && owed.counter ? undefined : owed.sender ? "sender" : "counter");
  if (!pick) throw new CliError("both sides are still owed: choose one with --side sender or --side counter");
  if (!owed[pick]) throw new CliError(`escrow ${id}: the ${pick} side was already paid`);
  return buildCall(c, "claimVoid", [id, pick === "counter", alt], [id.toString(), String(pick === "counter"), String(alt)]);
}

/** The claim link holds the secret: read it from a file or stdin, never from argv (shell history, ps). Review R2-I7. */
async function readLink(p: Parsed, io: Io): Promise<string> {
  const f = flagStr(p, "link-file");
  if (!f) throw new CliError("give the claim link with --link-file <file> (or --link-file - and paste it on stdin); it holds a secret, so it never goes on the command line");
  let raw: string;
  if (f === "-") {
    if (!io.readStdin) throw new CliError("stdin is not available here: use --link-file <file>");
    raw = await io.readStdin();
  } else {
    if (!existsSync(f) || !statSync(f).isFile()) throw new CliError(`--link-file: ${f} is not a file`);
    raw = readFileSync(f, "utf8");
  }
  const url = raw.trim().split(/\s+/)[0] ?? "";
  if (!url) throw new CliError("the link file is empty");
  return url;
}

export async function cmdList(c: Ctx, sender: Address, fromBlock?: bigint) {
  const created = (ifsoEscrowAbi as readonly { type: string; name?: string }[]).find((x) => x.type === "event" && x.name === "Created")!;
  const head = await c.pc.getBlockNumber();
  const logs = (await getLogsChunked(c.pc, { address: c.escrow, events: [created] as never, fromBlock: fromBlock ?? c.deployBlock ?? 0n, toBlock: head })) as unknown as Array<{ args: { id: bigint; sender: Address } }>;
  const mine = logs.filter((l) => l.args.sender.toLowerCase() === sender.toLowerCase());
  const rows = [];
  for (const l of mine) {
    const e = await readEscrow(c, l.args.id);
    rows.push({ id: l.args.id.toString(), status: STATUS_NAMES[Number(e.status)], amount: usdg(e.amount), expiry: iso(e.expiry) });
  }
  return { sender, escrow: c.escrow, scannedFrom: String(fromBlock ?? c.deployBlock ?? 0n), scannedTo: head.toString(), escrows: rows };
}

// ------------------------------------------------------------------------------------------------ output
function castLine(call: UnsignedCall, rpc: string): string {
  const args = call.args.map((a) => (/^0x[0-9a-fA-F]*$/.test(a) || /^(\d+|true|false)$/.test(a) ? a : JSON.stringify(a))).join(" ");
  const v = call.value !== "0" ? ` --value ${call.value}` : "";
  return `cast send ${call.to} "${call.fn}" ${args} --rpc-url ${rpc}${v} --keystore <your-keystore-file>   # or --ledger`;
}

function printCall(io: Io, p: Parsed, call: UnsignedCall, rpc: string, note?: string) {
  if (p.flags.json) {
    io.out(JSON.stringify({ ...call, castCommand: castLine(call, rpc), note }, null, 2));
    return;
  }
  if (note) io.out(note);
  io.out("Nothing has been sent. This is the call to send from your own wallet:");
  io.out(`  to:     ${call.to}`);
  io.out(`  value:  ${call.value}`);
  io.out(`  data:   ${call.data}`);
  io.out(`  chain:  ${call.chainId}`);
  io.out("With Foundry's cast (the keystore prompts for its password; nothing is stored):");
  io.out(`  ${castLine(call, rpc)}`);
  io.out("Or paste the function and arguments into the block explorer's Write Contract tab.");
}

export interface Io {
  out(s: string): void;
  err(s: string): void;
  /** the whole of stdin (claim --link-file -) */
  readStdin?(): Promise<string>;
}

const USAGE = `ifso-cli: get your money back without the website.
  status <id>                              what state is this payment in
  refund <id> [--alt-sender] [--alt-counter]   send the money back (anyone, after expiry)
  settle <id>                              build the proof for a date, price or result payment
  claim  <id> --link-file <file|-> --recipient <you>   bind a claim link to your address (link read from a file or stdin)
  claim-void <id> [--side sender|counter] [--alt]   pay a voided challenge side that is still held
  list --sender <address> [--from-block n]    payments an address created
flags: --rpc <url>  --escrow <address>  --from <address>  --json`;

/** Run one command. Returns the process exit code. `client` lets tests inject a public client. */
export async function runCli(argv: string[], io: Io, client?: PublicClient): Promise<number> {
  try {
    const p = parseArgs(argv);
    if (!p.cmd || p.cmd === "help" || p.flags.help) {
      io.out(USAGE);
      return p.cmd ? 0 : 1;
    }
    if (!["status", "refund", "settle", "claim", "claim-void", "list"].includes(p.cmd)) throw new CliError(`unknown command "${p.cmd}"\n${USAGE}`);
    const c = await setup(p, client);
    if (p.cmd === "status") {
      const s = await cmdStatus(c, parseId(p.pos[0]));
      io.out(p.flags.json ? JSON.stringify(s, null, 2) : Object.entries(s).map(([k, v]) => `${k.padEnd(14)} ${v}`).join("\n"));
    } else if (p.cmd === "refund") {
      printCall(io, p, await cmdRefund(c, parseId(p.pos[0]), Boolean(p.flags["alt-sender"]), Boolean(p.flags["alt-counter"])), c.rpc);
    } else if (p.cmd === "settle") {
      const { call, note } = await cmdSettle(c, parseId(p.pos[0]));
      printCall(io, p, call, c.rpc, note);
    } else if (p.cmd === "claim-void") {
      const side = flagStr(p, "side");
      if (side !== undefined && side !== "sender" && side !== "counter") throw new CliError("--side is sender or counter");
      printCall(io, p, await cmdClaimVoid(c, parseId(p.pos[0]), side, Boolean(p.flags.alt)), c.rpc);
    } else if (p.cmd === "claim") {
      if (p.pos.some((a) => a.includes("://") || a.includes("#"))) throw new CliError("do not put the claim link on the command line (it lands in shell history and the process list): use --link-file <file> or --link-file -");
      const url = await readLink(p, io);
      const id = p.pos.length ? parseId(p.pos[0]) : undefined;
      const rec = parseAddr("--recipient (your address)", flagStr(p, "recipient"));
      printCall(io, p, await cmdClaim(c, id, url, rec), c.rpc);
    } else {
      const r = await cmdList(c, parseAddr("--sender", flagStr(p, "sender")), flagStr(p, "from-block") ? BigInt(flagStr(p, "from-block")!) : undefined);
      if (p.flags.json) io.out(JSON.stringify(r, null, 2));
      else {
        io.out(`${r.escrows.length} payment(s) created by ${r.sender} (blocks ${r.scannedFrom} to ${r.scannedTo})`);
        for (const x of r.escrows) io.out(`  #${x.id}  ${x.status}  ${x.amount}  expires ${x.expiry}`);
      }
    }
    return 0;
  } catch (e) {
    io.err(`error: ${e instanceof CliError ? e.message : (e as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2), { out: (s) => console.log(s), err: (s) => console.error(s), readStdin: () => Bun.stdin.text() });
  process.exit(code);
}

export { toHex };
