-- DRAFT v2: treasury policies and strategies replace single mandates (contracts v2, new module deployment).
-- Chain-derived tables are rebuilt and every chain is re-indexed from its start block: their rows described the v1
-- module and cannot be translated. v1 proposals are kept, renamed to proposals_v1, because they are user data.
ALTER TABLE "proposals" RENAME TO "proposals_v1";--> statement-breakpoint
ALTER INDEX "proposals_pkey" RENAME TO "proposals_v1_pkey";--> statement-breakpoint
ALTER INDEX "proposals_safe_idx" RENAME TO "proposals_v1_safe_idx";--> statement-breakpoint
ALTER INDEX "proposals_mm_idx" RENAME TO "proposals_v1_mm_idx";--> statement-breakpoint
ALTER INDEX "proposals_mandate_uq" RENAME TO "proposals_v1_mandate_uq";--> statement-breakpoint
DROP TABLE "mm_probes";--> statement-breakpoint
DROP TABLE "snapshots";--> statement-breakpoint
DROP TABLE "attempts";--> statement-breakpoint
DROP TABLE "fills";--> statement-breakpoint
DROP TABLE "mandates";--> statement-breakpoint
DROP TABLE "raw_events";--> statement-breakpoint
DROP TYPE "public"."anchor_status";--> statement-breakpoint
-- Re-index from scratch: removing the blocks cascades to launched tokens; the cursor restarts at the start block.
DELETE FROM "sync_cursors";--> statement-breakpoint
DELETE FROM "blocks";--> statement-breakpoint
CREATE TABLE "raw_events" (
	"chain_id" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"address" text NOT NULL,
	"event_name" text NOT NULL,
	"policy_id" text,
	"strategy_id" text,
	"args" jsonb NOT NULL,
	CONSTRAINT "raw_events_chain_id_tx_hash_log_index_pk" PRIMARY KEY("chain_id","tx_hash","log_index"),
	CONSTRAINT "raw_events_fmt" CHECK ("raw_events"."address" ~ '^0x[0-9a-f]{40}$' AND "raw_events"."tx_hash" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"chain_id" integer NOT NULL,
	"policy_id" text NOT NULL,
	"module" text NOT NULL,
	"safe" text NOT NULL,
	"base" text NOT NULL,
	"quote" text NOT NULL,
	"status" smallint NOT NULL,
	"config" jsonb NOT NULL,
	"created_block" bigint NOT NULL,
	"updated_block" bigint NOT NULL,
	CONSTRAINT "policies_chain_id_policy_id_pk" PRIMARY KEY("chain_id","policy_id"),
	CONSTRAINT "policies_fmt" CHECK ("policies"."policy_id" ~ '^0x[0-9a-f]{64}$' AND "policies"."safe" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "policies_status" CHECK ("policies"."status" BETWEEN 1 AND 3)
);
--> statement-breakpoint
CREATE TABLE "strategies" (
	"chain_id" integer NOT NULL,
	"strategy_id" text NOT NULL,
	"policy_id" text NOT NULL,
	"safe" text NOT NULL,
	"mm" text NOT NULL,
	"base" text NOT NULL,
	"quote" text NOT NULL,
	"kind" smallint NOT NULL,
	"status" smallint NOT NULL,
	"active_strategy_hash" text NOT NULL,
	"bounds" jsonb NOT NULL,
	"params" jsonb NOT NULL,
	"created_block" bigint NOT NULL,
	"updated_block" bigint NOT NULL,
	CONSTRAINT "strategies_chain_id_strategy_id_pk" PRIMARY KEY("chain_id","strategy_id"),
	CONSTRAINT "strategies_fmt" CHECK ("strategies"."strategy_id" ~ '^0x[0-9a-f]{64}$' AND "strategies"."policy_id" ~ '^0x[0-9a-f]{64}$' AND "strategies"."mm" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "strategies_status" CHECK ("strategies"."status" BETWEEN 1 AND 3 AND "strategies"."kind" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "fills" (
	"chain_id" integer NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"timestamp" bigint NOT NULL,
	"policy_id" text NOT NULL,
	"strategy_id" text NOT NULL,
	"strategy_hash" text NOT NULL,
	"taker" text NOT NULL,
	"is_sell" boolean NOT NULL,
	"amount_in" numeric(78, 0) NOT NULL,
	"amount_out" numeric(78, 0) NOT NULL,
	"price_x36" numeric(78, 0) NOT NULL,
	"risk_mode" smallint NOT NULL,
	"fee_token" text,
	"fee_amount" numeric(78, 0) DEFAULT '0' NOT NULL,
	"reference_spot_x36" numeric(78, 0),
	"quality_bps" integer,
	CONSTRAINT "fills_chain_id_tx_hash_log_index_pk" PRIMARY KEY("chain_id","tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" integer NOT NULL,
	"strategy_id" text NOT NULL,
	"source" "attempt_source" NOT NULL,
	"outcome" "attempt_outcome" NOT NULL,
	"error_name" text,
	"error_args" jsonb,
	"revert_data" text,
	"explanation" text,
	"request" jsonb NOT NULL,
	"request_hash" text NOT NULL,
	"amount_in" numeric(78, 0),
	"amount_out" numeric(78, 0),
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"timestamp" bigint NOT NULL,
	"tx_hash" text,
	"log_index" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attempts_evidence" CHECK (("attempts"."source" = 'onchain_actor' AND "attempts"."tx_hash" IS NOT NULL AND "attempts"."log_index" IS NOT NULL) OR ("attempts"."source" = 'simulated' AND "attempts"."tx_hash" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "policy_snapshots" (
	"chain_id" integer NOT NULL,
	"policy_id" text NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"timestamp" bigint NOT NULL,
	"status" smallint NOT NULL,
	"period_index" numeric(78, 0) NOT NULL,
	"gross_sold" numeric(78, 0) NOT NULL,
	"net_sold" numeric(78, 0) NOT NULL,
	"quote_spent" numeric(78, 0) NOT NULL,
	"total_net_sold" numeric(78, 0) NOT NULL,
	"released" numeric(78, 0) NOT NULL,
	"period_ends_at" numeric(78, 0) NOT NULL,
	"risk_mode" smallint NOT NULL,
	"risk_reason" smallint NOT NULL,
	"priced" boolean NOT NULL,
	"spot_x36" numeric(78, 0) NOT NULL,
	"twap_x36" numeric(78, 0) NOT NULL,
	"short_twap_x36" numeric(78, 0) NOT NULL,
	"trusted_depth_base" numeric(78, 0) NOT NULL,
	"pool_age" bigint NOT NULL,
	CONSTRAINT "policy_snapshots_chain_id_policy_id_block_number_pk" PRIMARY KEY("chain_id","policy_id","block_number"),
	CONSTRAINT "policy_snapshots_mode" CHECK ("policy_snapshots"."risk_mode" BETWEEN 0 AND 2)
);
--> statement-breakpoint
CREATE TABLE "strategy_snapshots" (
	"chain_id" integer NOT NULL,
	"strategy_id" text NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"timestamp" bigint NOT NULL,
	"status" smallint NOT NULL,
	"spread_bps" integer NOT NULL,
	"shipped_base" numeric(78, 0) NOT NULL,
	"shipped_quote" numeric(78, 0) NOT NULL,
	"nonce" numeric(78, 0) NOT NULL,
	"fees_base" numeric(78, 0) NOT NULL,
	"fees_quote" numeric(78, 0) NOT NULL,
	"claimed_base" numeric(78, 0) NOT NULL,
	"claimed_quote" numeric(78, 0) NOT NULL,
	CONSTRAINT "strategy_snapshots_chain_id_strategy_id_block_number_pk" PRIMARY KEY("chain_id","strategy_id","block_number")
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
	"kind" smallint NOT NULL,
	"terms" jsonb NOT NULL,
	"terms_hash" text NOT NULL,
	"status" "proposal_status" DEFAULT 'draft' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"mm_signature" text,
	"strategy_id" text,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	CONSTRAINT "proposals_fmt" CHECK ("proposals"."safe" ~ '^0x[0-9a-f]{40}$' AND "proposals"."issuer" ~ '^0x[0-9a-f]{40}$'
        AND "proposals"."mm" ~ '^0x[0-9a-f]{40}$' AND "proposals"."base" ~ '^0x[0-9a-f]{40}$'
        AND "proposals"."quote" ~ '^0x[0-9a-f]{40}$' AND "proposals"."terms_hash" ~ '^0x[0-9a-f]{64}$'
        AND ("proposals"."strategy_id" IS NULL OR "proposals"."strategy_id" ~ '^0x[0-9a-f]{64}$') AND char_length("proposals"."note") <= 1000
        AND "proposals"."kind" BETWEEN 0 AND 1),
	CONSTRAINT "proposals_state" CHECK (("proposals"."status" <> 'accepted' OR "proposals"."mm_signature" IS NOT NULL)
        AND ("proposals"."status" <> 'executed' OR ("proposals"."mm_signature" IS NOT NULL AND "proposals"."strategy_id" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "mm_probes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" integer NOT NULL,
	"strategy_id" text NOT NULL,
	"mm" text NOT NULL,
	"block_number" bigint NOT NULL,
	"timestamp" bigint NOT NULL,
	"side" text NOT NULL,
	"outcome" "probe_outcome" NOT NULL,
	"error_name" text,
	CONSTRAINT "mm_probes_fmt" CHECK ("mm_probes"."side" IN ('sell', 'buy') AND "mm_probes"."mm" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
ALTER TABLE "raw_events" ADD CONSTRAINT "raw_events_chain_id_block_number_blocks_chain_id_number_fk" FOREIGN KEY ("chain_id","block_number") REFERENCES "public"."blocks"("chain_id","number") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_chain_id_created_block_blocks_chain_id_number_fk" FOREIGN KEY ("chain_id","created_block") REFERENCES "public"."blocks"("chain_id","number") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "strategies" ADD CONSTRAINT "strategies_chain_id_created_block_blocks_chain_id_number_fk" FOREIGN KEY ("chain_id","created_block") REFERENCES "public"."blocks"("chain_id","number") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "strategies" ADD CONSTRAINT "strategies_chain_id_policy_id_policies_chain_id_policy_id_fk" FOREIGN KEY ("chain_id","policy_id") REFERENCES "public"."policies"("chain_id","policy_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_chain_id_block_number_blocks_chain_id_number_fk" FOREIGN KEY ("chain_id","block_number") REFERENCES "public"."blocks"("chain_id","number") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_chain_id_block_number_blocks_chain_id_number_fk" FOREIGN KEY ("chain_id","block_number") REFERENCES "public"."blocks"("chain_id","number") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "policy_snapshots" ADD CONSTRAINT "policy_snapshots_chain_id_block_number_blocks_chain_id_number_fk" FOREIGN KEY ("chain_id","block_number") REFERENCES "public"."blocks"("chain_id","number") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "strategy_snapshots" ADD CONSTRAINT "strategy_snapshots_chain_id_block_number_blocks_chain_id_number_fk" FOREIGN KEY ("chain_id","block_number") REFERENCES "public"."blocks"("chain_id","number") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_issuer_accounts_address_fk" FOREIGN KEY ("issuer") REFERENCES "public"."accounts"("address") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mm_probes" ADD CONSTRAINT "mm_probes_chain_id_block_number_blocks_chain_id_number_fk" FOREIGN KEY ("chain_id","block_number") REFERENCES "public"."blocks"("chain_id","number") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "raw_events_policy_idx" ON "raw_events" USING btree ("chain_id","policy_id","block_number");
--> statement-breakpoint
CREATE INDEX "raw_events_strategy_idx" ON "raw_events" USING btree ("chain_id","strategy_id","block_number");
--> statement-breakpoint
CREATE INDEX "policies_safe_idx" ON "policies" USING btree ("chain_id","safe");
--> statement-breakpoint
CREATE INDEX "strategies_policy_idx" ON "strategies" USING btree ("chain_id","policy_id");
--> statement-breakpoint
CREATE INDEX "strategies_safe_idx" ON "strategies" USING btree ("chain_id","safe");
--> statement-breakpoint
CREATE INDEX "strategies_mm_idx" ON "strategies" USING btree ("chain_id","mm");
--> statement-breakpoint
CREATE INDEX "fills_strategy_idx" ON "fills" USING btree ("chain_id","strategy_id","block_number" DESC NULLS LAST,"log_index" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "fills_policy_idx" ON "fills" USING btree ("chain_id","policy_id","block_number" DESC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_log_uq" ON "attempts" USING btree ("chain_id","tx_hash","log_index");
--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_sim_uq" ON "attempts" USING btree ("chain_id","strategy_id","request_hash","block_number") WHERE "attempts"."source" = 'simulated';
--> statement-breakpoint
CREATE INDEX "attempts_strategy_idx" ON "attempts" USING btree ("chain_id","strategy_id","block_number" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "proposals_safe_idx" ON "proposals" USING btree ("chain_id","safe");
--> statement-breakpoint
CREATE INDEX "proposals_mm_idx" ON "proposals" USING btree ("chain_id","mm");
--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_strategy_uq" ON "proposals" USING btree ("chain_id","strategy_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "mm_probes_uq" ON "mm_probes" USING btree ("chain_id","strategy_id","block_number","side");
--> statement-breakpoint
CREATE INDEX "mm_probes_mm_idx" ON "mm_probes" USING btree ("chain_id","mm","timestamp");
