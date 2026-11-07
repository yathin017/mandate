import { concat, pad, toHex, zeroAddress, type Address, type Hex } from "viem";

/**
 * Pure Safe v1.4.1 transaction helpers shared by the React hooks and their integration test.
 * Issuer actions are CALLs from the Safe with no gas refund, so every gas/refund field is zero. The one exception is
 * a batch: a DELEGATECALL to the chain's canonical MultiSendCallOnly, which `safeOperation` allows and nothing else.
 */

export const SAFE_CALL = 0;
export const SAFE_DELEGATECALL = 1;

/**
 * Checks a call's Safe operation. DELEGATECALL runs the target's code as the Safe itself, so it is permitted only
 * for the verified MultiSendCallOnly (which can itself only CALL); anything else throws.
 */
export function safeOperation(to: Address, operation: number, multiSendCallOnly: Address): 0 | 1 {
  if (operation === SAFE_CALL) return SAFE_CALL;
  if (operation === SAFE_DELEGATECALL && to.toLowerCase() === multiSendCallOnly.toLowerCase()) return SAFE_DELEGATECALL;
  throw new Error(`Refusing Safe operation ${operation} to ${to}: only CALLs and MultiSendCallOnly batches are allowed`);
}

/** Arguments of `getTransactionHash` / `execTransaction` (minus signatures) for a no-refund transaction. */
export function safeTxArgs(to: Address, data: Hex, nonce: bigint, operation: 0 | 1 = SAFE_CALL) {
  return [to, 0n, data, operation, 0n, 0n, 0n, zeroAddress, zeroAddress, nonce] as const;
}

/** Same, for `execTransaction`, where the last argument is the signature blob instead of the nonce. */
export function execTxArgs(to: Address, data: Hex, signatures: Hex, operation: 0 | 1 = SAFE_CALL) {
  return [to, 0n, data, operation, 0n, 0n, 0n, zeroAddress, zeroAddress, signatures] as const;
}

/**
 * Signature blob for owners who approved onchain (`approveHash`) or who send the transaction themselves.
 * Each entry is `r = owner, s = 0, v = 1`; Safe requires entries sorted by owner address ascending.
 */
export function approvalSignatures(signers: readonly Address[]): Hex {
  const sorted = [...new Set(signers.map((s) => s.toLowerCase() as Address))].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  return concat(sorted.map((owner) => concat([pad(owner, { size: 32 }), pad("0x0", { size: 32 }), toHex(1, { size: 1 })])));
}
