import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import { acceptTypes, ifsoDomain } from "../core/typedData";
export { recoverClaimSigner } from "../core/link";

export async function recoverAcceptSigner(args: { chainId: number; escrow: Address; id: bigint; acceptor: Address; conditionHash: Hex; signature: Hex }) {
  return recoverTypedDataAddress({
    domain: ifsoDomain(args.chainId, args.escrow),
    types: acceptTypes,
    primaryType: "Accept",
    message: { id: args.id, acceptor: args.acceptor, conditionHash: args.conditionHash },
    signature: args.signature,
  });
}
