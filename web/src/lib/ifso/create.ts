/**
 * The create flow, in the order FRONTEND.md prescribes:
 *   secret made here -> build -> verifyBuildAnswer -> sign the typed data build returned -> submit -> share link.
 * The link secret exists only in this module's return value and in the share URL; only its derived address is sent.
 */
import type { Address, Hex } from "viem";
import { buildClaimUrl, linkKeyAddress, randomSecret, verifyBuildAnswer } from "@/vendor/ifso/client";
import type { Api, BuildAnswer } from "./api";
import { reviveTypedData, type Signer, type TypedData } from "./typed";

export interface CreateDeps {
  api: Pick<Api, "build" | "submit">;
  chainId: number;
  escrow: Address;
  usdg: Address;
  sign: Signer;
  origin: string;
}

export interface CreateInput {
  text: string;
  sender: Address;
  /** A named recipient address; when absent the payment goes to a claim link. */
  recipient?: Address;
  referee?: Address;
  cancellable?: boolean;
  tzOffsetMin?: number;
}

export interface CreateResult {
  id: string;
  txHash: Hex;
  /** Present for claim-link payments: the only place the secret exists. */
  claimUrl?: string;
}

/** Step 1 (review): build and verify, nothing is signed. The caller shows `answer.preview`, `notes`, `feeText`, `expiryText` as they are. */
export async function buildAndVerify(deps: Omit<CreateDeps, "sign">, input: CreateInput): Promise<{ answer: BuildAnswer; secret?: Uint8Array }> {
  const secret = input.recipient ? undefined : randomSecret();
  const answer = await deps.api.build({
    text: input.text,
    sender: input.sender,
    recipient: input.recipient,
    linkKey: secret ? linkKeyAddress(secret) : undefined,
    referee: input.referee,
    cancellable: input.cancellable,
    tzOffsetMin: input.tzOffsetMin,
  });
  verifyBuildAnswer(answer as never, { from: input.sender, chainId: deps.chainId, escrow: deps.escrow, usdg: deps.usdg });
  return { answer, secret };
}

/** Step 2 (confirm): sign exactly what `build` returned, relay it, and make the share link. */
export async function signAndSubmit(deps: CreateDeps, input: CreateInput, built: { answer: BuildAnswer; secret?: Uint8Array }): Promise<CreateResult> {
  const { answer, secret } = built;
  const signature = await deps.sign(reviveTypedData(answer.authorization.typedData as TypedData));
  const sent = await deps.api.submit({
    params: answer.params,
    from: input.sender,
    validAfter: answer.authorization.validAfter,
    validBefore: answer.authorization.validBefore,
    signature,
  });
  const claimUrl = secret ? buildClaimUrl(deps.origin, BigInt(sent.id), secret) : undefined;
  return { id: sent.id, txHash: sent.txHash, claimUrl };
}
