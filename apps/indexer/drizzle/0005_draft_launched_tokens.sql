CREATE TABLE "launched_tokens" (
	"chain_id" integer NOT NULL,
	"token" text NOT NULL,
	"factory" text NOT NULL,
	"creator" text NOT NULL,
	"recipient" text NOT NULL,
	"name" text NOT NULL,
	"symbol" text NOT NULL,
	"supply" numeric(78, 0) NOT NULL,
	"block_number" bigint NOT NULL,
	"timestamp" bigint NOT NULL,
	"tx_hash" text NOT NULL,
	CONSTRAINT "launched_tokens_chain_id_token_pk" PRIMARY KEY("chain_id","token"),
	CONSTRAINT "launched_tokens_fmt" CHECK ("launched_tokens"."token" ~ '^0x[0-9a-f]{40}$' AND "launched_tokens"."creator" ~ '^0x[0-9a-f]{40}$' AND "launched_tokens"."recipient" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
ALTER TABLE "launched_tokens" ADD CONSTRAINT "launched_tokens_chain_id_block_number_blocks_chain_id_number_fk" FOREIGN KEY ("chain_id","block_number") REFERENCES "public"."blocks"("chain_id","number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "launched_tokens_creator_idx" ON "launched_tokens" USING btree ("chain_id","creator");--> statement-breakpoint
CREATE INDEX "launched_tokens_recipient_idx" ON "launched_tokens" USING btree ("chain_id","recipient");