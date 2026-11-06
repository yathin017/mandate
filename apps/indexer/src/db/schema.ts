/**
 * DRAFT database schema. Not final: it will change with client requirements. Change it only through new
 * migrations (`pnpm db:generate`), never by editing applied ones.
 *
 * Design rules:
 * - Postgres is the source of truth for indexed history; Redis only caches reads.
 * - Every row is scoped by `chain_id`, so one database serves many chains.
 * - uint256 values are `numeric(78,0)` (Drizzle returns strings: no precision loss). Prices use the contracts'
 *   `quoteRaw * 1e36 / baseRaw` units. Addresses/hashes are lowercase 0x-hex text with format checks.
 * - Every evidence row references `blocks (chain_id, number)` with ON DELETE CASCADE. Rolling back a reorg is
 *   one delete of the orphaned blocks.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const uint256 = (name: string) => numeric(name, { precision: 78, scale: 0 });
const blockNumber = (name: string) => bigint(name, { mode: "bigint" });
const ADDRESS = "^0x[0-9a-f]{40}$";
const HASH = "^0x[0-9a-f]{64}$";

export const attemptSource = pgEnum("attempt_source", ["onchain_actor", "simulated"]);
export const attemptOutcome = pgEnum("attempt_outcome", ["allowed", "blocked"]);
export const anchorStatus = pgEnum("anchor_status", ["within-spot-band", "blocked", "unavailable"]);

/** Runtime chains this database indexes. `environment` discloses forks (e.g. `local-mainnet-fork`). */
export const chains = pgTable("chains", {
  chainId: integer("chain_id").primaryKey(),
  name: text("name").notNull(),
  environment: text("environment").notNull(),
  sourceChainId: integer("source_chain_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** ERC20 display metadata for tokens used by indexed mandates, read once from the chain. */
export const tokens = pgTable(
  "tokens",
  {
    chainId: integer("chain_id").notNull().references(() => chains.chainId),
    address: text("address").notNull(),
    symbol: text("symbol").notNull(),
    decimals: smallint("decimals").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.chainId, t.address] }),
    check("tokens_fmt", sql`${t.address} ~ ${sql.raw(`'${ADDRESS}'`)} AND ${t.decimals} BETWEEN 0 AND 255`),
  ],
);

/** Every block the worker has indexed. Parent hashes detect reorgs. */
export const blocks = pgTable(
  "blocks",
  {
    chainId: integer("chain_id").notNull().references(() => chains.chainId),
    number: blockNumber("number").notNull(),
    hash: text("hash").notNull(),
    parentHash: text("parent_hash").notNull(),
    /** Chain time, seconds. */
    timestamp: bigint("timestamp", { mode: "bigint" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.chainId, t.number] }),
    uniqueIndex("blocks_hash_uq").on(t.chainId, t.hash),
    check("blocks_hash_fmt", sql`${t.hash} ~ ${sql.raw(`'${HASH}'`)} AND ${t.parentHash} ~ ${sql.raw(`'${HASH}'`)}`),
  ],
);

/** Last fully indexed block per chain. */
export const syncCursors = pgTable("sync_cursors", {
  chainId: integer("chain_id").primaryKey().references(() => chains.chainId),
  blockNumber: blockNumber("block_number").notNull(),
  blockHash: text("block_hash").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Append-only ledger of every decoded log we index. Projections below can be rebuilt from it. */
export const rawEvents = pgTable(
  "raw_events",
  {
    chainId: integer("chain_id").notNull(),
    blockNumber: blockNumber("block_number").notNull(),
    blockHash: text("block_hash").notNull(),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    address: text("address").notNull(),
    eventName: text("event_name").notNull(),
    mandateId: text("mandate_id"),
    /** Decoded args; bigints as decimal strings. */
    args: jsonb("args").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.chainId, t.txHash, t.logIndex] }),
    foreignKey({ columns: [t.chainId, t.blockNumber], foreignColumns: [blocks.chainId, blocks.number] }).onDelete(
      "cascade",
    ),
    index("raw_events_mandate_idx").on(t.chainId, t.mandateId, t.blockNumber),
    check("raw_events_fmt", sql`${t.address} ~ ${sql.raw(`'${ADDRESS}'`)} AND ${t.txHash} ~ ${sql.raw(`'${HASH}'`)}`),
  ],
);

/** Latest terms and status per mandate, refreshed from chain reads at every block that touches it. */
export const mandates = pgTable(
  "mandates",
  {
    chainId: integer("chain_id").notNull(),
    mandateId: text("mandate_id").notNull(),
    module: text("module").notNull(),
    safe: text("safe").notNull(),
    mm: text("mm").notNull(),
    base: text("base").notNull(),
    quote: text("quote").notNull(),
    /** MandateStatus: 1 Active, 2 Paused, 3 Revoked. */
    status: smallint("status").notNull(),
    activeStrategyHash: text("active_strategy_hash").notNull(),
    /** Mirrors the DRAFT Solidity MandateBounds / MandateParams structs; bigints as strings. */
    bounds: jsonb("bounds").notNull(),
    params: jsonb("params").notNull(),
    createdBlock: blockNumber("created_block").notNull(),
    updatedBlock: blockNumber("updated_block").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.chainId, t.mandateId] }),
    // A mandate created in a reorged block disappears with it.
    foreignKey({ columns: [t.chainId, t.createdBlock], foreignColumns: [blocks.chainId, blocks.number] }).onDelete(
      "cascade",
    ),
    index("mandates_safe_idx").on(t.chainId, t.safe),
    index("mandates_mm_idx").on(t.chainId, t.mm),
    check("mandates_fmt", sql`${t.mandateId} ~ ${sql.raw(`'${HASH}'`)} AND ${t.safe} ~ ${sql.raw(`'${ADDRESS}'`)}`),
    check("mandates_status", sql`${t.status} BETWEEN 1 AND 3`),
  ],
);

/** One row per quoter `Filled` event, with the spread from the matching `FeeAccrued`. */
export const fills = pgTable(
  "fills",
  {
    chainId: integer("chain_id").notNull(),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    blockNumber: blockNumber("block_number").notNull(),
    timestamp: bigint("timestamp", { mode: "bigint" }).notNull(),
    mandateId: text("mandate_id").notNull(),
    strategyHash: text("strategy_hash").notNull(),
    taker: text("taker").notNull(),
    /** true: treasury sold base. */
    isSell: boolean("is_sell").notNull(),
    amountIn: uint256("amount_in").notNull(),
    amountOut: uint256("amount_out").notNull(),
    priceX36: uint256("price_x36").notNull(),
    netSoldThisEpoch: uint256("net_sold_this_epoch").notNull(),
    totalNetSold: uint256("total_net_sold").notNull(),
    feeToken: text("fee_token"),
    feeAmount: uint256("fee_amount").notNull().default("0"),
  },
  (t) => [
    primaryKey({ columns: [t.chainId, t.txHash, t.logIndex] }),
    foreignKey({ columns: [t.chainId, t.blockNumber], foreignColumns: [blocks.chainId, blocks.number] }).onDelete(
      "cascade",
    ),
    index("fills_mandate_idx").on(t.chainId, t.mandateId, t.blockNumber.desc(), t.logIndex.desc()),
  ],
);

/**
 * Trade attempts and their outcome. Reverted swaps leave no logs, so blocked attempts come from:
 * - `onchain_actor`: the demo ScenarioActor's `Attempted` event (receipt-backed, outer tx succeeded).
 * - `simulated`: the server re-ran the quote with eth_call at `block_number`. Client input is never trusted
 *   as an outcome; only the request parameters are taken from the client.
 */
export const attempts = pgTable(
  "attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chainId: integer("chain_id").notNull(),
    mandateId: text("mandate_id").notNull(),
    source: attemptSource("source").notNull(),
    outcome: attemptOutcome("outcome").notNull(),
    errorName: text("error_name"),
    errorArgs: jsonb("error_args"),
    revertData: text("revert_data"),
    explanation: text("explanation"),
    /** `{ taker, tokenIn, tokenOut, amount, isExactIn }` (simulated) or `{ target, act, step }` (onchain). */
    request: jsonb("request").notNull(),
    requestHash: text("request_hash").notNull(),
    /** Quoted amounts when allowed (simulated). */
    amountIn: uint256("amount_in"),
    amountOut: uint256("amount_out"),
    blockNumber: blockNumber("block_number").notNull(),
    blockHash: text("block_hash").notNull(),
    timestamp: bigint("timestamp", { mode: "bigint" }).notNull(),
    txHash: text("tx_hash"),
    logIndex: integer("log_index"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.chainId, t.blockNumber], foreignColumns: [blocks.chainId, blocks.number] }).onDelete(
      "cascade",
    ),
    uniqueIndex("attempts_log_uq").on(t.chainId, t.txHash, t.logIndex),
    uniqueIndex("attempts_sim_uq")
      .on(t.chainId, t.mandateId, t.requestHash, t.blockNumber)
      .where(sql`${t.source} = 'simulated'`),
    index("attempts_mandate_idx").on(t.chainId, t.mandateId, t.blockNumber.desc()),
    check(
      "attempts_evidence",
      sql`(${t.source} = 'onchain_actor' AND ${t.txHash} IS NOT NULL AND ${t.logIndex} IS NOT NULL) OR (${t.source} = 'simulated' AND ${t.txHash} IS NULL)`,
    ),
  ],
);

/** Gauge state per mandate at a block, read in one pinned-block SDK snapshot. Feeds the dashboard charts. */
export const snapshots = pgTable(
  "snapshots",
  {
    chainId: integer("chain_id").notNull(),
    mandateId: text("mandate_id").notNull(),
    blockNumber: blockNumber("block_number").notNull(),
    blockHash: text("block_hash").notNull(),
    timestamp: bigint("timestamp", { mode: "bigint" }).notNull(),
    status: smallint("status").notNull(),
    spreadBps: integer("spread_bps").notNull(),
    epochCap: uint256("epoch_cap").notNull(),
    epochIndex: uint256("epoch_index").notNull(),
    netSoldThisEpoch: uint256("net_sold_this_epoch").notNull(),
    totalNetSold: uint256("total_net_sold").notNull(),
    released: uint256("released").notNull(),
    remainingThisEpoch: uint256("remaining_this_epoch").notNull(),
    sellableNow: uint256("sellable_now").notNull(),
    epochResetsAt: uint256("epoch_resets_at").notNull(),
    feesBase: uint256("fees_base").notNull(),
    feesQuote: uint256("fees_quote").notNull(),
    claimedBase: uint256("claimed_base").notNull(),
    claimedQuote: uint256("claimed_quote").notNull(),
    anchorStatus: anchorStatus("anchor_status").notNull(),
    anchorSpotX36: uint256("anchor_spot_x36"),
    anchorTwapX36: uint256("anchor_twap_x36"),
    anchorDeviationBps: uint256("anchor_deviation_bps"),
    anchorMaxDeviationBps: integer("anchor_max_deviation_bps"),
  },
  (t) => [
    primaryKey({ columns: [t.chainId, t.mandateId, t.blockNumber] }),
    foreignKey({ columns: [t.chainId, t.blockNumber], foreignColumns: [blocks.chainId, blocks.number] }).onDelete(
      "cascade",
    ),
  ],
);

// ---------------------------------------------------------------- accounts and sessions (DRAFT)
// Platform identity, not chain evidence: these rows are not block-scoped and survive reorgs.

/** A wallet that has signed in at least once (EIP-4361). Profiles (market makers, issuers) will reference it. */
export const accounts = pgTable(
  "accounts",
  {
    address: text("address").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("accounts_fmt", sql`${t.address} ~ ${sql.raw(`'${ADDRESS}'`)}`)],
);

/**
 * Sign-in sessions. Only the SHA-256 of the cookie token is stored, so a database leak cannot be replayed as a
 * session. A session ends at `expires_at` or when `revoked_at` is set (sign-out); rows are never reused.
 */
export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    address: text("address")
      .notNull()
      .references(() => accounts.address),
    /** Chain the sign-in message was verified on (smart-wallet signatures are chain-specific). */
    chainId: integer("chain_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("auth_sessions_token_uq").on(t.tokenHash),
    index("auth_sessions_address_idx").on(t.address),
    check(
      "auth_sessions_fmt",
      sql`${t.tokenHash} ~ ${sql.raw(`'${HASH}'`)} AND ${t.address} ~ ${sql.raw(`'${ADDRESS}'`)} AND ${t.expiresAt} > ${t.createdAt}`,
    ),
  ],
);

// ---------------------------------------------------------------- marketplace (DRAFT)
// Off-chain marketplace data written by signed-in wallets. Performance is never stored here: market-maker scores are
// computed from indexed chain data.

/** A market maker's public listing. One per wallet; only that wallet (signed in) may edit it. */
export const mmProfiles = pgTable(
  "mm_profiles",
  {
    address: text("address")
      .primaryKey()
      .references(() => accounts.address),
    displayName: text("display_name").notNull(),
    bio: text("bio").notNull().default(""),
    website: text("website"),
    /** How issuers reach the market maker (e.g. a Telegram handle or email); shown publicly. */
    contact: text("contact"),
    /** Free-form tags for what the market maker covers ("Base launches", "USDC pairs"). */
    coverage: text("coverage").array().notNull().default(sql`'{}'::text[]`),
    /** Smallest deal the market maker takes, in USD (whole dollars); null = no minimum. */
    minDealUsd: integer("min_deal_usd"),
    /** Unlisted profiles stay reachable by address but are left out of the marketplace list. */
    listed: boolean("listed").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("mm_profiles_listed_idx").on(t.listed),
    check(
      "mm_profiles_fmt",
      sql`${t.address} ~ ${sql.raw(`'${ADDRESS}'`)} AND char_length(${t.displayName}) BETWEEN 1 AND 64
        AND char_length(${t.bio}) <= 1000 AND (${t.minDealUsd} IS NULL OR ${t.minDealUsd} >= 0)
        AND cardinality(${t.coverage}) <= 10`,
    ),
  ],
);

/**
 * Lifecycle: draft → sent → accepted → executed, with declined (by the MM), withdrawn (by an issuer owner) and
 * expired (past `expires_at` before execution) as ends.
 */
export const proposalStatus = pgEnum("proposal_status", ["draft", "sent", "accepted", "declined", "withdrawn", "expired", "executed"]);

/**
 * Terms an issuer Safe offers a market maker. `terms` is the SDK's MandateTermsJson; `terms_hash` is the EIP-712
 * digest the market maker signs (it covers the id, Safe, terms and expiry), so terms cannot change after sending.
 */
export const proposals = pgTable(
  "proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chainId: integer("chain_id").notNull(),
    safe: text("safe").notNull(),
    /** The Safe owner who created it (any current owner may manage it). */
    issuer: text("issuer")
      .notNull()
      .references(() => accounts.address),
    mm: text("mm").notNull(),
    base: text("base").notNull(),
    quote: text("quote").notNull(),
    terms: jsonb("terms").notNull(),
    termsHash: text("terms_hash").notNull(),
    status: proposalStatus("status").notNull().default("draft"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    mmSignature: text("mm_signature"),
    /** Set when the Safe executed createMandate for these terms (verified onchain). */
    mandateId: text("mandate_id"),
    note: text("note").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [
    index("proposals_safe_idx").on(t.chainId, t.safe),
    index("proposals_mm_idx").on(t.chainId, t.mm),
    // A mandate is the outcome of at most one proposal.
    uniqueIndex("proposals_mandate_uq").on(t.chainId, t.mandateId),
    check(
      "proposals_fmt",
      sql`${t.safe} ~ ${sql.raw(`'${ADDRESS}'`)} AND ${t.issuer} ~ ${sql.raw(`'${ADDRESS}'`)}
        AND ${t.mm} ~ ${sql.raw(`'${ADDRESS}'`)} AND ${t.base} ~ ${sql.raw(`'${ADDRESS}'`)}
        AND ${t.quote} ~ ${sql.raw(`'${ADDRESS}'`)} AND ${t.termsHash} ~ ${sql.raw(`'${HASH}'`)}
        AND (${t.mandateId} IS NULL OR ${t.mandateId} ~ ${sql.raw(`'${HASH}'`)}) AND char_length(${t.note}) <= 1000`,
    ),
    // Each lifecycle state carries exactly the evidence it needs.
    check(
      "proposals_state",
      sql`(${t.status} <> 'accepted' OR ${t.mmSignature} IS NOT NULL)
        AND (${t.status} <> 'executed' OR (${t.mmSignature} IS NOT NULL AND ${t.mandateId} IS NOT NULL))`,
    ),
  ],
);

// ---------------------------------------------------------------- market-maker scoring (DRAFT)

/**
 * Probe outcome, from the market maker's point of view:
 * - `ok`: the probe trade would fill inside every rail.
 * - `mm_fault`: refused for a reason the market maker controls (strategy priced outside the anchor band, or the
 *   market maker paused it).
 * - `neutral`: refused by an issuer rail (floor, daily cap, release), by the anchor itself (history, manipulation
 *   breaker) or by an RPC error; excluded from availability.
 */
export const probeOutcome = pgEnum("probe_outcome", ["ok", "mm_fault", "neutral"]);

/**
 * Periodic read-only quotes against each live mandate (one small buy and one small sell at the indexed head).
 * Evidence for the availability and responsiveness score components; references `blocks`, so reorgs remove them.
 */
export const mmProbes = pgTable(
  "mm_probes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chainId: integer("chain_id").notNull(),
    mandateId: text("mandate_id").notNull(),
    mm: text("mm").notNull(),
    blockNumber: blockNumber("block_number").notNull(),
    /** Chain time of `block_number`, seconds. */
    timestamp: bigint("timestamp", { mode: "bigint" }).notNull(),
    /** `sell`: the treasury sells base (taker buys); `buy`: the treasury buys back base. */
    side: text("side").notNull(),
    outcome: probeOutcome("outcome").notNull(),
    errorName: text("error_name"),
  },
  (t) => [
    foreignKey({ columns: [t.chainId, t.blockNumber], foreignColumns: [blocks.chainId, blocks.number] }).onDelete(
      "cascade",
    ),
    uniqueIndex("mm_probes_uq").on(t.chainId, t.mandateId, t.blockNumber, t.side),
    index("mm_probes_mm_idx").on(t.chainId, t.mm, t.timestamp),
    check("mm_probes_fmt", sql`${t.side} IN ('sell', 'buy') AND ${t.mm} ~ ${sql.raw(`'${ADDRESS}'`)}`),
  ],
);
