// Fork stack step 2 (after the anvil fork and contracts/script/fork-dryrun.sh): everything that is not the deploy.
//   - makes the test keys (relayer, keeper, resolver service, people) and writes encrypted keystores for the three hot keys
//     (the app refuses raw keys on chain 4663, exactly as in production)
//   - funds them: ETH with anvil_setBalance, USDG with a storage write on the FORK (balance slot is found and verified)
//   - the owner Safe and panel Safe are impersonated (fork only) to accept the 2-step ownership the deploy handed over
//   - writes .fork/env.json (what serve.ts reads) and .fork/actors.json (what exercise.ts reads)
// Fork only: every call here goes to http://127.0.0.1:<ANVIL_PORT> and refuses a node that is not an anvil fork of 4663.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, getAddress, http, keccak256, encodeAbiParameters, toHex, parseAbi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const FORK_DIR = process.env.FORK_DIR ?? join(import.meta.dir, "../../.fork");
const ANVIL_PORT = Number(process.env.ANVIL_PORT ?? 8555);
const API_PORT = Number(process.env.API_PORT ?? 8090);
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const CONTRACTS = join(import.meta.dir, "../../../contracts");
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
if (!DATABASE_URL.startsWith("postgres://")) throw new Error("DATABASE_URL is required");

const pc = createPublicClient({ transport: http(RPC) });
const rpc = async <T = unknown>(method: string, params: unknown[] = []) => (await pc.request({ method, params } as never)) as T;
const chainId = await pc.getChainId();
const client = await rpc<string>("web3_clientVersion");
if (chainId !== 4663 || !client.startsWith("anvil/")) throw new Error(`refusing: ${RPC} is chain ${chainId} on ${client}`);

const dep = JSON.parse(readFileSync(join(CONTRACTS, "deployments/4663-fork.json"), "utf8"));
const addr = (n: string) => getAddress(dep.contracts[n].address) as Address;
const escrow = addr("IfsoEscrow"), evaluator = addr("IfsoConditionEvaluator"), resolver = addr("IfsoOutcomeResolver"), router = addr("FeeRouter");
const usdg = getAddress(dep.config.usdg) as Address;
const ownerSafe = getAddress(dep.config.ownerMultisig) as Address, panelSafe = getAddress(dep.config.panelMultisig) as Address;

mkdirSync(join(FORK_DIR, "keystores"), { recursive: true, mode: 0o700 });
const keysFile = join(FORK_DIR, "keys.json");
const keys: Record<string, Hex> = JSON.parse(readFileSync(keysFile, "utf8")); // made by fork-up.sh (needs the relayer address, the question creator, before the deploy)
const people = ["alice", "bob", "carol", "dave", "erin", "fran", "gus", "heidi"];
for (const p of people) if (!keys[p]) keys[p] = generatePrivateKey();
writeFileSync(keysFile, JSON.stringify(keys), { mode: 0o600 });
const acct = (n: string) => privateKeyToAccount(keys[n]!);
if (acct("relayer").address.toLowerCase() !== (dep.config.resolverCreator as string).toLowerCase()) throw new Error("deployment resolverCreator is not the relayer key (the question creator): run fork-up.sh, not setup.ts alone");

// ---- hot-key keystores (cast, encrypted) + password files
const env: Record<string, string> = {};
for (const n of ["relayer", "keeper", "resolver"] as const) {
  const pw = join(FORK_DIR, "keystores", `${n}.password`);
  writeFileSync(pw, "fork-" + n, { mode: 0o600 });
  const ks = join(FORK_DIR, "keystores", n);
  if (!existsSync(ks)) {
    const r = Bun.spawnSync(["cast", "wallet", "import", n, "--keystore-dir", join(FORK_DIR, "keystores"), "--private-key", keys[n]!, "--unsafe-password", "fork-" + n], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error("cast wallet import failed: " + r.stderr.toString().slice(0, 200));
  }
  env[`${n.toUpperCase()}_KEYSTORE`] = ks;
  env[`${n.toUpperCase()}_PASSWORD_FILE`] = pw;
}

// ---- ETH
const eth = (n: number) => toHex(BigInt(n) * 10n ** 18n);
for (const n of ["relayer", "keeper", "resolver", ...people]) await rpc("anvil_setBalance", [acct(n).address, eth(n === "relayer" || n === "keeper" ? 50 : 20)]);

// ---- USDG: find the balance slot with a fresh address, then write balances (fork only)
const usdgAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const balanceOf = (a: Address) => pc.readContract({ address: usdg, abi: usdgAbi, functionName: "balanceOf", args: [a] });
const slotFor = (a: Address, slot: bigint) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [a, slot]));
const probe = privateKeyToAccount(generatePrivateKey()).address;
let balSlot: bigint | undefined;
for (let s = 0n; s < 40n && balSlot === undefined; s++) {
  await rpc("anvil_setStorageAt", [usdg, slotFor(probe, s), toHex(777n, { size: 32 })]);
  if ((await balanceOf(probe)) === 777n) balSlot = s;
  else await rpc("anvil_setStorageAt", [usdg, slotFor(probe, s), toHex(0n, { size: 32 })]);
}
if (balSlot === undefined) throw new Error("could not find the USDG balance slot");
const setUsdg = async (a: Address, units: bigint) => {
  await rpc("anvil_setStorageAt", [usdg, slotFor(a, balSlot!), toHex(units, { size: 32 })]);
  if ((await balanceOf(a)) !== units) throw new Error("USDG balance write did not take");
};
await setUsdg(probe, 0n);
for (const n of people) await setUsdg(acct(n).address, 5_000n * 10n ** 6n);
await setUsdg(acct("resolver").address, 2_000n * 10n ** 6n); // bond float for the resolver service

// ---- accept ownership as the (impersonated) owner Safe; the panel Safe only needs ETH on the fork
const own = parseAbi(["function acceptOwnership()", "function owner() view returns (address)", "function pendingOwner() view returns (address)"]);
await rpc("anvil_setBalance", [ownerSafe, eth(10)]);
await rpc("anvil_setBalance", [panelSafe, eth(10)]);
await rpc("anvil_impersonateAccount", [ownerSafe]);
const ownerWallet = createWalletClient({ account: ownerSafe, transport: http(RPC) });
for (const c of [escrow, evaluator, resolver, router]) {
  const h = await ownerWallet.writeContract({ address: c, abi: own, functionName: "acceptOwnership", chain: null });
  await pc.waitForTransactionReceipt({ hash: h });
  if ((await pc.readContract({ address: c, abi: own, functionName: "owner" })).toLowerCase() !== ownerSafe.toLowerCase()) throw new Error("ownership not accepted: " + c);
}
await rpc("anvil_stopImpersonatingAccount", [ownerSafe]);

// ---- env for the app processes
Object.assign(env, {
  NODE_ENV: "development",
  PORT: String(API_PORT),
  HOST: "127.0.0.1",
  CHAIN_ID: "4663",
  RHC_RPC_URLS: RPC,
  DATABASE_URL,
  PUBLIC_APP_URL: "http://localhost:3190",
  WEB_ORIGINS: "http://localhost:3190,http://127.0.0.1:3190",
  ESCROW_ADDRESS: escrow,
  EVALUATOR_ADDRESS: evaluator,
  RESOLVER_ADDRESS: resolver,
  USDG_ADDRESS: usdg,
  ESCROW_DEPLOY_BLOCK: String(dep.deployBlock ?? 0),
  CONFIRMATIONS: "0",
  TRUST_PROXY: "cloudflare", // lets the run send cf-connecting-ip and cf-ipcountry like the edge does
  IP_HASH_SALT: "fork-run-salt",
  ODDS_API_KEY: "fork-fixture-key",
  POLYGON_RPC_URL: "http://127.0.0.1:1",
  // fork relaxations of the per-hour budgets: one machine makes hundreds of calls in minutes
  CLAIM_RELAY_PER_IP_PER_HOUR: "5000",
  RELAY_PER_IP_PER_HOUR: "5000",
  RELAY_PER_SIGNER_PER_HOUR: "1000",
  RELAY_PER_ESCROW_PER_DAY: "100",
  READS_PER_IP_PER_HOUR: "5000",
  BUILD_QUESTIONS_PER_IP_PER_HOUR: "1000",
  BUILD_QUESTIONS_PER_SENDER_PER_HOUR: "1000",
  INTERNAL_ADDRESSES: [acct("relayer").address, acct("keeper").address, acct("resolver").address].join(","),
});
writeFileSync(join(FORK_DIR, "env.json"), JSON.stringify(env, null, 2), { mode: 0o600 });

const actors = {
  rpc: RPC, api: `http://127.0.0.1:${API_PORT}`, admin: `http://127.0.0.1:${API_PORT + 1}`, wallet: `http://127.0.0.1:${API_PORT + 2}`,
  chainId, forkBlock: dep.forkBlock, commit: dep.commit,
  escrow, evaluator, resolver, router, usdg, ownerSafe, panelSafe, usdgBalanceSlot: String(balSlot),
  feeds: dep.config.feeds, feedStockTokens: dep.config.feedStockTokens,
  feeRecipients: [dep.config.feeWork, dep.config.feeTreasury, dep.config.feePerks, dep.config.feeBurn],
  addresses: Object.fromEntries(["relayer", "keeper", "resolver", ...people].map((n) => [n, acct(n).address])),
  keys: Object.fromEntries(people.map((n) => [n, keys[n]])), // fork-only throwaway keys, never funded anywhere real
};
writeFileSync(join(FORK_DIR, "actors.json"), JSON.stringify(actors, null, 2), { mode: 0o600 });
chmodSync(join(FORK_DIR, "actors.json"), 0o600);
console.log(`setup: ok. escrow ${escrow}, resolver ${resolver}, usdg slot ${balSlot}, ${people.length} funded people (5000 USDG, 20 ETH each)`);
