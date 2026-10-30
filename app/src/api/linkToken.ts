import { keccak256, toHex } from "viem";
import { b64urlEncode } from "../core/link";

export const newLinkToken = () => b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
export const tokenHash = (token: string) => keccak256(toHex(`ifso.link-request.v1:${token}`));
