// Wallet linking (todo 04 coordinator note): the bot's /link, the signed-message proof, and remembering the sender
// after a create that came from the bot. Real Postgres, stubbed chain.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { RateLimiter } from "../src/api/rateLimit";
import { appRouter, jsonSafe } from "../src/api/router";
import { loadEnv } from "../src/config/env";
import { buildParams } from "../src/core/builder";
import { createAuthNonce } from "../src/core/condition";
import { linkDomain, linkWalletMessage, parseLinkFragment } from "../src/core/linkWallet";
import { createAuthorizationTypedData } from "../src/core/typedData";
import { intents, linkRequests, relayTxs, tgUsers } from "../src/db/schema";
import type { Deps } from "../src/workers/deps";
import { bootDb, havePostgres, type TestDb } from "./helpers/chain";
import { buttonsOf, makeHarness, textOf } from "./helpers/botHarness";

setDefaultTimeout(60_000);
const ESCROW = "0x00000000000000000000000000000000000e5c20" as Address;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;

describe("/link in the bot (no database)", () => {
  test("a private chat gets one URL button with the token in the fragment, never in the query", async () => {
    const h = makeHarness();
    const out = await h.say("/link");
    const url = buttonsOf(out)[0].url as string;
    expect(url).toMatch(/\/link#[A-Za-z0-9_-]{43}\.\d{10}$/);
    expect(parseLinkFragment(new URL(url).hash)).toEqual({ token: h.store.linkTokens[0]!.token, expiresAt: 1_900_000_000 });
    expect(url).not.toContain("?");
    expect(h.store.linkTokens.length).toBe(1);
    expect(textOf(out)).toContain("moves no money");
  });
  test("a group chat is refused and no token exists", async () => {
    const h = makeHarness();
    const out = await h.say("/link", { chatType: "group", chatId: -100, userId: 9 });
    expect(buttonsOf(out).length).toBe(0);
    expect(textOf(out)).toContain("private chat");
    expect(h.store.linkTokens.length).toBe(0);
  });
});

describe.skipIf(!havePostgres())("wallet link and remembered sender", () => {
  let pg: TestDb;
  let deps: Deps;
  const caller = () => appRouter.createCaller({ deps, limiter: new RateLimiter(), ip: "203.0.113.7", country: "DE" });
  const TG = 4242n;
  const token = (c = "a") => c.repeat(43);
  let EXP = 0;
  const issue = async (tok: string, o: { tgId?: bigint; expiresInMs?: number } = {}) => {
    const { tokenHash } = await import("../src/api/linkToken");
    EXP = Math.floor((Date.now() + (o.expiresInMs ?? 600_000)) / 1000);
    await pg.db.insert(linkRequests).values({ tokenHash: tokenHash(tok), tgId: o.tgId ?? TG, expiresAt: new Date(EXP * 1000) });
  };
  // R3-I1: the signed text names the site and the code's expiry
  const msg = (tok: string, o: { domain?: string; expiresAt?: number } = {}) => linkWalletMessage(tok, { domain: o.domain ?? linkDomain(deps.env.PUBLIC_APP_URL), expiresAt: o.expiresAt ?? EXP });
  const userAddr = async (id = TG) => (await pg.db.select().from(tgUsers).where(eq(tgUsers.tgId, id)))[0]?.address ?? null;

  beforeAll(async () => {
    pg = await bootDb();
    const wallet = { account: { address: "0x00000000000000000000000000000000000000ee" }, writeContract: async () => "0xabc" as Hex };
    deps = {
      env: loadEnv({ ESCROW_ADDRESS: ESCROW }),
      log: () => {},
      db: pg.db,
      clients: {
        chain: { id: 4663 },
        escrow: ESCROW,
        usdg: USDG,
        relayer: wallet,
        publicClient: {
          readContract: async () => 250_000n,
          simulateContract: async (req: unknown) => ({ request: req }),
          estimateContractGas: async () => 100_000n,
          getGasPrice: async () => 1_000_000n,
          waitForTransactionReceipt: async () => ({ status: "success" }),
        },
      },
    } as unknown as Deps;
  });
  afterAll(async () => pg?.stop());
  beforeEach(async () => {
    await pg.db.delete(linkRequests);
    await pg.db.delete(intents);
    await pg.db.delete(relayTxs);
    await pg.db.delete(tgUsers);
  });

  test("a wallet that signs the message links to the Telegram user; the token works once", async () => {
    const acct = privateKeyToAccount(generatePrivateKey());
    await issue(token());
    const signature = await acct.signMessage({ message: msg(token()) });
    await caller().linkWallet({ token: token(), address: acct.address, signature });
    expect(await userAddr()).toBe(acct.address.toLowerCase());
    const other = privateKeyToAccount(generatePrivateKey());
    await expect(caller().linkWallet({ token: token(), address: other.address, signature: await other.signMessage({ message: msg(token()) }) })).rejects.toThrow("expired or was already used");
    expect(await userAddr()).toBe(acct.address.toLowerCase());
  });
  test("a signature from another wallet, or over another token, is refused and does not burn the token", async () => {
    const acct = privateKeyToAccount(generatePrivateKey());
    const thief = privateKeyToAccount(generatePrivateKey());
    await issue(token());
    await expect(caller().linkWallet({ token: token(), address: acct.address, signature: await thief.signMessage({ message: msg(token()) }) })).rejects.toThrow("does not match");
    await expect(caller().linkWallet({ token: token(), address: acct.address, signature: await acct.signMessage({ message: msg(token("b")) }) })).rejects.toThrow("does not match");
    expect(await userAddr()).toBeNull();
    await caller().linkWallet({ token: token(), address: acct.address, signature: await acct.signMessage({ message: msg(token()) }) }); // still usable
    expect(await userAddr()).toBe(acct.address.toLowerCase());
  });
  test("R3-I1: the message names the site and the expiry; a signature over another site or another expiry is refused", async () => {
    const acct = privateKeyToAccount(generatePrivateKey());
    await issue(token());
    const m = msg(token());
    expect(m).toContain(linkDomain(deps.env.PUBLIC_APP_URL));
    expect(m).toContain(`Expires: ${new Date(EXP * 1000).toISOString().replace(/\.000Z$/, "Z")}`);
    await expect(caller().linkWallet({ token: token(), address: acct.address, signature: await acct.signMessage({ message: msg(token(), { domain: "evil.example" }) }) })).rejects.toThrow("does not match");
    await expect(caller().linkWallet({ token: token(), address: acct.address, signature: await acct.signMessage({ message: msg(token(), { expiresAt: EXP + 3600 }) }) })).rejects.toThrow("does not match");
    await caller().linkWallet({ token: token(), address: acct.address, signature: await acct.signMessage({ message: m }) });
    expect(await userAddr()).toBe(acct.address.toLowerCase());
  });
  test("an unknown or expired token is refused", async () => {
    const acct = privateKeyToAccount(generatePrivateKey());
    await issue(token("e"), { expiresInMs: -1000 });
    for (const t of [token("e"), token("z")]) await expect(caller().linkWallet({ token: t, address: acct.address, signature: await acct.signMessage({ message: msg(t) }) })).rejects.toThrow("expired or was already used");
  });

  describe("submit remembers the sender for a bot intent", () => {
    const sender = privateKeyToAccount(generatePrivateKey());
    const prep = async (tgId: bigint | null) => {
      const params = buildParams({ draft: { kind: "TIME", at: Math.floor(Date.now() / 1000) + 86400 }, nowSec: Math.floor(Date.now() / 1000), amountUsdg: "10", twoSided: false, recipient: "0x00000000000000000000000000000000000b0b0b" as Address });
      const [row] = await pg.db.insert(intents).values({ tgId, draft: {}, text: "t" }).returning({ id: intents.id });
      const signature = await sender.signTypedData(createAuthorizationTypedData({ chainId: 4663, usdg: USDG, escrow: ESCROW, from: sender.address, value: params.amount + 250_000n, validAfter: 0n, validBefore: 9999999999n, nonce: createAuthNonce(sender.address, params) }));
      return { input: { params: jsonSafe(params) as Record<string, unknown>, from: sender.address, validAfter: "0", validBefore: "9999999999", signature, intentId: row!.id } };
    };
    test("stores tg_users.address from the verified sender when the intent came from Telegram", async () => {
      const { input } = await prep(TG);
      await caller().submit(input as never);
      expect(await userAddr()).toBe(sender.address.toLowerCase());
    });
    test("never overwrites an address the user linked on purpose", async () => {
      const linked = "0x000000000000000000000000000000000000dead";
      await pg.db.insert(tgUsers).values({ tgId: TG, address: linked });
      const { input } = await prep(TG);
      await caller().submit(input as never);
      expect(await userAddr()).toBe(linked);
    });
    test("an intent made on the web (no Telegram user) stores nothing", async () => {
      const { input } = await prep(null);
      await caller().submit(input as never);
      expect((await pg.db.select().from(tgUsers)).length).toBe(0);
    });
  });
});
