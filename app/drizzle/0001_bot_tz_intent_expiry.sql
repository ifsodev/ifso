ALTER TABLE "intents" ADD COLUMN "tz_offset_min" integer;--> statement-breakpoint
ALTER TABLE "intents" ADD COLUMN "expires_at" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL;--> statement-breakpoint
ALTER TABLE "tg_users" ADD COLUMN "tz" text;