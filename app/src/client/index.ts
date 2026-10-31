// @ifso/client: everything a website needs to build create / claim / accept / decide flows without re-implementing
// anything security-sensitive. Browser-safe: imports only `viem` and the shared core modules (no database, queue, bot).
// Types of the API: `import type { AppRouter } from "@ifso/client"` and pass it to tRPC's createTRPCClient<AppRouter>.
export type { AppRouter } from "../api/router";

// claim links (the secret lives only in the URL fragment)
export { randomSecret, linkKeyAddress, buildClaimUrl, parseClaimUrl, signClaim, signAccept, b64urlEncode, b64urlDecode, LINK_VERSION } from "../core/link";
export { readAndWipeFragment, runClaim, type ClaimDeps } from "./claimPage";

// typed data the wallet or link key signs
export {
  claimTypedData,
  acceptTypedData,
  decisionTypedData,
  refundRedirectTypedData,
  createAuthorizationTypedData,
  createPermitTypedData,
  acceptAuthorizationTypedData,
  ifsoDomain,
  usdgDomain,
  DecisionAction,
} from "../core/typedData";

// hashes and ids (to double-check what the server returns)
export { conditionHash, createAuthNonce, acceptAuthNonce, escrowId } from "../core/condition";
export { paramsFromJson } from "../core/paramsJson";
export { verifyBuildAnswer, type AskedFor, type BuildAnswer } from "./verifyBuild";

// wallet linking and the region rule
export { linkWalletMessage, linkDomain, linkFragment, parseLinkFragment, LINK_TOKEN_TTL_SEC, type LinkMessageContext } from "../core/linkWallet";
export { stockPriceConditionAllowed, PRICE_GATED_COUNTRIES } from "../core/geo";

// banned-word check for any copy the site writes itself
export { BANNED_WORDS, findBannedWords } from "./copyRules";
