import { concat, pad, toHex, zeroAddress, type Address, type Hex } from "viem";

/**
 * Pure Safe v1.4.1 transaction helpers shared by the React hooks and their integration test.
 * Issuer actions are plain CALLs from the Safe with no gas refund, so every gas/refund field is zero.
 */

export const SAFE_CALL = 0;

/** Arguments of `getTransactionHash` / `execTransaction` (minus signatures) for a no-refund CALL. */
export function safeTxArgs(to: Address, data: Hex, nonce: bigint) {
  return [to, 0n, data, SAFE_CALL, 0n, 0n, 0n, zeroAddress, zeroAddress, nonce] as const;
}

/** Same, for `execTransaction`, where the last argument is the signature blob instead of the nonce. */
export function execTxArgs(to: Address, data: Hex, signatures: Hex) {
  return [to, 0n, data, SAFE_CALL, 0n, 0n, 0n, zeroAddress, zeroAddress, signatures] as const;
}

/**
 * Signature blob for owners who approved onchain (`approveHash`) or who send the transaction themselves.
 * Each entry is `r = owner, s = 0, v = 1`; Safe requires entries sorted by owner address ascending.
 */
export function approvalSignatures(signers: readonly Address[]): Hex {
  const sorted = [...new Set(signers.map((s) => s.toLowerCase() as Address))].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  return concat(sorted.map((owner) => concat([pad(owner, { size: 32 }), pad("0x0", { size: 32 }), toHex(1, { size: 1 })])));
}
