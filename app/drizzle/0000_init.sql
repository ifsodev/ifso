CREATE TABLE "chain_events" (
	"block_number" bigint NOT NULL,
	"log_index" integer NOT NULL,
	"tx_hash" text NOT NULL,
	"address" text NOT NULL,
	"name" text NOT NULL,
	"args" jsonb NOT NULL,
	"escrow_id" text,
	CONSTRAINT "chain_events_block_number_log_index_pk" PRIMARY KEY("block_number","log_index")
);
--> statement-breakpoint
CREATE TABLE "cursors" (
	"name" text PRIMARY KEY NOT NULL,
	"block" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escrows" (
	"id" text PRIMARY KEY NOT NULL,
	"sender" text NOT NULL,
	"recipient" text,
	"link_key" text,
	"amount" numeric(30, 0) NOT NULL,
	"counter_amount" numeric(30, 0) DEFAULT '0' NOT NULL,
	"kind" smallint NOT NULL,
	"condition" jsonb NOT NULL,
	"condition_hash" text NOT NULL,
	"feed" text,
	"question_id" text,
	"deadline" timestamp with time zone,
	"expiry" timestamp with time zone NOT NULL,
	"accept_by" timestamp with time zone,
	"two_sided" boolean DEFAULT false NOT NULL,
	"accepted" boolean DEFAULT false NOT NULL,
	"active_from" timestamp with time zone NOT NULL,
	"alt_refund_to" text,
	"status" smallint NOT NULL,
	"created_block" bigint NOT NULL,
	"created_tx" text NOT NULL,
	"fee_paid" numeric(30, 0) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tg_id" bigint,
	"tg_chat_id" bigint,
	"text" text,
	"draft" jsonb NOT NULL,
	"params" jsonb,
	"sender" text,
	"escrow_id" text,
	"recipient_handle" text,
	"state" text DEFAULT 'draft' NOT NULL,
	"tx_hash" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_rounds" (
	"feed" text NOT NULL,
	"round_id" numeric(30, 0) NOT NULL,
	"answer" numeric(40, 0) NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "price_rounds_feed_round_id_pk" PRIMARY KEY("feed","round_id")
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"spec" jsonb NOT NULL,
	"spec_hash" text NOT NULL,
	"spec_uri" text NOT NULL,
	"title" text NOT NULL,
	"home" text,
	"away" text,
	"provider_refs" jsonb NOT NULL,
	"close_time" timestamp with time zone NOT NULL,
	"earliest_resolve" timestamp with time zone NOT NULL,
	"num_outcomes" smallint NOT NULL,
	"state" smallint DEFAULT 1 NOT NULL,
	"proposed_outcome" smallint,
	"proposer" text,
	"final_outcome" smallint,
	"created_tx" text
);
--> statement-breakpoint
CREATE TABLE "relay_txs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"escrow_id" text,
	"question_id" text,
	"tx_hash" text,
	"status" text NOT NULL,
	"error" text,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"question_id" text NOT NULL,
	"provider" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"outcome" smallint,
	"digest" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tg_users" (
	"tg_id" bigint PRIMARY KEY NOT NULL,
	"username" text,
	"address" text,
	"tz_offset_min" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watchers" (
	"escrow_id" text NOT NULL,
	"tg_chat_id" bigint NOT NULL,
	"role" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "chain_events_escrow_idx" ON "chain_events" USING btree ("escrow_id");--> statement-breakpoint
CREATE INDEX "escrows_status_kind_idx" ON "escrows" USING btree ("status","kind");--> statement-breakpoint
CREATE INDEX "escrows_expiry_idx" ON "escrows" USING btree ("expiry");--> statement-breakpoint
CREATE INDEX "escrows_sender_idx" ON "escrows" USING btree ("sender");--> statement-breakpoint
CREATE INDEX "escrows_recipient_idx" ON "escrows" USING btree ("recipient");--> statement-breakpoint
CREATE INDEX "escrows_feed_idx" ON "escrows" USING btree ("feed");--> statement-breakpoint
CREATE INDEX "escrows_question_idx" ON "escrows" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "intents_escrow_idx" ON "intents" USING btree ("escrow_id");--> statement-breakpoint
CREATE INDEX "price_rounds_time_idx" ON "price_rounds" USING btree ("feed","updated_at");--> statement-breakpoint
CREATE INDEX "questions_state_idx" ON "questions" USING btree ("state","earliest_resolve");--> statement-breakpoint
CREATE INDEX "questions_close_idx" ON "questions" USING btree ("close_time");--> statement-breakpoint
CREATE INDEX "relay_txs_kind_idx" ON "relay_txs" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "source_reports_q_idx" ON "source_reports" USING btree ("question_id");--> statement-breakpoint
CREATE UNIQUE INDEX "watchers_uq" ON "watchers" USING btree ("escrow_id","tg_chat_id");