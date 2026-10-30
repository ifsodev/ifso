// ALL user-facing strings (Telegram bot + web app) live here so CI can scan them for banned words
// (test/bannedWords.test.ts). Wording rules: this is conditional money, not gambling. Say "if-so payment",
// "challenge", "unlocks", "comes back", "referee", "chip in". Never the banned list in that test.

const opWord = (op: "GTE" | "LTE") => (op === "GTE" ? "at or above" : "at or below");
const resultWord = (r: "WIN" | "DRAW" | "WIN_OR_DRAW" | "LOSE") =>
  r === "WIN" ? "win" : r === "DRAW" ? "draw" : r === "WIN_OR_DRAW" ? "win or draw" : "lose";

export const copy = {
  brand: "IFSO",
  tagline: "Money that moves when something happens.",
  oneLiner: "Send USDG that unlocks only if it happens: a date, a stock price, a match result, or a referee's OK. If it doesn't, it comes back.",

  parse: {
    usage:
      "Try: /ifso @jake 20 if arsenal win · /ifso link 50 on the 1st · /ifso @mia 100 if nvda closes above 200 by friday · /challenge @sam 10 if @ref says so",
    minAmount: "The smallest if-so payment is 1 USDG.",
    counterOnlyForChallenges: "Two amounts only work with /challenge (where both of you chip in).",
    challengeNeedsOutcome: "A challenge needs something to decide it: a price, a result, or a referee.",
    challengeNeedsReferee: "For a challenge, name a referee (\"if @ref says so\") instead of both tapping OK.",
    challengeLinkPrivate: "Challenge links are private invites. Share it only with the person you mean.",
    inPast: "That time has already passed.",
    badDate: (t: string) => `I couldn't read the date in "${t}". Try "on nov 1", "on the 1st", "by friday" or "in 3 days".`,
    unknownTicker: (t: string) => `${t} isn't available for price conditions yet.`,
    unknownCondition: (t: string) =>
      `I couldn't turn "${t}" into a condition. Use a date, a stock price, a team result, a Polymarket link, or a referee.`,
    needDirection: (t: string, p: string) => `Should ${t} be at or above $${p}, or at or below it?`,
    touchChallenge:
      "A challenge can only check the price at the deadline, not whether it touched a level at some point. Check the price at the deadline instead, or send this as a one-sided if-so payment where touching counts?",
    optCheckAtDeadline: "Check at the deadline",
    optSendAsIfso: "One-sided if-so payment",
    needDeadline: "By when? Add something like \"by friday\" or \"on nov 14\".",
    inferredDirection: (t: string, op: "GTE" | "LTE") => `Reading this as ${t} reaching ${opWord(op)} that level.`,
    inclusive: "Levels count when reached exactly (\"above 200\" includes 200.00).",
    atDeadlineMeaning:
      "This checks the price at the deadline. To count any moment before it, say \"hits\" instead.",
    sportsRules:
      "Results count after 90 minutes plus stoppage time. Postponed or abandoned matches send the money back.",
    optAbove: (p: string) => `At or above $${p}`,
    optBelow: (p: string) => `At or below $${p}`,
    optTomorrow: "Tomorrow's close",
    optFriday: "This Friday's close",
    optNextFriday: "Next Friday's close",
    askDateFormat: (t: string) => `Is ${t} day/month or month/day?`,
    optDayFirst: (d: string | number, m: string) => `${d} ${m}`,
    optMonthFirst: (d: string | number, m: string) => `${m} ${d}`,
    weekendRolled: "weekend date moved to Friday's close (US market hours)",
    askWeekend: "US markets are closed that day. Which close should count?",
    optFridayClose: "Friday's close",
    optMondayClose: "Monday's close",
    nextFixture: (team: string) => `I'll match ${team}'s next scheduled fixture and show it before you confirm.`,
  },

  describe: {
    time: (when: string) => `it unlocks on ${when}`,
    price: (t: string, op: "GTE" | "LTE", px: string, mode: "AT_DEADLINE" | "TOUCH", when: string) =>
      mode === "TOUCH"
        ? `${t} reaches ${opWord(op)} $${px} at any point before ${when}`
        : `${t} is ${opWord(op)} $${px} at ${when}`,
    sports: (team: string, r: "WIN" | "DRAW" | "WIN_OR_DRAW" | "LOSE", opp?: string, when?: string) =>
      `${team} ${resultWord(r)}${opp ? ` against ${opp}` : ""}${when ? ` (${when})` : ""}`,
    market: (venue: "polymarket" | "hyperliquid", ref: string, ans: "YES" | "NO") =>
      `the ${venue === "polymarket" ? "Polymarket" : "Hyperliquid"} question ${ref} resolves ${ans}`,
    parties: "you both tap OK",
    referee: (r: string) => `${r} (referee) says so`,
  },

  preview: {
    linkHolder: "whoever opens your link",
    payment: (who: string, amt: string, cond: string) =>
      `Send ${amt} USDG to ${who}. It unlocks if ${cond}. If that doesn't happen, it comes back to you.`,
    challenge: (who: string, a: string, b: string, cond: string) =>
      `Challenge with ${who}: you chip in ${a} USDG, they chip in ${b} USDG. If ${cond}, ${who} receives both. Otherwise you do. If it can't be decided, each of you gets your own back. Only the people you invite can join.`,
    fee: (fee: string) => `Flat fee: ${fee} USDG. Nothing is taken from the amount itself.`,
    expiry: (when: string) => `If it's still undecided on ${when}, it comes back automatically.`,
    expiryAfterResult: "If it's still undecided about a week after the result is due, it comes back automatically.",
    priceBand: "Prices are read within about 0.5%, so a result that close to your level can go either way.",
    geoBlockedPrice:
      "Stock price conditions aren't available in your region. Dates, results and referee payments still work.",
  },

  bot: {
    welcome:
      "IFSO sends money that moves only if something happens. Type /ifso followed by who, how much and the condition. You sign in the web app; the bot never holds your keys or funds.",
    confirmButton: "Review and sign",
    shareButton: "Share claim link",
    openButton: "Open in IFSO",
    askAmbiguity: (q: string) => `Quick check: ${q}`,
    created: (amt: string) => `Done. ${amt} USDG is locked in your if-so payment.`,
    claimDm: (from: string, amt: string, cond: string) =>
      `${from} sent you ${amt} USDG on IFSO. It unlocks if ${cond}. Open the link to claim it now (no wallet needed).`,
    met: "It happened: the if-so payment is unlocked.",
    released: (amt: string, to: string) => `${amt} USDG went to ${to}.`,
    returned: (amt: string) => `${amt} USDG came back to you.`,
    voided: "It couldn't be decided, so everyone got their own money back.",
    voidedOwed:
      "It couldn't be decided, so everyone gets their own money back. Yours couldn't be sent to your saved address (it can't receive USDG right now), so it is being held for you. We'll keep trying, or set a new refund address and it goes there.",
    voidClaimed: (amt: string, to: string) => `${amt} USDG that was held after a voided challenge went to ${to}.`,
    expiringSoon: (when: string) => `Reminder: this if-so payment comes back on ${when} if it isn't claimed.`,
    resolverPosted: (q: string, outcome: string) =>
      `Result posted for ${q}: ${outcome}. Anyone can challenge it for the next 2 hours.`,
    help:
      "Commands: /ifso, /challenge, /mine, /tz, /help. Conditions: dates, stock prices (where available), match results, Polymarket questions, both tapping OK, or a referee.",
    notAvailable: "That isn't available in your region.",
    noFixture: (team: string) => `I couldn't find an upcoming league fixture for ${team}. Check the spelling or add the opponent, like "arsenal beat chelsea".`,
    fixtureFound: (home: string, away: string, league: string, when: string) => `Matched fixture: ${home} vs ${away} (${league}), kickoff ${when}.`,
    askTeam: (team: string) => `Which team did you mean by "${team}"?`,
    teamOption: (name: string, league: string, when: string) => `${name} · ${league} · ${when}`,
    questionExpired: "That question timed out. Send the command again.",
    notYours: "Those buttons belong to someone else.",
    nothingYet: "No if-so payments yet.",
    mineLine: (amt: string, status: string, when: string) => `${amt} USDG · ${status} · comes back ${when}`,
    tzUsage: "Set your time zone with a name like /tz Europe/London or /tz America/Toronto (a plain offset like /tz +4 works too).",
    tzCurrent: (z: string) => `Your time zone is ${z}.`,
    tzNone: "No time zone set yet, so times show in UTC.",
    tzSet: (z: string, off: string) => `Time zone set to ${z} (${off} right now).`,
    tzBad: (z: string) => `I don't know the time zone "${z}". Try a name like Europe/London.`,
    wrongBot: "Send this as a command, like /ifso @jake 20 if arsenal win.",
    busy: "Too many requests. Try again in a minute.",
    failed: "Something went wrong on our side. Try again in a moment.",
    incoming: (amt: string) => `An if-so payment of ${amt} USDG is waiting for you.`,
    refereeAsked: (amt: string) => `You were named referee for an if-so payment of ${amt} USDG.`,
    claimed: (amt: string) => `${amt} USDG was claimed. It unlocks when the condition is met.`,
    accepted: "The challenge was accepted. Both sides are now in.",
    disputed: (q: string) => `The posted result for ${q} was challenged. A review panel will decide.`,
  },

  web: {
    claimTitle: (amt: string) => `${amt} USDG is waiting for you`,
    claimCta: "Claim with a passkey",
    claimWalletCta: "Claim to my wallet",
    claimPendingNote: "It's yours to claim now. It unlocks for you when the condition is met.",
    phishingNote: "Only claim on the official IFSO site. The amount and condition shown here are read from the chain.",
    refundAltLabel: "Backup refund address (optional)",
    refundAltHelp: "If your main address can't receive funds later, refunds can go here instead.",
    cancellableLabel: "Let me cancel before it's decided",
  },
} as const;
