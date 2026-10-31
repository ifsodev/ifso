import { createPublicClient, defineChain, http, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { config } from "./config";
import { escrowAbi } from "./escrowAbi";
import { gasWithMargin } from "./gas";
import type { WalletSession } from "./wallet";

export const viemChain = defineChain({
  id: config.chain.id,
  name: config.chain.name,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [config.chain.rpcUrl] } },
});

let pc: PublicClient | undefined;
export const publicClient = (): PublicClient => (pc ??= createPublicClient({ chain: viemChain, transport: http(config.chain.rpcUrl) }) as PublicClient);

/** The next signature nonce of `owner` on the escrow (decisions and refund redirects). Read right before signing. */
export async function escrowNonce(escrow: Address, owner: Address): Promise<bigint> {
  return (await publicClient().readContract({ address: escrow, abi: escrowAbi, functionName: "nonces", args: [owner] })) as bigint;
}

/** A transaction the visitor's own wallet sends. Gas = estimate x 1.3. */
export async function sendWithMargin(session: WalletSession, call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }): Promise<Hex> {
  const estimate = await publicClient().estimateContractGas({ ...call, account: session.address } as never);
  return session.client.writeContract({ ...call, account: session.address, chain: viemChain, gas: gasWithMargin(estimate) } as never);
}
