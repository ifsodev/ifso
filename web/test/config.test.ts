import { describe, expect, test } from "vitest";
import { loadConfig, USDG_MAINNET } from "@/lib/ifso/config";
import { resolveChainInfo } from "@/lib/ifso/chainInfo";
import { gasWithMargin } from "@/lib/ifso/gas";
import { sendWithMargin } from "@/lib/ifso/chain";
import { getAddress, parseAbi } from "viem";
import { ESCROW } from "./helpers";

describe("config", () => {
  test("defaults to mainnet and reads only the environment", () => {
    const c = loadConfig({});
    expect(c.chain.id).toBe(4663);
    expect(c.chain.rpcUrl).toBe("https://rpc.mainnet.chain.robinhood.com");
    expect(c.usdg).toBe(USDG_MAINNET);
    expect(c.apiUrl).toBe("");
    expect(c.escrow).toBeUndefined();
  });
  test("chain profiles: testnet, fork, override and bad id", () => {
    expect(loadConfig({ NEXT_PUBLIC_CHAIN_ID: "46630" }).chain.name).toBe("Robinhood Chain Testnet");
    expect(loadConfig({ NEXT_PUBLIC_CHAIN_ID: "31337", NEXT_PUBLIC_RPC_URL: "http://127.0.0.1:8545" }).chain.id).toBe(31337);
    expect(() => loadConfig({ NEXT_PUBLIC_CHAIN_ID: "1" })).toThrow(/4663/);
    expect(() => loadConfig({ NEXT_PUBLIC_ESCROW_ADDRESS: "nope" })).toThrow(/not an address/);
  });
  test("connect origins are the API and the RPC only", () => {
    const c = loadConfig({ NEXT_PUBLIC_API_URL: "https://api.example.test/", NEXT_PUBLIC_RPC_URL: "https://rpc.example.test/x" });
    expect(c.apiUrl).toBe("https://api.example.test");
    expect(c.connectOrigins).toEqual(["https://api.example.test", "https://rpc.example.test"]);
  });
  test("escrow comes from the API and must match the build-time address", async () => {
    const cfg = loadConfig({});
    await expect(resolveChainInfo({ health: async () => ({ ok: true, chainId: 4663, escrow: ESCROW }) }, cfg)).resolves.toMatchObject({ escrow: ESCROW, usdg: USDG_MAINNET });
    await expect(resolveChainInfo({ health: async () => ({ ok: true, chainId: 46630, escrow: ESCROW }) }, cfg)).rejects.toThrow(/network/);
    const pinned = { ...cfg, escrow: getAddress("0x7777777777777777777777777777777777777777") };
    await expect(resolveChainInfo({ health: async () => ({ ok: true, chainId: 4663, escrow: ESCROW }) }, pinned)).rejects.toThrow(/disagree/);
    await expect(resolveChainInfo({ health: async () => ({ ok: true, chainId: 4663, escrow: null }) }, cfg)).rejects.toThrow(/not set up/);
  });
});

describe("gas", () => {
  test("estimate x 1.3, rounded up", () => {
    expect(gasWithMargin(100_000n)).toBe(130_000n);
    expect(gasWithMargin(1n)).toBe(2n);
    expect(gasWithMargin(21_001n)).toBe(27_302n);
  });
  test("a transaction the site sends carries the margin", async () => {
    let sent: { gas?: bigint } = {};
    const session = { address: ESCROW, client: { writeContract: async (a: { gas: bigint }) => ((sent = a), "0xhash") } } as never;
    const abi = parseAbi(["function cancel(uint256 id)"]);
    await sendWithMargin(session, { address: ESCROW, abi, functionName: "cancel", args: [1n] }, { estimateContractGas: async () => 200_000n } as never);
    expect(sent.gas).toBe(260_000n);
  });
});
