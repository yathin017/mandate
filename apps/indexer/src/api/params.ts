import { z } from "zod";

/** Request parameter schemas. Everything from the network is validated before it reaches a query. */
export const hash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected a 32-byte 0x-hex value")
  .transform((value) => value.toLowerCase());

export const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte 0x-hex address")
  .transform((value) => value.toLowerCase());

export const chainParam = z.object({ chainId: z.coerce.number().int().positive() });
export const mandateParam = chainParam.extend({ mandateId: hash });

export const listQuery = z.object({ safe: address.optional(), mm: address.optional() });

/** Opaque keyset cursor: `${blockNumber}.${ord}.${key}`, base64url-encoded. */
export const activityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().max(200).optional(),
});

export const seriesQuery = z.object({
  fromBlock: z.coerce.bigint().optional(),
  toBlock: z.coerce.bigint().optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});

export interface ActivityCursor {
  readonly blockNumber: bigint;
  readonly ord: number;
  readonly key: string;
}

export function encodeCursor(cursor: ActivityCursor): string {
  return Buffer.from(`${cursor.blockNumber}.${cursor.ord}.${cursor.key}`).toString("base64url");
}

export function decodeCursor(value: string): ActivityCursor | null {
  const match = /^(\d{1,20})\.(\d{1,10})\.([0-9a-f:x-]{1,140})$/.exec(Buffer.from(value, "base64url").toString());
  if (!match) return null;
  return { blockNumber: BigInt(match[1]!), ord: Number(match[2]), key: match[3]! };
}
