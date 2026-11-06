// Payment ids. IfsoEscrow.idFor(sender, salt) = uint256(keccak256(abi.encode(sender, salt))), so a real id is a uniform
// uint256: usually 76 to 78 decimal digits, at most 2^256 - 1 (78 digits). This is the ONE place that says what a
// payment id looks like: the bot commands, the API, the deep links and the site all read ids through it, so no copy
// can drift to a shorter digit limit again. Browser-safe (no imports); web/ gets it through src/vendor/ifso/core.

/** Largest id the escrow can hand out: type(uint256).max. */
export const MAX_PAYMENT_ID = (1n << 256n) - 1n;

/** Decimal digits of MAX_PAYMENT_ID. */
export const PAYMENT_ID_MAX_DIGITS = 78;

/** Regex source for one id, for embedding in larger patterns (routes, callback data). Range still needs parsePaymentId. */
export const PAYMENT_ID_SOURCE = String.raw`\d{1,78}`;

/** Whole-string match: digits only, 1 to 78 of them. */
export const PAYMENT_ID_RE = /^\d{1,78}$/; // a literal on purpose (no regex built from a string); a test keeps it equal to the source above

/**
 * Reads a payment id typed by a person or taken from a URL: surrounding spaces and one leading "#" are allowed.
 * Returns the id, or undefined when it is not digits, is 0, or is above 2^256 - 1.
 */
export function parsePaymentId(input: string | null | undefined): bigint | undefined {
  const s = (input ?? "").trim().replace(/^#/, "");
  if (!PAYMENT_ID_RE.test(s)) return undefined;
  const id = BigInt(s);
  return id > 0n && id <= MAX_PAYMENT_ID ? id : undefined;
}

/** The canonical decimal form (no leading zeros) as stored in the database, or undefined when it is not an id. */
export function paymentIdString(input: string | null | undefined): string | undefined {
  return parsePaymentId(input)?.toString();
}

export const isPaymentId = (input: string | null | undefined): boolean => parsePaymentId(input) !== undefined;
