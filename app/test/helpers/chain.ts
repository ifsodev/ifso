// Local test chain for the keeper, watcher and indexer suites: a private anvil on port 8745 with the contracts
// deployed from forge artifacts, plus a throwaway Postgres 16 cluster on a free port. Test keys are generated per run
// and funded on the local anvil only. Everything here stops the processes it started, by PID.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { ifsoEscrowAbi, ifsoOutcomeResolverAbi } from "../../src/abi";
import { makeClients } from "../../src/chain";
import { loadEnv } from "../../src/config/env";
import { createDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { Kind, ZERO_ADDRESS, ZERO_BYTES32, emptyCondition, type Condition, type CreateParams } from "../../src/core/types";
import type { Deps } from "../../src/workers/deps";
import { pgBin, startPg } from "./pg";

export const ANVIL_PORT = Number(process.env.IFSO_TEST_ANVIL_PORT ?? 8745);
export const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const CONTRACTS = join(import.meta.dir, "../../../contracts");
const FOUNDRY_BIN = join(process.env.HOME ?? "", ".foundry/bin");

export const anvilPath = () => Bun.which("anvil") ?? (existsSync(join(FOUNDRY_BIN, "anvil")) ? join(FOUNDRY_BIN, "anvil") : undefined);
const forgePath = () => Bun.which("forge") ?? (existsSync(join(FOUNDRY_BIN, "forge")) ? join(FOUNDRY_BIN, "forge") : undefined);
export const haveAnvil = () => Boolean(anvilPath() && (forgePath() || existsSync(artifact("IfsoEscrow"))));
export const havePostgres = () => Boolean(pgBin());

function artifact(name: string) {
  return join(CONTRACTS, "out", `${name}.sol`, `${name}.json`);
}

// Newest modification time under contracts/src (the artifacts are gitignored and go stale after a rebase).
function newestSource(dir = join(CONTRACTS, "src")): number {
  let m = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    m = Math.max(m, e.isDirectory() ? newestSource(p) : statSync(p).mtimeMs);
  }
  return m;
}
let rebuilt = false;

function loadArtifact(name: string): { abi: Abi; bytecode: Hex } {
  const stale = existsSync(artifact(name)) && !rebuilt && Boolean(forgePath()) && newestSource() > statSync(artifact(name)).mtimeMs;
  if (stale) rebuilt = true;
  if (!existsSync(artifact(name)) || stale) {
    const forge = forgePath();
    if (!forge) throw new Error("forge is missing and contracts/out has no artifacts");
    const r = Bun.spawnSync([forge, "build"], { cwd: CONTRACTS, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`forge build failed: ${r.stderr.toString().slice(0, 500)}`);
  }
  const j = JSON.parse(readFileSync(artifact(name), "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TestChain {
  rpc: string;
  pc: PublicClient;
  stop(): void;
  wallet(a: PrivateKeyAccount): WalletClient;
  /** funded accounts: deployer, keeper, relayer, resolver, and people */
  deployer: PrivateKeyAccount;
  keeperKey: Hex;
  relayerKey: Hex;
  resolverKey: Hex;
  sender: PrivateKeyAccount;
  alice: PrivateKeyAccount;
  bob: PrivateKeyAccount;
  usdg: Address;
  evaluator: Address;
  escrow: Address;
  resolver: Address;
  router: Address;
  rpcCall<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  mine(n?: number): Promise<void>;
  /** Mine a block stamped `ts`, so the next transactions are judged at (or just after) that time. */
  warpTo(ts: bigint): Promise<void>;
  now(): Promise<bigint>;
  snapshot(): Promise<string>;
  revert(id: string): Promise<void>;
  deploy(name: string, args?: unknown[], from?: PrivateKeyAccount): Promise<Address>;
  /** A MockAggregator feed registered in the evaluator. `phase0` starts it at phase 0 like the live SPY/TSLA/AAPL proxies. */
  newFeed(opts?: { phase0?: boolean; startAgg?: bigint; stockToken?: Address }): Promise<Address>;
  push(feed: Address, answer: bigint, updatedAt: bigint): Promise<bigint>;
  newPhase(feed: Address): Promise<void>;
  write(from: PrivateKeyAccount, address: Address, abi: Abi, functionName: string, args?: unknown[]): Promise<Hex>;
  fund(a: Address, eth?: bigint): Promise<void>;
  mint(to: Address, usdg: number): Promise<void>;
  /** approve + create. Returns the escrow id. */
  create(from: PrivateKeyAccount, p: Partial<CreateParams> & { condition: Condition; salt?: Hex }): Promise<bigint>;
  balance(a: Address): Promise<bigint>;
}

export async function bootChain(): Promise<TestChain> {
  const bin = anvilPath();
  if (!bin) throw new Error("anvil missing");
  // Another lane's anvil on the same port would be silently shared (wrong chain state, hung waits): fail fast instead.
  const probe = () => fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}', signal: AbortSignal.timeout(500) }).then(() => true, () => false);
  for (let i = 0; i < 20 && (await probe()); i++) {
    if (i === 19) throw new Error(`port ${ANVIL_PORT} already has a node answering; set IFSO_TEST_ANVIL_PORT to a free port for this lane`);
    await sleep(250); // a previous suite's anvil may still be shutting down
  }
  const proc = Bun.spawn([bin, "--port", String(ANVIL_PORT), "--chain-id", "31337", "--silent", "--host", "127.0.0.1"], { stdout: "ignore", stderr: "ignore" });
  const pc = createPublicClient({ transport: http(RPC), pollingInterval: 50 }) as PublicClient;
  for (let i = 0; i < 100; i++) {
    try {
      await pc.getChainId();
      break;
    } catch {
      await sleep(100);
    }
  }
  const rpcCall = async <T>(method: string, params: unknown[] = []) => (await pc.request({ method, params } as never)) as T;
  const chain = { id: 31337, name: "local", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
  const wallet = (a: PrivateKeyAccount) => createWalletClient({ chain, transport: http(RPC), account: a, pollingInterval: 50 }) as WalletClient;

  const mk = () => {
    const k = generatePrivateKey();
    return { k, a: privateKeyToAccount(k) };
  };
  const deployerK = mk(), keeperK = mk(), relayerK = mk(), resolverK = mk(), senderK = mk(), aliceK = mk(), bobK = mk();
  const fund = async (a: Address, eth = 100n * 10n ** 18n) => void (await rpcCall("anvil_setBalance", [a, toHex(eth)]));
  for (const x of [deployerK, keeperK, relayerK, resolverK, senderK, aliceK, bobK]) await fund(x.a.address);

  const write = async (from: PrivateKeyAccount, address: Address, abi: Abi, functionName: string, args: unknown[] = []) => {
    const hash = await wallet(from).writeContract({ address, abi, functionName, args, chain, account: from } as never);
    const r = await pc.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} reverted`);
    return hash;
  };
  const deploy = async (name: string, args: unknown[] = [], from = deployerK.a) => {
    const { abi, bytecode } = loadArtifact(name);
    const hash = await wallet(from).deployContract({ abi, bytecode, args, chain, account: from } as never);
    const r = await pc.waitForTransactionReceipt({ hash });
    if (!r.contractAddress) throw new Error(`${name} did not deploy`);
    return r.contractAddress;
  };

  const d = deployerK.a.address;
  const usdg = await deploy("MockUSDG");
  const router = await deploy("FeeRouter", [d, usdg, ...[1, 2, 3, 4].map((i) => `0x${i.toString(16).padStart(40, "0")}`)]);
  const evaluator = await deploy("IfsoConditionEvaluator", [d, ZERO_ADDRESS, ZERO_ADDRESS]);
  const resolver = await deploy("IfsoOutcomeResolver", [d, usdg, 7200, 72 * 3600, 10_000_000n, d, router]); // audit M-1: forfeited bond halves go to the FeeRouter
  const escrow = await deploy("IfsoEscrow", [d, usdg, evaluator, router, 250_000n, 500_000n]);
  const evalAbi = loadArtifact("IfsoConditionEvaluator").abi;
  await write(deployerK.a, evaluator, evalAbi, "setResolver", [resolver, true]);
  await write(deployerK.a, resolver, ifsoOutcomeResolverAbi as Abi, "setCreator", [d, true]);

  const mockAbi = loadArtifact("MockAggregator").abi;
  const usdgAbi = loadArtifact("MockUSDG").abi;
  const t: TestChain = {
    rpc: RPC,
    pc,
    wallet,
    deployer: deployerK.a,
    keeperKey: keeperK.k,
    relayerKey: relayerK.k,
    resolverKey: resolverK.k,
    sender: senderK.a,
    alice: aliceK.a,
    bob: bobK.a,
    usdg,
    evaluator,
    escrow,
    resolver,
    router,
    rpcCall,
    write,
    deploy,
    fund,
    stop: () => void proc.kill(),
    async mine(n = 1) {
      await rpcCall("anvil_mine", [toHex(n)]);
    },
    async warpTo(ts) {
      await rpcCall("evm_setNextBlockTimestamp", [toHex(ts)]);
      await rpcCall("evm_mine");
    },
    async now() {
      return (await pc.getBlock()).timestamp;
    },
    async snapshot() {
      return rpcCall<string>("evm_snapshot");
    },
    async revert(id) {
      await rpcCall("evm_revert", [id]);
    },
    async newFeed(o = {}) {
      const feed = await deploy("MockAggregator", ["TEST / USD"]);
      if (o.phase0) await rpcCall("anvil_setStorageAt", [feed, toHex(1, { size: 32 }), toHex(0, { size: 32 })]); // phaseId 0
      if (o.startAgg) {
        // aggRound sits above phaseId (uint16) in slot 1: round numbers continue from startAgg, like the live phase-0 ids (191)
        const cur = BigInt(await rpcCall<string>("eth_getStorageAt", [feed, toHex(1, { size: 32 }), "latest"]));
        await rpcCall("anvil_setStorageAt", [feed, toHex(1, { size: 32 }), toHex(cur | (o.startAgg << 16n), { size: 32 })]);
      }
      await write(deployerK.a, evaluator, evalAbi, "setFeed", [feed, true, o.stockToken ?? ZERO_ADDRESS]);
      return feed;
    },
    async push(feed, answer, updatedAt) {
      await write(deployerK.a, feed, mockAbi, "push", [answer, updatedAt]);
      return (await pc.readContract({ address: feed, abi: mockAbi, functionName: "latestId" })) as bigint;
    },
    async newPhase(feed) {
      await write(deployerK.a, feed, mockAbi, "newPhase");
    },
    async mint(to, amount) {
      await write(deployerK.a, usdg, usdgAbi, "mint", [to, BigInt(Math.round(amount * 1e6))]);
    },
    async balance(a) {
      return (await pc.readContract({ address: usdg, abi: usdgAbi, functionName: "balanceOf", args: [a] })) as bigint;
    },
    async create(from, p) {
      const now = Number(await t.now());
      const params: CreateParams = {
        amount: 20_000_000n,
        counterAmount: 0n,
        recipient: p.linkKey && p.linkKey !== ZERO_ADDRESS ? ZERO_ADDRESS : (p.recipient ?? t.alice.address),
        linkKey: ZERO_ADDRESS,
        refundTo: ZERO_ADDRESS,
        altRefundTo: ZERO_ADDRESS,
        expiry: BigInt(now + 30 * 86400),
        acceptBy: 0n,
        twoSided: false,
        cancellable: false,
        salt: keccak256(toHex(Math.random().toString() + now)),
        ...p,
      } as CreateParams;
      const total = params.amount + 5_000_000n; // covers any fee
      await t.mint(from.address, Number(total) / 1e6);
      await write(from, usdg, usdgAbi, "approve", [escrow, total]);
      await write(from, escrow, ifsoEscrowAbi as Abi, "create", [params]);
      return (await pc.readContract({ address: escrow, abi: ifsoEscrowAbi, functionName: "idFor", args: [from.address, params.salt] })) as bigint;
    },
  };
  return t;
}

export function makeTestDeps(chain: TestChain, db: Deps["db"], extra: Record<string, string> = {}, log: Deps["log"] = () => {}): Deps {
  const env = loadEnv({
    NODE_ENV: "test",
    CHAIN_ID: "31337",
    RHC_RPC_URLS: chain.rpc,
    ESCROW_ADDRESS: chain.escrow,
    EVALUATOR_ADDRESS: chain.evaluator,
    RESOLVER_ADDRESS: chain.resolver,
    USDG_ADDRESS: chain.usdg,
    KEEPER_PK: chain.keeperKey,
    RELAYER_PK: chain.relayerKey,
    RESOLVER_PK: chain.resolverKey,
    CONFIRMATIONS: "0",
    ...extra,
  });
  return { env, db, clients: makeClients(env), log };
}

// ------------------------------------------------------------------ conditions
export const timeCondition = (deadline: bigint): Condition => ({ ...emptyCondition(), kind: Kind.TIME, deadline });

export function priceCondition(o: {
  feed: Address;
  threshold: bigint;
  deadline: bigint;
  op?: number;
  mode?: number;
  maxStale?: number;
  holdWindow?: number;
  start?: bigint;
}): Condition {
  const touch = o.mode === 1;
  return {
    ...emptyCondition(),
    kind: Kind.PRICE,
    mode: o.mode ?? 0,
    op: o.op ?? 0,
    target: o.feed,
    threshold: o.threshold,
    start: touch ? (o.start ?? 0n) : 0n,
    deadline: o.deadline,
    maxStale: touch ? 0 : (o.maxStale ?? 3600),
    holdWindow: touch ? 0 : (o.holdWindow ?? 86400),
  };
}

export const approveCondition = (referee: Address): Condition => ({ ...emptyCondition(), kind: Kind.APPROVE, mode: 1, target: referee });

export { ZERO_ADDRESS, ZERO_BYTES32, encodeAbiParameters };

// ------------------------------------------------------------------ Postgres
export interface TestDb {
  url: string;
  db: Deps["db"];
  stop(): Promise<void>;
}

export async function bootDb(): Promise<TestDb> {
  const pg = startPg("ifso-keeper-pg-");
  await runMigrations(pg.url);
  const { db, sql } = createDb(pg.url);
  return {
    url: pg.url,
    db,
    async stop() {
      await sql.end({ timeout: 2 }).catch(() => {});
      pg.stop();
    },
  };
}
