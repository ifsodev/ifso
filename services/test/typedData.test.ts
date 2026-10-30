// Typed-data parity: the EIP-712 type strings used by the app/relayer must equal the Solidity typehash strings.
// Reads the contract sources directly, so a rename on either side fails CI.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hashDomain, hashTypedData, keccak256, toHex, encodeAbiParameters, hashStruct } from "viem";
import { acceptTypes, claimTypes, decisionTypes, ifsoDomain, permitTypes, receiveWithAuthorizationTypes, refundRedirectTypes, usdgDomain } from "../src/core/typedData";

const sol = readFileSync(join(import.meta.dir, "../../contracts/src/IfsoEscrow.sol"), "utf8");
const encodeType = (name: string, fields: readonly { name: string; type: string }[]) => `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
const solTypeStrings = [...sol.matchAll(/keccak256\(\s*"([A-Za-z]+\([^"]*\))"\s*\)/g)].map((m) => m[1]);

describe("EIP-712 parity with IfsoEscrow.sol", () => {
  for (const [name, types] of [
    ["Claim", claimTypes.Claim],
    ["Accept", acceptTypes.Accept],
    ["Decision", decisionTypes.Decision],
    ["RefundRedirect", refundRedirectTypes.RefundRedirect],
  ] as const) {
    test(`${name} type string`, () => {
      expect(solTypeStrings).toContain(encodeType(name, types));
    });
  }

  test("domain name/version", () => {
    expect(sol).toContain('EIP712("IFSO", "1")');
    const d = ifsoDomain(4663, "0x00000000000000000000000000000000000e5c20");
    const manual = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [keccak256(toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")), keccak256(toHex("IFSO")), keccak256(toHex("1")), 4663n, d.verifyingContract],
      ),
    );
    expect(hashDomain({ domain: d as never, types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] } })).toBe(manual);
  });

  test("digest = keccak(0x1901 || domain || struct) like _hashTypedData", () => {
    const domain = ifsoDomain(4663, "0x00000000000000000000000000000000000e5c20");
    const message = { id: 5n, recipient: "0x0000000000000000000000000000000000000b0b" as const, conditionHash: ("0x" + "11".repeat(32)) as `0x${string}` };
    const digest = hashTypedData({ domain, types: claimTypes, primaryType: "Claim", message });
    const structHash = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }], [keccak256(toHex(encodeType("Claim", claimTypes.Claim))), message.id, message.recipient, message.conditionHash]));
    expect(hashStruct({ types: claimTypes, primaryType: "Claim", data: message })).toBe(structHash);
    const ds = hashDomain({ domain: domain as never, types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] } });
    expect(digest).toBe(keccak256(`0x1901${ds.slice(2)}${structHash.slice(2)}`));
  });
});

describe("USDG typehashes match the on-chain token (verified 2026-10-25)", () => {
  test("EIP-2612 Permit", () => {
    expect(keccak256(toHex(encodeType("Permit", permitTypes.Permit)))).toBe("0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9"); // not-a-key
  });
  test("EIP-3009 ReceiveWithAuthorization (standard) and mock parity", () => {
    const t = encodeType("ReceiveWithAuthorization", receiveWithAuthorizationTypes.ReceiveWithAuthorization);
    expect(keccak256(toHex(t))).toBe("0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8"); // not-a-key
    expect(readFileSync(join(import.meta.dir, "../../contracts/src/mocks/MockUSDG.sol"), "utf8")).toContain(t);
  });
  test("USDG domain", () => {
    expect(usdgDomain(4663, "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168")).toMatchObject({ name: "Global Dollar", version: "1", chainId: 4663 });
  });
});
