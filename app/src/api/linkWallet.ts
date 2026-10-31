// Wallet <-> Telegram link. The bot (private chat) issues a one-time token; the site has the user sign a short EIP-191
// message that contains it; this verifies the signature (EOA, or an EIP-1271 smart account such as a passkey account) and
// stores the address on the Telegram user. The address must be proven by a signature: it is never taken on trust.
import { and, eq, gt, isNull } from "drizzle-orm";
import { recoverMessageAddress, type Address, type Hex } from "viem";
import { intents, linkRequests, tgUsers } from "../db/schema";
import { linkDomain, linkWalletMessage } from "../core/linkWallet";
import type { Deps } from "../workers/deps";
import { tokenHash } from "./linkToken";

export class LinkError extends Error {}

async function proves(deps: Deps, address: Address, message: string, signature: Hex): Promise<boolean> {
  try {
    if ((await recoverMessageAddress({ message, signature })).toLowerCase() === address.toLowerCase()) return true;
  } catch {
    /* not an EOA signature */
  }
  try {
    return await deps.clients.publicClient.verifyMessage({ address, message, signature });
  } catch {
    return false;
  }
}

export async function linkWallet(deps: Deps, a: { token: string; address: Address; signature: Hex }, now = new Date()): Promise<{ address: Address }> {
  const hash = tokenHash(a.token);
  const [req] = await deps.db.select().from(linkRequests).where(and(eq(linkRequests.tokenHash, hash), isNull(linkRequests.usedAt), gt(linkRequests.expiresAt, now)));
  if (!req) throw new LinkError("this link has expired or was already used: send /link in the bot again");
  // signature first: a wrong signature must not burn the token
  const message = linkWalletMessage(a.token, { domain: linkDomain(deps.env.PUBLIC_APP_URL), expiresAt: Math.floor(req.expiresAt.getTime() / 1000) });
  if (!(await proves(deps, a.address, message, a.signature))) throw new LinkError("the signature does not match this wallet");
  const used = await deps.db.update(linkRequests).set({ usedAt: now }).where(and(eq(linkRequests.tokenHash, hash), isNull(linkRequests.usedAt), gt(linkRequests.expiresAt, now))).returning({ tgId: linkRequests.tgId });
  if (!used[0]) throw new LinkError("this link has expired or was already used: send /link in the bot again");
  const address = a.address.toLowerCase();
  await deps.db.insert(tgUsers).values({ tgId: req.tgId, address }).onConflictDoUpdate({ target: tgUsers.tgId, set: { address } });
  return { address: a.address };
}

/** After a successful create that came from the bot: remember the sender's address for notifications, never overwriting a linked one. */
export async function rememberSender(deps: Deps, intentId: string, from: Address): Promise<void> {
  const [it] = await deps.db.select({ tgId: intents.tgId }).from(intents).where(eq(intents.id, intentId));
  if (!it?.tgId) return;
  await deps.db.insert(tgUsers).values({ tgId: it.tgId, address: from.toLowerCase() }).onConflictDoUpdate({ target: tgUsers.tgId, set: { address: from.toLowerCase() }, setWhere: isNull(tgUsers.address) });
}
