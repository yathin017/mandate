import { safeAbi } from "@mandate/sdk";
import { BaseError, HttpRequestError, TimeoutError, type Address } from "viem";

import type { Cache } from "../cache/cache.ts";
import { keys, TTL } from "../cache/keys.ts";
import type { ChainContext } from "../chain.ts";

/**
 * Current owners of a Safe, lowercase, from the chain (cached briefly). Undefined when the address does not answer
 * like a Safe; RPC outages throw, so they are never mistaken for "not an owner".
 * Owner-gated marketplace actions use this, so access follows the Safe's real owner set, not who created a row.
 */
export async function safeOwners(chain: ChainContext, cache: Cache, safe: Address): Promise<readonly string[] | undefined> {
  const key = keys.safeOwners(chain.chainId, safe.toLowerCase());
  const hit = await cache.getJson<string[]>(key);
  if (hit) return hit;
  let owners: readonly Address[];
  try {
    owners = await chain.client.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" });
  } catch (error) {
    const transport = error instanceof BaseError && error.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError);
    if (transport) throw error;
    return undefined;
  }
  const lower = owners.map((o) => o.toLowerCase());
  await cache.setJson(key, lower, TTL.safeOwnersSeconds);
  return lower;
}
