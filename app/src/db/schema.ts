import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Telegram users who talked to the bot. `address` is optional (linked for notifications only). */
export const tgUsers = pgTable("tg_users", {
  tgId: bigint("tg_id", { mode: "bigint" }).primaryKey(),
  username: text("username"),
  address: text("address"),
  tzOffsetMin: integer("tz_offset_min").notNull().default(0),
  tz: text("tz"), //                 IANA zone from /tz (DST aware); tzOffsetMin is its offset when it was set
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One-time /link requests: the bot hands out a random token (kept only as a hash) and the site proves wallet ownership against it. */
export const linkRequests = pgTable("link_requests", {
  tokenHash: text("token_hash").primaryKey(),
  tgId: bigint("tg_id", { mode: "bigint" }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Drafts built from the bot or the web form, before the sender signs. Never contains a link secret. */
export const intents = pgTable(
  "intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tgId: bigint("tg_id", { mode: "bigint" }),
    tgChatId: bigint("tg_chat_id", { mode: "bigint" }),
    text: text("text"),
    draft: jsonb("draft").notNull(),
    params: jsonb("params"), //  CreateParams with bigints as strings (after build)
    sender: text("sender"),
    escrowId: text("escrow_id"),
    recipientHandle: text("recipient_handle"),
    state: text("state", { enum: ["draft", "built", "submitted", "confirmed", "failed"] }).notNull().default("draft"),
    tzOffsetMin: integer("tz_offset_min"), //  offset the bot used for the deadline, so the web build reads the same instant
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull().default(sql`now() + interval '24 hours'`),
    txHash: text("tx_hash"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("intents_escrow_idx").on(t.escrowId)],
);

/** Indexed escrow state (source of truth is the chain; this is a cache for keepers, bot and UI). */
export const escrows = pgTable(
  "escrows",
  {
    id: text("id").primaryKey(), // uint256 as decimal string
    sender: text("sender").notNull(),
    recipient: text("recipient"),
    linkKey: text("link_key"),
    amount: numeric("amount", { precision: 30, scale: 0 }).notNull(),
    counterAmount: numeric("counter_amount", { precision: 30, scale: 0 }).notNull().default("0"),
    kind: smallint("kind").notNull(),
    condition: jsonb("condition").notNull(),
    conditionHash: text("condition_hash").notNull(),
    feed: text("feed"),
    questionId: text("question_id"),
    deadline: timestamp("deadline", { withTimezone: true }),
    expiry: timestamp("expiry", { withTimezone: true }).notNull(),
    acceptBy: timestamp("accept_by", { withTimezone: true }),
    twoSided: boolean("two_sided").notNull().default(false),
    /** VOIDED challenge sides still owed (1 = sender side, 2 = acceptor side): a side whose transfer failed at void time. */
    voidOwed: smallint("void_owed").notNull().default(0),
    accepted: boolean("accepted").notNull().default(false),
    activeFrom: timestamp("active_from", { withTimezone: true }).notNull(),
    altRefundTo: text("alt_refund_to"),
    status: smallint("status").notNull(),
    createdBlock: bigint("created_block", { mode: "bigint" }).notNull(),
    createdTx: text("created_tx").notNull(),
    feePaid: numeric("fee_paid", { precision: 30, scale: 0 }).notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("escrows_status_kind_idx").on(t.status, t.kind),
    index("escrows_expiry_idx").on(t.expiry),
    index("escrows_sender_idx").on(t.sender),
    index("escrows_recipient_idx").on(t.recipient),
    index("escrows_feed_idx").on(t.feed),
    index("escrows_question_idx").on(t.questionId),
  ],
);

/** Outcome questions registered on IfsoOutcomeResolver. */
export const questions = pgTable(
  "questions",
  {
    id: text("id").primaryKey(), // bytes32
    source: text("source", { enum: ["football", "polymarket", "hip4"] }).notNull(),
    spec: jsonb("spec").notNull(), // canonical rules; specHash = keccak(canonical JSON)
    specHash: text("spec_hash").notNull(),
    specUri: text("spec_uri").notNull(),
    title: text("title").notNull(),
    home: text("home"),
    away: text("away"),
    providerRefs: jsonb("provider_refs").notNull(), // { theoddsapi: eventId, thesportsdb: idEvent, polymarket: slug, ... }
    closeTime: timestamp("close_time", { withTimezone: true }).notNull(),
    earliestResolve: timestamp("earliest_resolve", { withTimezone: true }).notNull(),
    numOutcomes: smallint("num_outcomes").notNull(),
    state: smallint("state").notNull().default(1),
    proposedOutcome: smallint("proposed_outcome"),
    proposer: text("proposer"),
    finalOutcome: smallint("final_outcome"),
    /** When the proposal was disputed (panel clock starts here). */
    disputedAt: timestamp("disputed_at", { withTimezone: true }),
    /**
     * Review R3-H1: why the service disputed: "contradicted" (sources say otherwise) or "last-call" (sources could not
     * confirm before the slot); "last-call-done" once the panel or a timeout settled it. Null = not disputed by us.
     */
    disputeKind: text("dispute_kind"),
    createdTx: text("created_tx"),
  },
  (t) => [index("questions_state_idx").on(t.state, t.earliestResolve), index("questions_close_idx").on(t.closeTime)],
);

/** Every provider read the resolver service made (raw bodies stay off-chain, referenced by digest). */
export const sourceReports = pgTable(
  "source_reports",
  {
    id: serial("id").primaryKey(),
    questionId: text("question_id").notNull(),
    provider: text("provider").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    status: text("status", { enum: ["final", "pending", "void"] }).notNull(),
    outcome: smallint("outcome"),
    digest: text("digest").notNull(),
  },
  (t) => [index("source_reports_q_idx").on(t.questionId)],
);

/** Chainlink round cache: a normal table, indexed on (feed, updated_at). */
export const priceRounds = pgTable(
  "price_rounds",
  {
    feed: text("feed").notNull(),
    roundId: numeric("round_id", { precision: 30, scale: 0 }).notNull(),
    answer: numeric("answer", { precision: 40, scale: 0 }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.feed, t.roundId] }), index("price_rounds_time_idx").on(t.feed, t.updatedAt)],
);

/** Raw decoded logs (append-only) for audit and replays. */
export const chainEvents = pgTable(
  "chain_events",
  {
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    logIndex: integer("log_index").notNull(),
    txHash: text("tx_hash").notNull(),
    address: text("address").notNull(),
    name: text("name").notNull(),
    args: jsonb("args").notNull(),
    escrowId: text("escrow_id"),
    /** Block timestamp (the real-user counter groups by day from this). Null on rows indexed before it existed. */
    blockTime: timestamp("block_time", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.blockNumber, t.logIndex] }), index("chain_events_escrow_idx").on(t.escrowId)],
);

/** Transactions sent by the relayer / keeper / resolver hot keys. */
export const relayTxs = pgTable(
  "relay_txs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    escrowId: text("escrow_id"),
    questionId: text("question_id"),
    txHash: text("tx_hash"),
    status: text("status", { enum: ["sent", "mined", "reverted", "skipped"] }).notNull(),
    error: text("error"),
    ipHash: text("ip_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("relay_txs_kind_idx").on(t.kind, t.createdAt)],
);

export const cursors = pgTable("cursors", {
  name: text("name").primaryKey(),
  block: bigint("block", { mode: "bigint" }).notNull(),
  hash: text("hash"), //   main: hash of `block` when it was indexed (a mismatch later = reorg). watch:<feed>: decimal round id of the last handled round
});

/** Which Telegram chats to notify about which escrows (sender side; recipients opt in from the claim page). */
export const watchers = pgTable(
  "watchers",
  {
    escrowId: text("escrow_id").notNull(),
    tgChatId: bigint("tg_chat_id", { mode: "bigint" }).notNull(),
    role: text("role", { enum: ["sender", "recipient", "referee"] }).notNull(),
  },
  (t) => [uniqueIndex("watchers_uq").on(t.escrowId, t.tgChatId)],
);
