import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import {
  conditionComponents,
  createParamsComponents,
  type Condition,
  type CreateParams,
} from "./types";

/** keccak256(abi.encode(Condition)) — identical to IfsoEscrow.conditionHashOf(c). */
export function conditionHash(c: Condition): Hex {
  return keccak256(encodeAbiParameters([{ type: "tuple", components: conditionComponents }], [c as never]));
}

/** keccak256(abi.encode(CreateParams)) */
export function paramsHash(p: CreateParams): Hex {
  return keccak256(encodeAbiParameters([{ type: "tuple", components: createParamsComponents }], [p as never]));
}

export const CREATE_AUTH_TAG = keccak256(toHex("IFSO_CREATE_V1"));
export const ACCEPT_AUTH_TAG = keccak256(toHex("IFSO_ACCEPT_V1"));

/** IfsoEscrow.createAuthNonce(from, p): the EIP-3009 nonce that binds an authorization to exact params. */
export function createAuthNonce(from: Address, p: CreateParams): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }],
      [CREATE_AUTH_TAG, from, paramsHash(p)],
    ),
  );
}

/** IfsoEscrow.acceptAuthNonce(id, acceptor, counterRefundTo) */
export function acceptAuthNonce(id: bigint, acceptor: Address, counterRefundTo: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }],
      [ACCEPT_AUTH_TAG, id, acceptor, counterRefundTo],
    ),
  );
}

/** IfsoEscrow.idFor(sender, salt) = uint256(keccak256(abi.encode(sender, salt))). Known before the tx lands. */
export function escrowId(sender: Address, salt: Hex): bigint {
  return BigInt(keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [sender, salt])));
}

/** Converts a user's underlying share price ("NVDA above $200") to 8-decimal feed units, applying the
 *  Stock Token multiplier exactly ONCE (RHC feeds = underlying x multiplier). For crypto feeds pass 1e18. */
export function underlyingToFeedUnits(underlyingUsd: string, multiplier1e18: bigint): bigint {
  const [whole, frac = ""] = underlyingUsd.trim().split(".");
  if (!/^\d+$/.test(whole ?? "") || !/^\d*$/.test(frac)) throw new Error(`bad price: ${underlyingUsd}`);
  const px8 = BigInt(whole!) * 10n ** 8n + BigInt((frac + "00000000").slice(0, 8));
  return (px8 * multiplier1e18) / 10n ** 18n;
}

export function feedUnitsToUnderlying(feed8: bigint, multiplier1e18: bigint): number {
  if (multiplier1e18 === 0n) return Number(feed8) / 1e8;
  return Number((feed8 * 10n ** 18n) / multiplier1e18) / 1e8;
}
