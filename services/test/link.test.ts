import { describe, expect, test } from "bun:test";
import { buildClaimUrl, deriveLinkPrivateKey, linkKeyAddress, parseClaimUrl, randomSecret, recoverClaimSigner, signAccept, signClaim } from "../src/core/link";
import { recoverAcceptSigner } from "../src/api/verify";

const secret = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const escrow = "0x00000000000000000000000000000000000e5c20" as const;
const recipient = "0x0000000000000000000000000000000000000b0b" as const;
const attacker = "0x0000000000000000000000000000000000000bad" as const;
const ch = ("0x" + "ab".repeat(32)) as `0x${string}`;

describe("link key derivation", () => {
  test("deterministic and domain-separated", () => {
    expect(deriveLinkPrivateKey(secret)).toBe(deriveLinkPrivateKey(Uint8Array.from(secret)));
    expect(linkKeyAddress(secret)).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const other = Uint8Array.from(secret);
    other[0] = 99;
    expect(linkKeyAddress(other)).not.toBe(linkKeyAddress(secret));
  });

  test("rejects wrong secret length", () => {
    expect(() => deriveLinkPrivateKey(new Uint8Array(31))).toThrow();
  });

  test("random secrets are 32 bytes and distinct", () => {
    const a = randomSecret();
    const b = randomSecret();
    expect(a.length).toBe(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

describe("claim URLs", () => {
  test("round trip; secret only in the fragment", () => {
    const id = 2n ** 255n + 12345n;
    const url = buildClaimUrl("https://ifso.app/", id, secret);
    const u = new URL(url);
    expect(u.hash.startsWith("#1.")).toBe(true);
    expect(u.pathname + u.search).not.toContain(u.hash.slice(3)); // secret never in path/query (sent to servers)
    const parsed = parseClaimUrl(url);
    expect(parsed.id).toBe(id);
    expect(Buffer.from(parsed.secret).equals(Buffer.from(secret))).toBe(true);
  });

  test("rejects foreign or malformed links", () => {
    expect(() => parseClaimUrl("https://ifso.app/x/abc#1.zzz")).toThrow();
    expect(() => parseClaimUrl("https://ifso.app/c/" + "A".repeat(43) + "#2.abc")).toThrow();
    expect(() => parseClaimUrl("https://ifso.app/c/" + "A".repeat(43) + "#1.short")).toThrow();
  });
});

describe("claim signatures", () => {
  test("binds the recipient: a copied signature can't be redirected", async () => {
    const sig = await signClaim({ secret, chainId: 4663, escrow, id: 7n, recipient, conditionHash: ch });
    const ok = await recoverClaimSigner({ chainId: 4663, escrow, id: 7n, recipient, conditionHash: ch, signature: sig });
    expect(ok).toBe(linkKeyAddress(secret));
    const redirected = await recoverClaimSigner({ chainId: 4663, escrow, id: 7n, recipient: attacker, conditionHash: ch, signature: sig });
    expect(redirected).not.toBe(linkKeyAddress(secret));
  });

  test("domain-separated by chain, contract, id and condition", async () => {
    const sig = await signClaim({ secret, chainId: 4663, escrow, id: 7n, recipient, conditionHash: ch });
    const key = linkKeyAddress(secret);
    for (const v of [
      { chainId: 46630, escrow, id: 7n, conditionHash: ch },
      { chainId: 4663, escrow: attacker, id: 7n, conditionHash: ch },
      { chainId: 4663, escrow, id: 8n, conditionHash: ch },
      { chainId: 4663, escrow, id: 7n, conditionHash: ("0x" + "cd".repeat(32)) as `0x${string}` },
    ]) {
      expect(await recoverClaimSigner({ ...v, recipient, signature: sig })).not.toBe(key);
    }
  });

  test("accept signatures recover to the link key and differ from claim signatures", async () => {
    const a = await signAccept({ secret, chainId: 4663, escrow, id: 7n, acceptor: recipient, conditionHash: ch });
    const c = await signClaim({ secret, chainId: 4663, escrow, id: 7n, recipient, conditionHash: ch });
    expect(a).not.toBe(c);
    expect(await recoverAcceptSigner({ chainId: 4663, escrow, id: 7n, acceptor: recipient, conditionHash: ch, signature: a })).toBe(linkKeyAddress(secret));
  });
});
