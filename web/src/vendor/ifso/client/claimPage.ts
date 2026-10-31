// Browser-side claim flow for the web app's /c/<id> page (framework-agnostic). Security rules:
//  - read the secret from location.hash, then wipe it from the address bar immediately (history.replaceState)
//  - no third-party scripts or analytics on this page (strict CSP); never send the secret anywhere
//  - render amount and condition from the CHAIN (escrow query), never from the URL (anti-phishing)
//  - the recipient address comes from the user's wallet, or from a new passkey smart account
//    (ZeroDev Kernel v3.1 + passkey validator 0.0.3, both deployed on RHC): its counterfactual address can
//    receive USDG before deployment, so the claim needs no UserOp; the paymaster is only used later to spend.
import type { Address, Hex } from "viem";
import { parseClaimUrl, signClaim } from "../core/link";

export interface ClaimDeps {
  chainId: number;
  escrow: Address;
  /** tRPC client calls */
  getEscrow: (id: string) => Promise<{ escrow: { conditionHash: Hex; status: number; amount: string }; amountText: string }>;
  relayClaim: (input: { id: string; recipient: Address; signature: Hex }) => Promise<{ txHash: Hex; status: "bound" | "paid" }>;
  /** connected wallet address, or the counterfactual address of a freshly created passkey account */
  getRecipientAddress: () => Promise<Address>;
}

export function readAndWipeFragment(loc: Location = window.location, hist: History = window.history) {
  const href = loc.href;
  const parsed = parseClaimUrl(href);
  hist.replaceState(null, "", loc.pathname + loc.search); // secret leaves the URL bar and history entry
  return parsed;
}

export async function runClaim(deps: ClaimDeps, link: { id: bigint; secret: Uint8Array }) {
  const id = link.id.toString();
  const onchain = await deps.getEscrow(id);
  const recipient = await deps.getRecipientAddress();
  const signature = await signClaim({ secret: link.secret, chainId: deps.chainId, escrow: deps.escrow, id: link.id, recipient, conditionHash: onchain.escrow.conditionHash });
  link.secret.fill(0); // best effort: drop the secret from memory once used
  return deps.relayClaim({ id, recipient, signature });
}
