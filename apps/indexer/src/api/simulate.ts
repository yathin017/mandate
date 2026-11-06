import { and, eq } from "drizzle-orm";
import { encodeAbiParameters, keccak256, type Address, type Hash } from "viem";
import { z } from "zod";

import type { Cache } from "../cache/cache.ts";
import type { ChainContext } from "../chain.ts";
import type { Db } from "../db/client.ts";
import { attempts, blocks } from "../db/schema.ts";
import { toJsonSafe } from "../json.ts";
import { address } from "./params.ts";
import * as q from "./queries.ts";

const MAX_UINT256 = 2n ** 256n - 1n;

/** Trade parameters only. The outcome is always computed by the server. */
export const attemptBody = z.strictObject({
  taker: address,
  tokenIn: address,
  tokenOut: address,
  amount: z
    .string()
    .regex(/^[1-9]\d{0,77}$/, "amount must be a positive integer in raw token units")
    .transform((value) => BigInt(value))
    .refine((value) => value <= MAX_UINT256, "amount exceeds uint256"),
  isExactIn: z.boolean(),
});
export type AttemptBody = z.infer<typeof attemptBody>;

export type SimulationResult =
  | { status: "ok"; body: unknown }
  | { status: "not-found"; message: string }
  | { status: "stale-head"; message: string };

/**
 * Re-runs the quote via eth_call at the indexed head block and records the outcome as a `simulated` attempt.
 * Pinning to the indexed head keeps the row consistent with the rest of the database (its block row exists and
 * the snapshot the UI shows was taken at the same block).
 */
export async function simulateAttempt(
  deps: { db: Db; cache: Cache; chain: ChainContext },
  strategyId: string,
  body: AttemptBody,
): Promise<SimulationResult> {
  const { db, cache, chain } = deps;
  const cursor = await q.getCursor(db, chain.chainId);
  const strategy = await q.getStrategy(db, chain.chainId, strategyId);
  if (!cursor || !strategy) return { status: "not-found", message: "strategy not indexed" };

  const requestHash = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bool" }],
      [body.taker as Address, body.tokenIn as Address, body.tokenOut as Address, body.amount, body.isExactIn],
    ),
  );
  // Dedupe on the table's unique key: one simulation per request per block, so repeats cost no RPC calls.
  const [existing] = await db
    .select()
    .from(attempts)
    .where(
      and(
        eq(attempts.chainId, chain.chainId),
        eq(attempts.strategyId, strategyId),
        eq(attempts.source, "simulated"),
        eq(attempts.requestHash, requestHash),
        eq(attempts.blockNumber, cursor.blockNumber),
      ),
    );
  if (existing) return { status: "ok", body: responseOf(existing) };

  const [base, quote] = await Promise.all([
    chain.tokenDisplay(strategy.base as Address),
    chain.tokenDisplay(strategy.quote as Address),
  ]);
  const policy = await q.latestPolicySnapshot(db, chain.chainId, strategy.policyId);
  const [block] = await db
    .select({ timestamp: blocks.timestamp })
    .from(blocks)
    .where(and(eq(blocks.chainId, chain.chainId), eq(blocks.number, cursor.blockNumber)));

  const result = await chain.sdk.quote(strategyId as Hash, {
    taker: body.taker as Address,
    tokenIn: body.tokenIn as Address,
    tokenOut: body.tokenOut as Address,
    amount: body.amount,
    isExactIn: body.isExactIn,
    blockNumber: cursor.blockNumber,
    context: {
      base,
      quote,
      ...(block ? { now: block.timestamp } : {}),
      ...(policy ? { periodEndsAt: BigInt(policy.periodEndsAt) } : {}),
    },
  });
  if (result.source.blockHash.toLowerCase() !== cursor.blockHash) {
    return { status: "stale-head", message: "the indexed head was reorged; retry" };
  }

  const row = {
    chainId: chain.chainId,
    strategyId,
    source: "simulated" as const,
    outcome: result.ok ? ("allowed" as const) : ("blocked" as const),
    errorName: result.ok ? null : result.error.errorName,
    errorArgs: result.ok ? null : toJsonSafe(result.error.args),
    revertData: result.ok ? null : (result.error.data?.toLowerCase() ?? null),
    explanation: result.ok ? null : result.error.message,
    request: toJsonSafe(body),
    requestHash,
    amountIn: result.ok ? result.amountIn.toString() : null,
    amountOut: result.ok ? result.amountOut.toString() : null,
    blockNumber: cursor.blockNumber,
    blockHash: cursor.blockHash,
    timestamp: block?.timestamp ?? 0n,
  };
  await db.insert(attempts).values(row).onConflictDoNothing();

  // Both feeds list this attempt: the strategy's and its policy's.
  const subjects = [
    { kind: "strategy" as const, id: strategyId },
    { kind: "policy" as const, id: strategy.policyId },
  ];
  for (const subject of subjects) await cache.bumpVersion(chain.chainId, subject);
  for (const subject of subjects) await cache.publish({
    chainId: chain.chainId,
    subject,
    blockNumber: cursor.blockNumber.toString(),
    blockHash: cursor.blockHash,
    reorg: false,
  });
  return { status: "ok", body: responseOf(row) };
}

function responseOf(row: {
  outcome: string;
  errorName?: string | null;
  explanation?: string | null;
  amountIn?: string | null;
  amountOut?: string | null;
  blockNumber: bigint;
  blockHash: string;
  requestHash: string;
}) {
  return toJsonSafe({
    simulated: true,
    outcome: row.outcome,
    errorName: row.errorName ?? null,
    explanation: row.explanation ?? null,
    amountIn: row.amountIn ?? null,
    amountOut: row.amountOut ?? null,
    blockNumber: row.blockNumber,
    blockHash: row.blockHash,
    requestHash: row.requestHash,
  });
}
