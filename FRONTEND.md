# IFSO web app: handoff for the front-end team

This is everything the website needs from the backend, and the rules that keep it correct. The site is a thin shell: all
the money logic, hashing and signature checks live in the backend and in the `@ifso/client` package, so the site never
re-implements them.

- API: one tRPC router (`/trpc/*`) plus a few plain GET endpoints. Source of truth for shapes: `app/src/api/router.ts`.
- Client package: `app/src/client` (name `@ifso/client`). Runs in the browser, depends on `viem` only.
- Contracts and typed data: the contract is the judge; the client builds exactly what the contract hashes (`test/client.parity.test.ts`).

## 1. The five rules (read these first)

1. **The link secret never leaves the browser.** It is made in the browser, lives in the URL fragment (`#...`), and only
   its derived address (`linkKey`) is ever sent to the server.
2. **Wipe the fragment before anything else on the claim page** (before render, before any fetch). `readAndWipeFragment()` does it.
3. **Show amounts and conditions from the API (`escrow`, `describe`), never from the URL.** The URL is attacker-controlled text.
4. **Sign only what `build` returned, after `verifyBuildAnswer()` passes.** Never assemble typed data by hand for a create.
5. **No third-party scripts, fonts, analytics or embeds on `/c/*` or `/link`.** Both pages hold a secret in the URL or in memory.

## 2. Setup

| Item | Value |
|---|---|
| Chain | Robinhood Chain, id `4663` (mainnet); testnet `46630` |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, 6 decimals, EIP-712 domain name `Global Dollar` version `1` |
| Escrow | read it from the API: `GET /healthz` returns `{ ok, chainId, escrow }`. Do not hard-code it |
| Amounts | every amount in the API is a decimal string in 6-decimal units ("20000000" = 20 USDG); `amountText`/`totalText` are for display |
| Ids | an escrow id is a uint256 as a decimal string |

```ts
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@ifso/client";

export const api = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: `${import.meta.env.API_URL}/trpc` })] });
```

- Install `@trpc/client` (11.x) and `viem` (2.57.11) in the site. Types come from `import type { AppRouter } from "@ifso/client"` (type-only, erased at build).
- Get the package either by vendoring `app/src/client` (it imports `../core/*`, so copy `app/src/client` and `app/src/core` together, or add the backend repo as a workspace) or by `bun run build:client` in `app/` (one browser ESM file, `viem` external).
- **Call the API from the visitor's browser, not from a server function.** The country and client address are read from the edge headers of the request; a server-to-server hop loses them.
- CORS: the API answers browsers whose origin equals `PUBLIC_APP_URL` or is listed in `WEB_ORIGINS` (comma separated), without credentials. Tell us your preview origins.
- Rate limits return tRPC code `TOO_MANY_REQUESTS`; show "try again in a little while".

## 3. Create flow (send an if-so payment)

```
browser                                         API                              chain
  |  randomSecret()  -> secret (32 bytes)
  |  linkKeyAddress(secret) -> linkKey
  |-- build({ text, sender, linkKey }) ---------->|   parse + exact params + typed data
  |<-- { id, params, total, authorization } ------|
  |  verifyBuildAnswer(answer, { from, chainId, escrow, usdg })   (throws on any mismatch)
  |  wallet.signTypedData(answer.authorization.typedData)         (ONE signature, EIP-3009)
  |-- submit({ params, from, validAfter, validBefore, signature }) ->|  relayer pays gas -> createWithAuthorization
  |<-- { txHash, id } ----------------------------|
  |  buildClaimUrl(origin, BigInt(id), secret)  -> share it (WhatsApp, SMS, copy)
```

```ts
import { randomSecret, linkKeyAddress, buildClaimUrl, verifyBuildAnswer } from "@ifso/client";

const secret = randomSecret();
const answer = await api.build.mutate({ text: "/ifso link 20 if arsenal win", sender: account, linkKey: linkKeyAddress(secret) });
verifyBuildAnswer(answer as any, { from: account, chainId: 4663, escrow, usdg });
const signature = await walletClient.signTypedData({ account, ...(answer as any).authorization.typedData });
const { id } = await api.submit.mutate({
  params: (answer as any).params, from: account,
  validAfter: (answer as any).authorization.validAfter, validBefore: (answer as any).authorization.validBefore, signature,
});
const url = buildClaimUrl(location.origin, BigInt(id), secret); // the secret exists only here and in this URL's fragment
```

Notes:
- If the recipient is a named address (the text has `0x...`) leave `linkKey` out; the payment is bound to that address.
- A wallet that cannot do a gasless signature (or prefers one transaction) uses `createWithPermit` on the escrow: build the permit with `createPermitTypedData` (USDG `nonces(owner)` for the nonce), sign it, then send `createWithPermit(params, deadline, v, r, s)` from the wallet. `build` still gives the exact `params`.
- For an outcome payment (sports, market question), `submit` registers the question for a sender that holds the funds. If the wallet sends the transaction itself, call `prepareQuestion` first.
- Keep the secret only in memory and in the share link. Do not put it in `localStorage`, analytics, error reports or logs. Offer "copy link" once and tell the sender to keep it; there is no recovery.

## 4. Claim page (`/c/<id>#1.<secret>`)

Order of operations, all on the client:

1. `const link = readAndWipeFragment()`: parses the id and secret and removes the fragment from the address bar and history entry. Do this first thing, before rendering or fetching.
2. `api.escrow.query({ id })` and render the amount, condition and status **from the answer**. `status` 1 = open, 2 = met (claim pays out now), 3+ = finished.
3. Get a recipient address: the visitor's connected wallet, or a new passkey account (section 7). The visitor must see and approve the address.
4. `runClaim(deps, link)` signs `Claim(id, recipient, conditionHash)` with the link key and calls `claim`. The signature binds the recipient: nobody (relayer, a copied request) can redirect the money.
5. Show the result: `status: "bound"` = "you will receive it when the condition happens" (the money is locked to you), `"paid"` = sent.

```ts
import { readAndWipeFragment, runClaim } from "@ifso/client";

const link = readAndWipeFragment(); // { id: bigint, secret: Uint8Array }; throws on a bad link
const view = await api.escrow.query({ id: link.id.toString() });
// ... render view.amountText and the condition from `view`, never from the URL ...
const result = await runClaim(
  {
    chainId: 4663,
    escrow,
    getEscrow: (id) => api.escrow.query({ id }) as any,
    relayClaim: (i) => api.claim.mutate(i),
    getRecipientAddress: async () => connectedOrPasskeyAddress(),
  },
  link,
);
```

Challenge invites use the same link but the visitor joins with `accept` (section 5), not `claim`. `claim` on a challenge returns an error that says so.

**Strict CSP for `/c/*` and `/link`** (adjust `connect-src` to your API origin and RPC; nothing else may load):

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self';
  connect-src 'self' https://api.example.com https://rpc.mainnet.chain.robinhood.com; base-uri 'none'; form-action 'none';
  frame-ancestors 'none'
Referrer-Policy: no-referrer
Cache-Control: no-store
X-Content-Type-Options: nosniff
```

No inline scripts, no Google Fonts, no tag managers, no session replay, no chat widgets on these pages. Passkey creation needs
no extra directive. Exclude both routes from any analytics that records URLs.

## 5. Challenges (two sides)

A challenge has a sender amount and a counter amount; the other side joins before `acceptBy`. Joining is gasless:

1. `acceptTypedData(...)`: the **link key** signs it (named challenges need no link signature): `signAccept({ secret, chainId, escrow, id, acceptor, conditionHash })`.
2. `acceptAuthorizationTypedData(...)`: the acceptor's wallet signs a USDG authorization for the counter amount (nonce binds it to this escrow, acceptor and refund address).
3. `api.accept.mutate({ id, acceptor, linkSig, counterRefundTo, validAfter, validBefore, authSig })`.

`counterRefundTo` is where the acceptor's own amount goes if the challenge is voided or expires (use the acceptor's address unless they chose another).
Challenges on "touches" are not possible; the parser asks the user to pick "check at the deadline" or a one-sided payment.

## 6. Decisions and refund addresses (relayed, gasless)

Everyone with a say (sender OK, recipient OK/decline, referee release/return) signs an EIP-712 `Decision`; the relayer pays gas.

```ts
import { decisionTypedData, DecisionAction } from "@ifso/client";

const nonce = await publicClient.readContract({ address: escrow, abi: ifsoEscrowAbi, functionName: "nonces", args: [account] });
const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
const typed = decisionTypedData({ chainId: 4663, escrow, id: BigInt(id), action: DecisionAction.OK, nonce, deadline });
const signature = await walletClient.signTypedData({ account, ...typed });
await api.decide.mutate({ id, signer: account, action: DecisionAction.OK, deadline: deadline.toString(), signature });
```

| action | who | meaning |
|---|---|---|
| 1 | sender or recipient | OK |
| 2 | sender or recipient | decline |
| 3 | referee | release to the recipient |
| 4 | referee | return to the sender |

`redirectRefund` is the same idea for the sender changing where a refund goes: `refundRedirectTypedData(...)`, nonce = `nonces(sender)`.

The server **checks the signature itself** (EOA or smart account) before spending anything, and charges its per-wallet budgets to the
address that signed, not to the `signer` field. A request signed by someone else, for a stale nonce, or for a different action is
refused with a 400. If the user waited too long, read the nonce again and ask them to sign again.

## 7. Passkey accounts (no wallet, no gas)

A visitor with no wallet gets a smart account protected by a passkey:

| Piece | Address (RHC mainnet, checked 2026-10-30 with `cast code` against `https://rpc.mainnet.chain.robinhood.com`) |
|---|---|
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` (16,035 bytes) |
| ZeroDev Kernel v3.1 factory | `0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419` (989 bytes) |
| ZeroDev Kernel v3.1 meta factory | `0xd703aaE79538628d27099B8c4f621bE4CCd142d5` (1,871 bytes) |
| Passkey (WebAuthn) validator 0.0.3 | `0x7ab16Ff354AcB328452F1D445b3Ddee9a91e9e69` (4,739 bytes) |
| P-256 precompile (RIP-7212) | `0x0000000000000000000000000000000000000100` |

- The account address is **counterfactual**: it can receive USDG before it is deployed, so a claim needs no UserOp. Show the address, then `claim` to it.
- Spending later (a decision, a new payment) is signed with the passkey; the account is deployed by the first UserOp. Decisions go through `decide` because the contract accepts EIP-1271 signatures.
- The paymaster/bundler keys are the site's; they are not part of the API. Use the project's ZeroDev id from the team's secrets and keep it off `/c/*` bundles' public logs.
- Treat a lost passkey like a lost wallet: say so in plain words on the page.

## 8. Linking a wallet to Telegram (`/link`)

The bot's `/link` command (private chat only) sends a button to `https://<site>/link#<token>.<expiresAt>` (read it with `parseLinkFragment`). The token is one-time, valid 15 minutes, and only its hash is stored.

1. The page reads the token from the fragment and wipes it (same helper pattern as the claim page; no third-party scripts).
2. The user connects a wallet or passkey account; show the exact text to be signed: `linkWalletMessage(token, { domain: linkDomain(PUBLIC_APP_URL), expiresAt })` (it names the site and the expiry).
3. `personal_sign` it (EIP-191), then `api.linkWallet.mutate({ token, address, signature })`.
4. Success: "Wallet linked". Errors: "expired or already used" (ask for `/link` again) or "signature does not match".

Also, when a payment created from a bot draft goes through `submit`, the sender's address is saved to the Telegram user **if none is linked yet**. A linked address is never overwritten by `submit`; only `/link` replaces it.

## 9. Region rule

`GET /geo` returns `{ country: "DE" | null, stockPriceConditionsAllowed: boolean }`, no-store. Stock price conditions are blocked for
US, GB, CA, CH and AE; an unknown country is blocked too. It is an IP courtesy gate, not an identity check.

- Hide or disable stock price conditions when `stockPriceConditionsAllowed` is false and show the API's own message (`parse` errors carry it). Dates, results, markets and referee payments stay available everywhere.
- The API enforces the same rule in `parse`, `build` and `submit`, so a hand-made request cannot skip it. Do not duplicate the list in the site; call `/geo`.
- Crypto price conditions (ETH and similar) are not region-gated.

## 10. Copy rules

CI scans every string the API and bot produce. The site must follow the same rules on every screen, error and email:

- Say: "if-so payment", "unlocks when", "comes back to you", "challenge", "referee", "claim link", "chip in".
- Never use: bet, wager, odds, yield, APY, guaranteed, partner, stake, payout, gamble, sportsbook, win money, safe, "can't lose", insured, "licensed escrow".
- No endorsement wording for any data source or platform ("powered by", "official", "approved by").
- Locked premium features say "hold N $IFSO to unlock". No "buy", price talk, or return talk. Always show the line "Perks have no cash value and are not a promise of any amount" (it is the `note` field of `perks`).
- `import { findBannedWords } from "@ifso/client"` and run it over every string in your own tests.

The preview text the user confirms must be the one the API produced: render `preview`, `notes` and `fee`/`expiryText` from `build` (or `parse`) as they come. The same sentence appears in the bot, so both channels say the same thing. `describe` returns just the condition sentence (for example "Arsenal win (Sat, 1 Nov)") for lists and history.

## 11. `parse` ambiguities and questions

`parse` never guesses. When something is unclear it fills `ambiguities` (plain sentences) and `questions` (same order, with options):

```ts
type Question = { kind: "direction" | "date_format" | "deadline" | "weekend" | "team" | "touch_challenge";
                  text: string; options: { label: string; text?: string; replace?: [from: string, to: string] }[] };
```

Render each question with one button per option. Picking an option means: if `text` is set, re-run `parse` with that full text; if `replace` is set, replace `replace[0]` by `replace[1]` in the current text and re-run. Do not call `build` while `questions` is non-empty.

The weekend stock deadline: a stock price deadline on a Saturday or Sunday gives `kind: "weekend"` ("US markets are closed that day. Which close should count?") with the options "Friday's close" and "Monday's close". Show it exactly as asked.
Other kinds: `direction` (at or above, or at or below), `date_format` (day/month or month/day), `deadline` (needs a time), `team` (which team/fixture), `touch_challenge` (see section 5).

## 12. tRPC reference

Queries are `GET /trpc/<name>?input=<urlencoded json>`; mutations are `POST /trpc/<name>` with a JSON body. With the tRPC client you call
`api.<name>.query(input)` / `.mutate(input)`. Addresses are 0x strings (checksummed or lower case), `uint` inputs are decimal strings, `hex` inputs are 0x strings.

### `parse`
Query. Input `{ text: string(3..300), tzOffsetMin?: int }`. Output: `{ ok, twoSided, recipient?, amountUsdg?, counterAmountUsdg?, condition?, ambiguities: string[], questions: Question[], notes: string[], errors: string[], preview?, feeUsdg?, expiry? }`. Use it to preview while typing. `errors` is non-empty when the request cannot proceed (including the region message).
```ts
await api.parse.query({ text: "/ifso @jake 20 if arsenal win" }); // { ok: true, preview: "Send 20 USDG to @jake. It unlocks if ...", ... }
```

### `describe`
Query. Input `{ text }`. Output: the condition sentence (string) or `null`.
```ts
await api.describe.query({ text: "/ifso @jake 20 on nov 1" }); // "it unlocks on Sun, Nov 1 ..."
```

### `build`
Mutation. Input `{ text? , intentId? (uuid, from a bot draft), sender, recipient?, linkKey?, referee?, altRefundTo?, cancellable?, tzOffsetMin? }` (give `text` or `intentId`). Output: `{ id, params, conditionHash, fee, feeText, total, preview, notes, expiryText, authorization: { validAfter, validBefore, nonce, typedData } }`. `typedData` is the USDG `ReceiveWithAuthorization` the sender signs. Stores nothing on chain; plans outcome questions off-chain.
```ts
const b = await api.build.mutate({ text: "/ifso link 20 on nov 1", sender, linkKey });
```

### `submit`
Mutation. Input `{ params, from, validAfter, validBefore, signature, intentId? }`. Output `{ txHash, id }`. The server recovers the signer from `signature` and requires it to be `from`; a mismatch is a 400 before any gas is spent. Rate limited per network and per signing wallet.

### `prepareQuestion`
Mutation. Input `{ questionId: hex, sender }`. Output `{ ok: true }`. Registers a planned outcome question for a wallet that sends the create itself (not through `submit`). Needs `sender` to hold the fee plus the minimum; rate limited per network.

### `escrow`
Query. Input `{ id }`. Output `{ escrow, condition, amountText }` read from the chain. `escrow` has `sender, recipient, amount, counterAmount, linkKey, status, flags, expiry, acceptBy, refundTo, altRefundTo, conditionHash ...`; `condition` has `kind, mode, op, target, threshold, deadline ...`. Status: 1 open, 2 met, 3 released, 4 returned, 5 voided, 6 cancelled. Unknown id gives `NOT_FOUND`. This is the only source for the claim page.

### `claim`
Mutation. Input `{ id, recipient, signature }` (signature from `signClaim`). Output `{ txHash, status: "bound" | "paid" }`. The server verifies the signature against the link key before it counts against any shared limit. Errors say what is wrong ("already claimed, finished or expired", "challenges are joined with accept").

### `accept`
Mutation. Input `{ id, acceptor, linkSig, counterRefundTo, validAfter, validBefore, authSig }`. Output `{ txHash }`. See section 5.

### `decide`
Mutation. Input `{ id, signer, action(1..4), deadline, signature }`. Output `{ txHash }`. See section 6. Refuses a repeat OK ("this approval is already recorded") and anything the contract would reject.

### `redirectRefund`
Mutation. Input `{ id, refundTo, altRefundTo, deadline, signature }` (signed by the sender, `altRefundTo` may be the zero address). Output `{ txHash }`. Refuses a change to the addresses that are already set.

### `mine`
Query. Input `{ address }`. Output: up to 100 indexed escrows where the address is sender or recipient (newest first; amounts as strings). For a "my payments" list; the chain stays the source of truth for a single payment.

### `question`
Query. Input `{ specHash }`. Output `{ id, spec, title, state, finalOutcome }` for an outcome question (sports/market). `GET /q/<specHash>.json` serves the public spec itself.

### `perks`
Query. Input `{ address }`. Output `{ tier: "none" | "holder" | "whale", unlocked: Perk[], locked: Perk[], wording, limits: { batchSize, scheduledPayments, relayBudgetFactor }, tokenLive, note }`. The tier is read on the server from the token balance; nothing the client sends changes it. `Perk = { id, text, requires, requiresIfso, unlockText }`.
Locked-state wording: show `wording` (for example "Premium features: hold 100,000 $IFSO to unlock.") and each locked perk's `unlockText`; when `tokenLive` is false it adds "The token is not live yet." Always show `note`. Core features (create, claim, decide) are never locked.
```ts
const p = await api.perks.query({ address: account }); // { tier: "none", locked: [...], wording: "Premium features: hold ..." }
```

### `planBatch`
Mutation. Input `{ sender, csv? , items?: { recipient, amountUsdg }[] (max 5000) }`. CSV is `address,amount` per line with one optional header line. Output when allowed: `{ ok, locked: false, tier, limit, problems: { line, problem }[], totals: { count, amount, amountText, fees, feesText, total, totalText }, rows }`. Over the tier limit: `{ ok: false, locked: false, limit, reason }`. Below the tier: `{ ok: false, locked: true, tier, wording, locked_perks }`. Plans only; it sends nothing. Needs Holder.

### `planPayroll`
Mutation. Input as `planBatch` plus `{ runs: 1..60, every: "week" | "month" }`. Output like `planBatch` with `{ scheduled, every, runs, perRun: totals }`; the limit is rows x runs against the tier's scheduled-payment limit. Plans only. Needs Holder.

### `stats`
Query. Input `{ since?: "YYYY-MM-DD" }` (optional). Output `{ since, uniqueSenders, uniqueRecipients, uniqueAcceptors, escrowsCreated, volumeUsdg, perDay: [...] }` from indexed chain events, our own wallets excluded. Same data as `GET /stats/users`. Fine to show as a public counter.

### `linkWallet`
Mutation. Input `{ token (43 chars from the bot link), address, signature }`. Output `{ address }`. See section 8.

## 13. Plain endpoints

| Endpoint | Returns |
|---|---|
| `GET /healthz` | `{ ok, chainId, escrow }` |
| `GET /readyz` | readiness probes, 503 when not ready (for monitoring, not for the site) |
| `GET /geo` | `{ country, stockPriceConditionsAllowed }` |
| `GET /stats/users?since=YYYY-MM-DD` | the real-user counter |
| `GET /q/<specHash>.json` | an outcome question's public rules |

## 14. Errors

tRPC error codes the site should handle: `BAD_REQUEST` (show `message`, it is written for users), `NOT_FOUND`, `FORBIDDEN` (region), `PRECONDITION_FAILED`
(for example the sending wallet lacks USDG), `TOO_MANY_REQUESTS` (wait). Messages follow the copy rules; show them as they are.

## 15. Checklist before launch

- [ ] Claim page and `/link`: fragment wiped first, strict CSP, no third-party code, `no-store`, excluded from analytics.
- [ ] Create flow calls `verifyBuildAnswer` before every signature; the secret is never stored.
- [ ] Amounts and conditions on every page come from `escrow`/`build`/`describe`.
- [ ] Region: `/geo` drives the stock-condition UI; the unknown case reads as blocked.
- [ ] Every string passes `findBannedWords` in the site's tests; locked perks show the `note`.
- [ ] Phone width checked for: create, share, claim, decide, link.
- [ ] Errors from the API are shown as they are; rate-limit and region messages have a calm state.
