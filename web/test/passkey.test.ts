// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { bytesToHex, keccak256 } from "viem";
import { authenticatorIdHash, b64urlToBytes, p256Coordinates } from "@/views/secret/passkey";

describe("passkey helpers", () => {
  test("credential id hash is keccak256 of the decoded id bytes (what the validator stores)", () => {
    const id = "AQIDBAUGBwgJCgsMDQ4PEA"; // bytes 1..16
    expect([...b64urlToBytes(id)]).toEqual([...Array(16).keys()].map((i) => i + 1));
    expect(authenticatorIdHash(id)).toBe(keccak256(bytesToHex(Uint8Array.from({ length: 16 }, (_, i) => i + 1))));
  });
  test("SPKI public key -> the two P-256 coordinates", async () => {
    const { webcrypto } = await import("node:crypto");
    const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const spki = await webcrypto.subtle.exportKey("spki", pair.publicKey);
    const raw = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey));
    const { x, y } = await p256Coordinates(spki as ArrayBuffer);
    expect(x).toBe(BigInt(bytesToHex(raw.slice(1, 33))));
    expect(y).toBe(BigInt(bytesToHex(raw.slice(33, 65))));
  });
});
