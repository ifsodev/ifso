/**
 * Reading the claim link. The secret lives in the URL fragment. It is read and removed from the address bar and the
 * history entry the moment this module loads in the browser, before React renders and before any request is made.
 * The parsed value is kept in memory only, so a re-render (or React's dev double render) cannot lose it.
 */
import { readAndWipeFragment } from "@/vendor/ifso/client";

export type ClaimLink = { ok: true; id: bigint; secret: Uint8Array } | { ok: false };

let taken: ClaimLink | undefined;

/** Reads and wipes once; later calls return the same value. */
export function takeClaimLink(loc: Location = window.location, hist: History = window.history): ClaimLink {
  if (taken) return taken;
  try {
    taken = { ok: true, ...readAndWipeFragment(loc, hist) };
  } catch {
    // still remove whatever was in the fragment
    try {
      hist.replaceState(null, "", loc.pathname + loc.search);
    } catch {
      /* nothing to do */
    }
    taken = { ok: false };
  }
  return taken;
}

/** For tests. */
export function resetClaimLinkForTests() {
  taken = undefined;
}
