import type { Address, PublicClient } from "viem";

/**
 * Whether `address` has contract code, retried for a few seconds: right after a deployment confirms, a load-balanced
 * public RPC can still answer from a node that has not seen that block, and an empty answer must not be final.
 */
export async function hasCode(client: Pick<PublicClient, "getCode">, address: Address, attempts = 10, delayMs = 1_500): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, delayMs));
    const code = await client.getCode({ address }).catch(() => undefined);
    if (code && code !== "0x") return true;
  }
  return false;
}
