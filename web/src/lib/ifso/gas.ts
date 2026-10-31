/** Every transaction the site builds sets gas = estimate x 1.3 (the raw estimate ran out of gas on this chain). */
export const GAS_MARGIN_NUM = 130n;
export const GAS_MARGIN_DEN = 100n;

/** Rounds up, so a tiny estimate never loses the margin to integer division. */
export function gasWithMargin(estimate: bigint): bigint {
  return (estimate * GAS_MARGIN_NUM + GAS_MARGIN_DEN - 1n) / GAS_MARGIN_DEN;
}
