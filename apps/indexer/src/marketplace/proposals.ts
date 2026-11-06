import { randomUUID } from "node:crypto";

import { zValidator } from "@hono/zod-validator";
import {
  explainError,
  hashStrategyTerms,
  mandateModuleAbi,
  strategyTermsTypedData,
  termsFromJson,
  termsToJson,
  type StrategyTerms,
  type StrategyTermsJson,
} from "@mandate/sdk";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { getAddress, type Address, type Hex } from "viem";
import { z } from "zod";

import { rateLimit } from "../api/rateLimit.ts";
import { requireAllowedOrigin, requireSession, type AuthEnv } from "../auth/routes.ts";
import type { Cache } from "../cache/cache.ts";
import type { ChainContext } from "../chain.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { proposals } from "../db/schema.ts";
import { safeOwners } from "./safes.ts";

/**
 * Proposals: how an issuer Safe and a market maker agree on a strategy before anything is signed onchain. The
 * strategy runs under the Safe's treasury policy for the pair, which the issuer sets on its own.
 *
 *   POST /v1/proposals                    an owner of the Safe drafts terms (optionally sending them at once)
 *   GET  /v1/proposals?safe=0x…           the Safe's proposals (caller must own the Safe)
 *   GET  /v1/proposals?as=mm              proposals addressed to the caller (drafts excluded)
 *   GET  /v1/proposals/:id                one proposal, for an owner of its Safe or its market maker
 *   POST /v1/proposals/:id/send           draft → sent        (owner; terms must pass addStrategy's simulation)
 *   POST /v1/proposals/:id/withdraw       draft|sent|accepted → withdrawn (owner)
 *   POST /v1/proposals/:id/accept         sent → accepted     (market maker; EIP-712 signature over the terms)
 *   POST /v1/proposals/:id/decline        sent → declined     (market maker)
 *   POST /v1/proposals/:id/executed       accepted → executed (owner; the strategy is checked onchain)
 *
 * Authority always comes from the chain: Safe ownership is read from the Safe, the acceptance signature is verified
 * through the RPC (EOAs and ERC-1271/6492 wallets), and "executed" is accepted only if the module's strategy matches
 * the accepted terms. Every transition is a single conditional UPDATE, so concurrent requests cannot skip a state.
 * Proposals past `expires_at` become `expired` when read.
 */
type Row = typeof proposals.$inferSelect;
type Status = Row["status"];

const MIN_TTL_S = 3600;
const MAX_TTL_S = 30 * 86_400;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^\d{1,78}$/;

const termsJson = z.object({
  marketMaker: z.string().regex(HEX_ADDRESS),
  base: z.string().regex(HEX_ADDRESS),
  quote: z.string().regex(HEX_ADDRESS),
  kind: z.string().regex(UINT),
  bounds: z.object({
    spreadBpsMin: z.string().regex(UINT), spreadBpsMax: z.string().regex(UINT),
    maxShippedBase: z.string().regex(UINT), maxShippedQuote: z.string().regex(UINT),
    mmFeeShareBps: z.string().regex(UINT), maxBuyPriceX36: z.string().regex(UINT),
  }),
  params: z.object({ spreadBps: z.string().regex(UINT), shippedBase: z.string().regex(UINT), shippedQuote: z.string().regex(UINT) }),
});

const createBody = z.object({
  chainId: z.number().int().positive(),
  safe: z.string().regex(HEX_ADDRESS),
  terms: termsJson,
  /** Unix seconds; between one hour and 30 days from now. */
  expiresAt: z.number().int().positive(),
  note: z
    .string()
    .transform((v) => v.replace(/[^\P{Cc}\n]|\p{Cf}/gu, "").trim())
    .pipe(z.string().max(1000))
    .default(""),
  send: z.boolean().default(false),
});
const acceptBody = z.object({ signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(12_000) });
const executedBody = z.object({ strategyId: z.string().regex(/^0x[0-9a-fA-F]{64}$/) });
const listQuery = z.union([z.object({ safe: z.string().regex(HEX_ADDRESS) }), z.object({ as: z.literal("mm") })]);

export interface ProposalDeps {
  readonly db: Db;
  readonly cache: Cache;
  readonly config: Config;
  readonly chain?: () => Promise<ChainContext>;
  readonly clientIp: (c: Context) => string;
  readonly log: (message: string) => void;
}

/** Public shape: everything the parties need, with the terms in their JSON form. */
function present(row: Row) {
  return {
    id: row.id,
    chainId: row.chainId,
    safe: row.safe,
    issuer: row.issuer,
    mm: row.mm,
    base: row.base,
    quote: row.quote,
    kind: row.kind,
    terms: row.terms as StrategyTermsJson,
    termsHash: row.termsHash,
    status: row.status,
    expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
    mmSignature: row.mmSignature,
    strategyId: row.strategyId,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

export function createProposalRoutes(deps: ProposalDeps) {
  const { db, cache, config, log } = deps;
  const app = new Hono<AuthEnv>();
  const invalid = (result: { success: boolean; error?: { issues: readonly { message: string }[] } }, c: Context) => {
    if (!result.success) return c.json({ error: "invalid request", issues: result.error?.issues.map((i) => i.message) }, 400);
  };
  const signedIn = requireSession(deps);
  // Writes cost RPC calls (owner checks, simulations, signature checks).
  const writes = [
    requireAllowedOrigin(config),
    rateLimit({ cache, scope: "proposals", perMinute: 30, clientIp: deps.clientIp }),
    signedIn,
  ] as const;

  async function chainOrNull(): Promise<ChainContext | null> {
    if (!deps.chain) return null;
    try {
      return await deps.chain();
    } catch (error) {
      log(`chain unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** Marks rows past their expiry as expired (they can no longer be accepted or executed). */
  async function expireStale(where: ReturnType<typeof and>) {
    await db
      .update(proposals)
      .set({ status: "expired", updatedAt: sql`now()` })
      .where(and(where, inArray(proposals.status, ["draft", "sent", "accepted"]), lt(proposals.expiresAt, sql`now()`)));
  }

  async function load(id: string): Promise<Row | undefined> {
    if (!z.uuid().safeParse(id).success) return undefined;
    await expireStale(eq(proposals.id, id));
    const [row] = await db.select().from(proposals).where(eq(proposals.id, id)).limit(1);
    return row;
  }

  async function isOwner(chain: ChainContext, safe: string, address: string): Promise<boolean> {
    const owners = await safeOwners(chain, cache, getAddress(safe));
    return Boolean(owners?.includes(address.toLowerCase()));
  }

  /**
   * Runs addStrategy as the Safe would (eth_call from the Safe) under its live policy for the pair, so module refusals
   * (no policy yet, invalid bounds or params, inventory the Safe cannot back) surface before the market maker is
   * asked to sign. Returns a plain-language reason or null.
   */
  async function simulateAdd(chain: ChainContext, safe: string, terms: StrategyTerms): Promise<string | null> {
    const policyId = await chain.client.readContract({
      address: chain.deployment.module,
      abi: mandateModuleAbi,
      functionName: "activePolicyOf",
      args: [getAddress(safe), terms.base],
    });
    if (/^0x0{64}$/.test(policyId)) return "This Safe has no live treasury policy for this token yet. Create the policy first.";
    const policy = await chain.client.readContract({
      address: chain.deployment.module,
      abi: mandateModuleAbi,
      functionName: "getPolicy",
      args: [policyId],
    });
    if (policy.quote.toLowerCase() !== terms.quote.toLowerCase()) return "The Safe's policy for this token uses a different quote token.";
    try {
      await chain.client.simulateContract({
        address: chain.deployment.module,
        abi: mandateModuleAbi,
        functionName: "addStrategy",
        args: [policyId, terms.marketMaker, terms.kind, terms.bounds, terms.params],
        account: getAddress(safe),
      });
      return null;
    } catch (error) {
      return explainError(error).message;
    }
  }

  /** Applies a transition only from the allowed states; null when the proposal moved on in the meantime. */
  async function transition(id: string, from: readonly Status[], set: Partial<typeof proposals.$inferInsert>) {
    const [row] = await db
      .update(proposals)
      .set({ ...set, updatedAt: sql`now()` })
      .where(and(eq(proposals.id, id), inArray(proposals.status, [...from]), sql`${proposals.expiresAt} > now()`))
      .returning();
    return row;
  }

  const conflict = (c: Context, row: Row) => c.json({ error: `proposal is ${row.status}` }, 409);

  app.post("/", ...writes, zValidator("json", createBody, invalid), async (c) => {
    const body = c.req.valid("json");
    const me = c.var.session.address.toLowerCase();
    if (body.chainId !== config.INDEXER_CHAIN_ID) return c.json({ error: "chain not served here" }, 404);
    let terms: StrategyTerms;
    try {
      terms = termsFromJson(body.terms);
    } catch (error) {
      return c.json({ error: "invalid terms", issues: [error instanceof Error ? error.message : String(error)] }, 400);
    }
    const now = Math.floor(Date.now() / 1000);
    if (body.expiresAt < now + MIN_TTL_S || body.expiresAt > now + MAX_TTL_S) return c.json({ error: "expiry must be 1 hour to 30 days away" }, 400);
    const safe = getAddress(body.safe);
    if (terms.marketMaker === safe) return c.json({ error: "the market maker cannot be the Safe" }, 400);

    const chain = await chainOrNull();
    if (!chain) return c.json({ error: "chain RPC unavailable" }, 503);
    if (!(await isOwner(chain, safe, me))) return c.json({ error: "only an owner of this Safe can propose" }, 403);
    if (body.send) {
      const reason = await simulateAdd(chain, safe, terms);
      if (reason) return c.json({ error: "the module would refuse these terms", reason }, 422);
    }

    const id = randomUUID();
    const termsHash = hashStrategyTerms(chain.deployment, { proposalId: id, safe, terms, expiresAt: BigInt(body.expiresAt) });
    const [row] = await db
      .insert(proposals)
      .values({
        id,
        chainId: body.chainId,
        safe: safe.toLowerCase(),
        issuer: me,
        mm: terms.marketMaker.toLowerCase(),
        base: terms.base.toLowerCase(),
        quote: terms.quote.toLowerCase(),
        kind: terms.kind,
        terms: termsToJson(terms),
        termsHash,
        status: body.send ? "sent" : "draft",
        expiresAt: new Date(body.expiresAt * 1000),
        note: body.note,
        ...(body.send ? { sentAt: new Date() } : {}),
      })
      .returning();
    return c.json({ data: present(row!) }, 201);
  });

  app.get("/", signedIn, zValidator("query", listQuery, invalid), async (c) => {
    const query = c.req.valid("query");
    const me = c.var.session.address.toLowerCase();
    const chainId = config.INDEXER_CHAIN_ID;
    let where;
    if ("safe" in query) {
      const chain = await chainOrNull();
      if (!chain) return c.json({ error: "chain RPC unavailable" }, 503);
      if (!(await isOwner(chain, query.safe, me))) return c.json({ error: "only an owner of this Safe can list its proposals" }, 403);
      where = and(eq(proposals.chainId, chainId), eq(proposals.safe, query.safe.toLowerCase()));
    } else {
      // Market makers never see drafts.
      where = and(eq(proposals.chainId, chainId), eq(proposals.mm, me), sql`${proposals.status} <> 'draft'`);
    }
    await expireStale(where);
    const rows = await db.select().from(proposals).where(where).orderBy(desc(proposals.createdAt)).limit(200);
    return c.json({ data: rows.map(present) });
  });

  app.get("/:id", signedIn, async (c) => {
    const row = await load(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    const me = c.var.session.address.toLowerCase();
    if (row.mm === me && row.status !== "draft") return c.json({ data: present(row) });
    const chain = await chainOrNull();
    if (!chain) return c.json({ error: "chain RPC unavailable" }, 503);
    // Not found rather than forbidden: proposal ids are not discoverable by outsiders.
    if (!(await isOwner(chain, row.safe, me))) return c.json({ error: "not found" }, 404);
    return c.json({ data: present(row) });
  });

  /** Loads the proposal and checks the caller owns its Safe; returns a response on failure. */
  async function asOwner(c: Context<AuthEnv>): Promise<{ row: Row; chain: ChainContext } | Response> {
    const row = await load(c.req.param("id")!);
    if (!row) return c.json({ error: "not found" }, 404);
    const chain = await chainOrNull();
    if (!chain) return c.json({ error: "chain RPC unavailable" }, 503);
    if (!(await isOwner(chain, row.safe, c.var.session.address))) return c.json({ error: "not found" }, 404);
    return { row, chain };
  }

  /** Loads the proposal and checks the caller is its market maker. */
  async function asMarketMaker(c: Context<AuthEnv>): Promise<Row | Response> {
    const row = await load(c.req.param("id")!);
    if (!row || row.status === "draft" || row.mm !== c.var.session.address.toLowerCase()) return c.json({ error: "not found" }, 404);
    return row;
  }

  app.post("/:id/send", ...writes, async (c) => {
    const found = await asOwner(c);
    if (found instanceof Response) return found;
    const { row, chain } = found;
    if (row.status !== "draft") return conflict(c, row);
    const reason = await simulateAdd(chain, row.safe, termsFromJson(row.terms as StrategyTermsJson));
    if (reason) return c.json({ error: "the module would refuse these terms", reason }, 422);
    const updated = await transition(row.id, ["draft"], { status: "sent", sentAt: new Date() });
    return updated ? c.json({ data: present(updated) }) : conflict(c, (await load(row.id))!);
  });

  app.post("/:id/withdraw", ...writes, async (c) => {
    const found = await asOwner(c);
    if (found instanceof Response) return found;
    const updated = await transition(found.row.id, ["draft", "sent", "accepted"], { status: "withdrawn", decidedAt: new Date() });
    return updated ? c.json({ data: present(updated) }) : conflict(c, (await load(found.row.id))!);
  });

  app.post("/:id/decline", ...writes, async (c) => {
    const row = await asMarketMaker(c);
    if (row instanceof Response) return row;
    const updated = await transition(row.id, ["sent"], { status: "declined", decidedAt: new Date() });
    return updated ? c.json({ data: present(updated) }) : conflict(c, (await load(row.id))!);
  });

  app.post("/:id/accept", ...writes, zValidator("json", acceptBody, invalid), async (c) => {
    const row = await asMarketMaker(c);
    if (row instanceof Response) return row;
    if (row.status !== "sent") return conflict(c, row);
    const chain = await chainOrNull();
    if (!chain) return c.json({ error: "chain RPC unavailable" }, 503);
    const terms = termsFromJson(row.terms as StrategyTermsJson);
    const typed = strategyTermsTypedData(chain.deployment, {
      proposalId: row.id,
      safe: getAddress(row.safe),
      terms,
      expiresAt: BigInt(Math.floor(row.expiresAt.getTime() / 1000)),
    });
    const { signature } = c.req.valid("json");
    let valid: boolean;
    try {
      valid = await chain.client.verifyTypedData({ ...typed, address: terms.marketMaker, signature: signature as Hex });
    } catch (error) {
      log(`acceptance verification failed: ${error instanceof Error ? error.message : String(error)}`);
      return c.json({ error: "chain RPC unavailable" }, 503);
    }
    if (!valid) return c.json({ error: "the signature does not match these terms and this market maker" }, 401);
    const updated = await transition(row.id, ["sent"], { status: "accepted", mmSignature: signature, decidedAt: new Date() });
    return updated ? c.json({ data: present(updated) }) : conflict(c, (await load(row.id))!);
  });

  app.post("/:id/executed", ...writes, zValidator("json", executedBody, invalid), async (c) => {
    const found = await asOwner(c);
    if (found instanceof Response) return found;
    const { row, chain } = found;
    if (row.status !== "accepted") return conflict(c, row);
    const strategyId = c.req.valid("json").strategyId.toLowerCase() as Hex;
    const mismatch = await verifyStrategy(chain, strategyId, row);
    if (mismatch) return c.json({ error: "the strategy does not match the accepted terms", reason: mismatch }, 422);
    try {
      const updated = await transition(row.id, ["accepted"], { status: "executed", strategyId });
      return updated ? c.json({ data: present(updated) }) : conflict(c, (await load(row.id))!);
    } catch (error) {
      // proposals_strategy_uq: another proposal already claimed this strategy.
      if (String((error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code) === "23505")
        return c.json({ error: "this strategy is already linked to another proposal" }, 409);
      throw error;
    }
  });

  return app;
}

/** Compares the module's record of a strategy (and its policy) with the accepted terms; first difference or null. */
async function verifyStrategy(chain: ChainContext, strategyId: Hex, row: Row): Promise<string | null> {
  let strategy;
  let policy;
  try {
    strategy = await chain.client.readContract({ address: chain.deployment.module, abi: mandateModuleAbi, functionName: "getStrategy", args: [strategyId] });
    // Unknown ids read back as an empty record (status None) rather than reverting.
    if (Number(strategy.status) === 0) return "no such strategy";
    policy = await chain.client.readContract({ address: chain.deployment.module, abi: mandateModuleAbi, functionName: "getPolicy", args: [strategy.policyId] });
  } catch {
    return "the strategy could not be read";
  }
  const accepted = row.terms as StrategyTermsJson;
  const onchain = termsToJson({
    marketMaker: strategy.mm as Address,
    base: policy.base as Address,
    quote: policy.quote as Address,
    kind: Number(strategy.kind),
    bounds: strategy.bounds,
    // Params may already have been reshipped by the market maker; only the issuer's rails must match.
    params: termsFromJson(accepted).params,
  });
  if (policy.safe.toLowerCase() !== row.safe) return "added by another Safe";
  if (onchain.marketMaker !== accepted.marketMaker) return "different market maker";
  if (onchain.base !== accepted.base || onchain.quote !== accepted.quote) return "different token pair";
  if (onchain.kind !== accepted.kind) return "different strategy kind";
  for (const [key, value] of Object.entries(accepted.bounds)) {
    if (onchain.bounds[key as keyof typeof onchain.bounds] !== value) return `different ${key}`;
  }
  return null;
}
