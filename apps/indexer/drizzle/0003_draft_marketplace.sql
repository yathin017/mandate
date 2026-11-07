CREATE TYPE "public"."proposal_status" AS ENUM('draft', 'sent', 'accepted', 'declined', 'withdrawn', 'expired', 'executed');--> statement-breakpoint
CREATE TABLE "mm_profiles" (
	"address" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"bio" text DEFAULT '' NOT NULL,
	"website" text,
	"contact" text,
	"coverage" text[] DEFAULT '{}'::text[] NOT NULL,
	"min_deal_usd" integer,
	"listed" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mm_profiles_fmt" CHECK ("mm_profiles"."address" ~ '^0x[0-9a-f]{40}$' AND char_length("mm_profiles"."display_name") BETWEEN 1 AND 64
        AND char_length("mm_profiles"."bio") <= 1000 AND ("mm_profiles"."min_deal_usd" IS NULL OR "mm_profiles"."min_deal_usd" >= 0)
        AND cardinality("mm_profiles"."coverage") <= 10)
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" integer NOT NULL,
	"safe" text NOT NULL,
	"issuer" text NOT NULL,
	"mm" text NOT NULL,
	"base" text NOT NULL,
	"quote" text NOT NULL,
	"terms" jsonb NOT NULL,
	"terms_hash" text NOT NULL,
	"status" "proposal_status" DEFAULT 'draft' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"mm_signature" text,
	"mandate_id" text,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	CONSTRAINT "proposals_fmt" CHECK ("proposals"."safe" ~ '^0x[0-9a-f]{40}$' AND "proposals"."issuer" ~ '^0x[0-9a-f]{40}$'
        AND "proposals"."mm" ~ '^0x[0-9a-f]{40}$' AND "proposals"."base" ~ '^0x[0-9a-f]{40}$'
        AND "proposals"."quote" ~ '^0x[0-9a-f]{40}$' AND "proposals"."terms_hash" ~ '^0x[0-9a-f]{64}$'
        AND ("proposals"."mandate_id" IS NULL OR "proposals"."mandate_id" ~ '^0x[0-9a-f]{64}$') AND char_length("proposals"."note") <= 1000),
	CONSTRAINT "proposals_state" CHECK (("proposals"."status" <> 'accepted' OR "proposals"."mm_signature" IS NOT NULL)
        AND ("proposals"."status" <> 'executed' OR ("proposals"."mm_signature" IS NOT NULL AND "proposals"."mandate_id" IS NOT NULL)))
);
--> statement-breakpoint
ALTER TABLE "mm_profiles" ADD CONSTRAINT "mm_profiles_address_accounts_address_fk" FOREIGN KEY ("address") REFERENCES "public"."accounts"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_issuer_accounts_address_fk" FOREIGN KEY ("issuer") REFERENCES "public"."accounts"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mm_profiles_listed_idx" ON "mm_profiles" USING btree ("listed");--> statement-breakpoint
CREATE INDEX "proposals_safe_idx" ON "proposals" USING btree ("chain_id","safe");--> statement-breakpoint
CREATE INDEX "proposals_mm_idx" ON "proposals" USING btree ("chain_id","mm");--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_mandate_uq" ON "proposals" USING btree ("chain_id","mandate_id");