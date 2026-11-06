CREATE TYPE "public"."probe_outcome" AS ENUM('ok', 'mm_fault', 'neutral');--> statement-breakpoint
CREATE TABLE "mm_probes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" integer NOT NULL,
	"mandate_id" text NOT NULL,
	"mm" text NOT NULL,
	"block_number" bigint NOT NULL,
	"timestamp" bigint NOT NULL,
	"side" text NOT NULL,
	"outcome" "probe_outcome" NOT NULL,
	"error_name" text,
	CONSTRAINT "mm_probes_fmt" CHECK ("mm_probes"."side" IN ('sell', 'buy') AND "mm_probes"."mm" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
ALTER TABLE "mm_probes" ADD CONSTRAINT "mm_probes_chain_id_block_number_blocks_chain_id_number_fk" FOREIGN KEY ("chain_id","block_number") REFERENCES "public"."blocks"("chain_id","number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mm_probes_uq" ON "mm_probes" USING btree ("chain_id","mandate_id","block_number","side");--> statement-breakpoint
CREATE INDEX "mm_probes_mm_idx" ON "mm_probes" USING btree ("chain_id","mm","timestamp");