CREATE TABLE "accounts" (
	"address" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sign_in_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_fmt" CHECK ("accounts"."address" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "auth_sessions_fmt" CHECK ("auth_sessions"."token_hash" ~ '^0x[0-9a-f]{64}$' AND "auth_sessions"."address" ~ '^0x[0-9a-f]{40}$' AND "auth_sessions"."expires_at" > "auth_sessions"."created_at")
);
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_address_accounts_address_fk" FOREIGN KEY ("address") REFERENCES "public"."accounts"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_token_uq" ON "auth_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_sessions_address_idx" ON "auth_sessions" USING btree ("address");