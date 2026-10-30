CREATE TABLE "link_requests" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"tg_id" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
