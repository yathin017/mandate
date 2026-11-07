CREATE TABLE "tokens" (
	"chain_id" integer NOT NULL,
	"address" text NOT NULL,
	"symbol" text NOT NULL,
	"decimals" smallint NOT NULL,
	CONSTRAINT "tokens_chain_id_address_pk" PRIMARY KEY("chain_id","address"),
	CONSTRAINT "tokens_fmt" CHECK ("tokens"."address" ~ '^0x[0-9a-f]{40}$' AND "tokens"."decimals" BETWEEN 0 AND 255)
);
--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_chain_id_chains_chain_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("chain_id") ON DELETE no action ON UPDATE no action;