import { parseAbi } from "viem";

/** The few escrow functions the site calls itself. Everything else goes through the API. */
export const escrowAbi = parseAbi([
  "function nonces(address owner) view returns (uint256)",
  "function refund(uint256 id, bool senderAlt, bool counterAlt)",
  "function claimVoid(uint256 id, bool counterSide, bool alt)",
  "function cancel(uint256 id)",
]);
