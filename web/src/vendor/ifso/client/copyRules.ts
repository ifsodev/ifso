// The words no screen of the product may use. Same list the API's copy is tested against (test/bannedWords.test.ts).
export const BANNED_WORDS: RegExp[] = [/\bapy\b/i, /\byield\w*/i, /\bguarantee\w*/i, /\bpartner\w*/i, /\bbet(s|ting|tor)?\b/i, /\bwager\w*/i, /\bodds\b/i, /\bstake[sd]?\b/i, /\bpayouts?\b/i, /\bsportsbook\b/i, /\bgambl\w*/i, /\bwin money\b/i, /\bsafe\w*/i, /can'?t lose/i, /\binsured?\b/i, /licensed escrow/i];

/** Returns the banned phrases found in `text` (empty = fine). Use it in the site's own tests on every string it shows. */
export function findBannedWords(text: string): string[] {
  return BANNED_WORDS.flatMap((re) => text.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")) ?? []);
}
