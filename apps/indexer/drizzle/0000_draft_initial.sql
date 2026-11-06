CREATE TYPE "public"."anchor_status" AS ENUM('within-spot-band', 'blocked', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."attempt_outcome" AS ENUM('allowed', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."attempt_source" AS ENUM('onchain_actor', 'simulated');--> statement-breakpoint
CREATE TABLE "attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" integer NOT NULL,
	"mandate_id" text NOT NULL,
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
CREATE TABLE "blocks" (
	"chain_id" integer NOT NULL,
	"number" bigint NOT NULL,
	"hash" text NOT NULL,
	"parent_hash" text NOT NULL,
	"timestamp" bigint NOT NULL,
	CONSTRAINT "blocks_chain_id_number_pk" PRIMARY KEY("chain_id","number"),
	CONSTRAINT "blocks_hash_fmt" CHECK ("blocks"."hash" ~ '^0x[0-9a-f]{64}$' AND "blocks"."parent_hash" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "chains" (
	"chain_id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"environment" text NOT NULL,
	"source_chain_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fills" (
	"chain_id" integer NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"timestamp" bigint NOT NULL,
	"mandate_id" text NOT NULL,
	"strategy_hash" text NOT NULL,
	"taker" text NOT NULL,
	"is_sell" boolean NOT NULL,
	"amount_in" numeric(78, 0) NOT NULL,
	"amount_out" numeric(78, 0) NOT NULL,
	"price_x36" numeric(78, 0) NOT NULL,
	"net_sold_this_epoch" numeric(78, 0) NOT NULL,
	"total_net_sold" numeric(78, 0) NOT NULL,
	"fee_token" text,
	"fee_amount" numeric(78, 0) DEFAULT '0' NOT NULL,
	CONSTRAINT "fills_chain_id_tx_hash_log_index_pk" PRIMARY KEY("chain_id","tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "mandates" (
	"chain_id" integer NOT NULL,
	"mandate_id" text NOT NULL,
	"module" text NOT NULL,
	"safe" text NOT NULL,
	"mm" text NOT NULL,
	"base" text NOT NULL,
	"quote" text NOT NULL,
	"status" smallint NOT NULL,
	"active_strategy_hash" text NOT NULL,
	"bounds" jsonb NOT NULL,
	"params" jsonb NOT NULL,
	"created_block" bigint NOT NULL,
	"updated_block" bigint NOT NULL,
	CONSTRAINT "mandates_chain_id_mandate_id_pk" PRIMARY KEY("chain_id","mandate_id"),
	CONSTRAINT "mandates_fmt" CHECK ("mandates"."mandate_id" ~ '^0x[0-9a-f]{64}$' AND "mandates"."safe" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "mandates_status" CHECK ("mandates"."status" BETWEEN 1 AND 3)
);
--> statement-breakpoint
CREATE TABLE "raw_events" (
	"chain_id" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"address" text NOT NULL,
	"event_name" text NOT NULL,
	"mandate_id" text,
	"args" jsonb NOT NULL,
	CONSTRAINT "raw_events_chain_id_tx_hash_log_index_pk" PRIMARY KEY("chain_id","tx_hash","log_index"),
	CONSTRAINT "raw_events_fmt" CHECK ("raw_events"."address" ~ '^0x[0-9a-f]{40}$' AND "raw_events"."tx_hash" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"chain_id" integer NOT NULL,
	"mandate_id" text NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"timestamp" bigint NOT NULL,
	"status" smallint NOT NULL,
	"spread_bps" integer NOT NULL,
	"epoch_cap" numeric(78, 0) NOT NULL,
	"epoch_index" numeric(78, 0) NOT NULL,
	"net_sold_this_epoch" numeric(78, 0) NOT NULL,
	"total_net_sold" numeric(78, 0) NOT NULL,
	"released" numeric(78, 0) NOT NULL,
	"remaining_this_epoch" numeric(78, 0) NOT NULL,
	"sellable_now" numeric(78, 0) NOT NULL,
	"epoch_resets_at" numeric(78, 0) NOT NULL,
	"fees_base" numeric(78, 0) NOT NULL,
	"fees_quote" numeric(78, 0) NOT NULL,
	"claimed_base" numeric(78, 0) NOT NULL,
	"claimed_quote" numeric(78, 0) NOT NULL,
	"anchor_status" "anchor_status" NOT NULL,
	"anchor_spot_x36" numeric(78, 0),
	"anchor_twap_x36" numeric(78, 0),
	"anchor_deviation_bps" numeric(78, 0),
	"anchor_max_deviation_bps" integer,
	CONSTRAINT "snapshots_chain_id_mandate_id_block_number_pk" PRIMARY KEY("chain_id","mandate_id","block_number")
);
--> statement-breakpoint
CREATE TABLE "sync_cursors" (
	"chain_id" integer PRIMARY KEY NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_chain_id_block_number_blocks_chain_id_number_fk" FOREIGN KEY ("chain_id","block_number") REFERENCES "public"."blocks"("chain_id","number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_chain_id_chains_chain_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("chain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_chain_id_block_number_blocks_chain_id_number_fk" FOREIGN KEY ("chain_id","block_number") REFERENCES "public"."blocks"("chain_id","number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_chain_id_created_block_blocks_chain_id_number_fk" FOREIGN KEY ("chain_id","created_block") REFERENCES "public"."blocks"("chain_id","number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_events" ADD CONSTRAINT "raw_events_chain_id_block_number_blocks_chain_id_number_fk" FOREIGN KEY ("chain_id","block_number") REFERENCES "public"."blocks"("chain_id","number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_chain_id_block_number_blocks_chain_id_number_fk" FOREIGN KEY ("chain_id","block_number") REFERENCES "public"."blocks"("chain_id","number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_chain_id_chains_chain_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("chain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_log_uq" ON "attempts" USING btree ("chain_id","tx_hash","log_index");--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_sim_uq" ON "attempts" USING btree ("chain_id","mandate_id","request_hash","block_number") WHERE "attempts"."source" = 'simulated';--> statement-breakpoint
CREATE INDEX "attempts_mandate_idx" ON "attempts" USING btree ("chain_id","mandate_id","block_number" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "blocks_hash_uq" ON "blocks" USING btree ("chain_id","hash");--> statement-breakpoint
CREATE INDEX "fills_mandate_idx" ON "fills" USING btree ("chain_id","mandate_id","block_number" DESC NULLS LAST,"log_index" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mandates_safe_idx" ON "mandates" USING btree ("chain_id","safe");--> statement-breakpoint
CREATE INDEX "mandates_mm_idx" ON "mandates" USING btree ("chain_id","mm");--> statement-breakpoint
CREATE INDEX "raw_events_mandate_idx" ON "raw_events" USING btree ("chain_id","mandate_id","block_number");