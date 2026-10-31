// Builds a real `build` answer the way the API router does, from the backend's own core modules (tests run in the repo).
import { getAddress, type Address, type Hex } from "viem";
import { buildParams } from "../../app/src/core/builder";
import { conditionHash, createAuthNonce, escrowId } from "../../app/src/core/condition";
import { createAuthorizationTypedData } from "../../app/src/core/typedData";
import type { BuildAnswer } from "@/lib/ifso/api";

export const CHAIN_ID = 4663;
export const ESCROW: Address = getAddress("0x1111111111111111111111111111111111111111");
export const USDG: Address = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
export const SENDER: Address = getAddress("0x2222222222222222222222222222222222222222");
export const FEE = 250_000n;

const json = <T>(v: T): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

export function realBuildAnswer(opts: { sender?: Address; linkKey?: Address; recipient?: Address; amountUsdg?: string } = {}): BuildAnswer {
  const sender = opts.sender ?? SENDER;
  const nowSec = Math.floor(Date.now() / 1000);
  const params = buildParams({
    draft: { kind: "TIME", at: nowSec + 86_400 },
    nowSec,
    amountUsdg: opts.amountUsdg ?? "20",
    twoSided: false,
    recipient: opts.recipient,
    linkKey: opts.recipient ? undefined : (opts.linkKey ?? getAddress("0x3333333333333333333333333333333333333333")),
  } as never);
  const value = params.amount + FEE;
  const validAfter = BigInt(nowSec - 60);
  const validBefore = BigInt(nowSec + 3600);
  const nonce = createAuthNonce(sender, params);
  return json({
    id: escrowId(sender, params.salt),
    params,
    conditionHash: conditionHash(params.condition),
    fee: FEE,
    feeText: "Fee: 0.25 USDG",
    total: value,
    preview: "Send 20 USDG.",
    notes: [],
    expiryText: "Expires soon",
    authorization: { validAfter, validBefore, nonce, typedData: createAuthorizationTypedData({ chainId: CHAIN_ID, usdg: USDG, escrow: ESCROW, from: sender, value, validAfter, validBefore, nonce }) },
  }) as BuildAnswer;
}

export const SIG = ("0x" + "ab".repeat(65)) as Hex;
