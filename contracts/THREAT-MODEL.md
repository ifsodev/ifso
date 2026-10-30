# Threat model

## Assets
- USDG held by `IfsoEscrow` for open payments and challenges (the only funds the contracts hold for users).
- Resolver bonds held by `IfsoOutcomeResolver` (pull-paid).
- Creation fees passing through `FeeRouter` (never escrowed money).
- Claim-link secrets (in the URL fragment; whoever holds one can claim that payment).

## Actors
| Actor | What it can do |
|---|---|
| Sender | Creates payments; cancels a cancellable one or an unaccepted challenge; taps OK (releases to the recipient, except in two-party mode); moves its own refund addresses. |
| Recipient / acceptor | Claims a link payment; accepts a challenge; taps OK; declines (returns the money to the sender); moves its own refund address in a challenge. |
| Referee | Decides one APPROVE-referee payment: release to the recipient or return to the sender. Nothing else. |
| Anyone (keeper, stranger, either party) | Settles a decidable condition; refunds after expiry; relays signed claims, decisions and refund-address changes; proposes or disputes an outcome with a bond. |
| Owner multisig (2-of-3) | Fees for new payments (capped at 5 USDG each), pause of new entries, launch cap, the feed / price-id / resolver registry for new payments, resolver question creators and bond size, fee split recipients, a 48 h delayed panel change. No function reaches escrowed USDG (invariant R7). |
| Panel multisig | Decides disputed outcome questions inside its window; silence leads to VOID (each side refunded), never to a forced result. |
| Resolver service | Registers questions (creator key) and proposes results from two or more independent sources; disputes contradicting proposals. Trusted only as far as the bond and dispute window allow. |
| USDG issuer | Can freeze addresses, including the escrow contract. |
| Robinhood Chain sequencer | Orders transactions and may refuse to include some addresses. |
| Sybils / griefers | Many cheap accounts, spam proposals or disputes, front-running relayed transactions. |

## Risks and defences
| Risk | Defence | Residual risk |
|---|---|---|
| Claim link copied or front-run | The claim signature binds escrow id, recipient and condition hash under EIP-712 (chain id and contract in the domain); a copied transaction cannot change the recipient (`test_Link_FrontRunnerCannotRedirect`). The first valid claim binds the recipient. | Anyone who sees the link before the recipient can claim it (it works like cash). Short expiries, cancellable payments and private sending reduce this. |
| Link secret leaks from the page | The secret lives only after `#`; the page removes it from the address bar, loads no third-party scripts and uses a strict CSP. The server only sees the derived address. | Chat apps keep the message; malicious browser extensions. |
| Look-alike claim pages | Amount and condition are read from the chain; one canonical domain; a warning on the page. | Users on look-alike domains. |
| Stale or cherry-picked oracle round | AT_DEADLINE needs the last round at the deadline to be fresh (`maxStale`), else the first print inside `holdWindow`, else VOID. Round-id proofs stop a keeper from picking an older round, and a round after the deadline is not a proof of the deadline. | The feed's 0.5% deviation threshold: a price within about 0.5% of the level can resolve either way (disclosed). |
| Brief price spike | AT_DEADLINE is the default; TOUCH is opt-in and labelled "any feed update"; Pyth confidence must be within 2%; only registry feeds are allowed. | TOUCH can trigger on a short move (disclosed). |
| Fake Stock Token or feed | Feeds and price ids are allow-listed by the owner multisig; the feed-to-token pairing comes from the registry, never from the creator (`test_Validate_RegistryPairingAndMultiplier`). | A compromised multisig could list a bad feed for new payments only. |
| Stock split applied twice | The contract never multiplies; a changed or scheduled multiplier gives VOID or a create-time revert (`test_MultiplierChange_Voids`, `test_Validate_ScheduledSplitBeforeDeadlineRejected`). | Conservative VOIDs around corporate actions. |
| Wrong or colluding outcome result | Two or more agreeing sources before a proposal; anyone may propose or dispute with a bond; a separate panel multisig decides disputes; panel silence gives VOID; the evidence hash is on chain. | The panel is trusted on disputed questions. |
| Dispute griefing | A dispute costs a full bond (100 USDG default, 10 to 10,000); a losing disputer forfeits it. Worst case is a delay of up to 72 h, then VOID. | A well-funded griefer can force VOIDs where the panel stays silent; panel response alerts mitigate it. |
| Wrong proposals by strangers | The resolver service disputes contradicting proposals automatically. | Needs the service to be up during the 2 h window (monitored). |
| Sender cannot transact or receive (screened or frozen) | Refund is open to anyone after expiry; the caller picks the primary or alternate refund address per side; the sender can sign a refund-address change that anyone relays; bonds are pull-paid. | A USDG issuer freeze of the escrow contract itself stops every exit (disclosed). |
| Keeper down | Every payment has an expiry (at most 400 days); refund is never paused and needs no special caller; expiry minimums leave room to settle (invariant R6, `testFuzz_RefundAlwaysWorksAfterExpiry`). | A met condition nobody settles before expiry goes back to the sender; the recipient's own page can settle it. |
| Challenge information edge | AT_DEADLINE: accept closes by the deadline; OUTCOME: accept closes by kickoff; TOUCH windows start at acceptance (`test_TouchChallenge_WindowStartsAtAcceptance`). | Insider information is not addressed. |
| Honor-system abuse in challenges | Two-sided payments cannot use TIME or two-party APPROVE, and the referee cannot be a party. | Referee collusion (pick a referee both sides know). |
| Gasless create re-pointed | The EIP-3009 nonce commits to every create parameter; any change breaks the signature (`test_CreateWithAuthorization_TamperedParamsRevert`); accept nonces bind the acceptor and its refund address. | None known. |
| Replayed decisions or refund redirects | Per-signer nonces, deadlines, EIP-712 domain with chain id and contract. | None known. |
| Reentrancy, token quirks | `nonReentrant` on every state-changing user entry point; a single immutable token (USDG); checked-transfer helpers. A contract that reads `getEscrow` from inside the Pyth fee refund callback during `settle` sees the pre-settle record (read-only reentrancy; no state can change). | Integrators should not read escrow state from inside that callback. |
| Launch cap removed or lowered | The cap gates only new creates and accepts; exits never depend on it (`test_Cap_LoweredDoesNotBlockExits`). | The owner multisig can raise or remove the cap at once (see SECURITY.md, accepted risks). |
| Deploy mistakes | The deploy script reads no private key, refuses on 4663 / 46630 unless armed by env flag and a local file, and asserts owners, fees, cap, feeds and panel after deploying; `PostDeployCheck` re-runs the assertions from the deployment file. | Values must still be reviewed before each real deploy. |
