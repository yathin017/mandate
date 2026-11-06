import { safeAbi, type PreparedCall } from "@mandate/sdk";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { encodeFunctionData, type Address, type Hash } from "viem";
import { useConnection, useReadContract, useReadContracts } from "wagmi";

import { demoChain } from "./config";
import { approvalSignatures, execTxArgs, safeTxArgs } from "./safeTx";
import { useTx, type TxRequest } from "./useTx";

/** Owners, threshold and nonce of a Safe, read from the Safe itself. */
export function useSafeInfo(safe: Address | undefined) {
  const result = useReadContracts({
    allowFailure: false,
    contracts: safe
      ? [
          { address: safe, abi: safeAbi, functionName: "getOwners", chainId: demoChain.id },
          { address: safe, abi: safeAbi, functionName: "getThreshold", chainId: demoChain.id },
          { address: safe, abi: safeAbi, functionName: "nonce", chainId: demoChain.id },
        ]
      : [],
    query: { enabled: Boolean(safe) },
  });
  const data = result.data as unknown as [readonly Address[], bigint, bigint] | undefined;
  const [owners, threshold, nonce] = data ?? [undefined, undefined, undefined];
  return { owners, threshold, nonce, isLoading: result.isLoading, error: result.error };
}

/**
 * One issuer action executed by the Safe with onchain owner approvals:
 * owners call `approveHash(safeTxHash)`; once the threshold is met, any owner executes with v = 1 signatures.
 * Nothing is stored off-chain; approvals are read back from the Safe.
 */
export function useSafeAction(safe: Address | undefined, call: PreparedCall | undefined, context?: TxRequest["context"]) {
  const { address } = useConnection();
  const info = useSafeInfo(safe);
  const tx = useTx();
  const queryClient = useQueryClient();
  /** Set once this action executed: the panel locks so the same call is not proposed again at the next nonce. */
  const [executed, setExecuted] = useState<{ blockNumber: bigint } | null>(null);

  const hashQuery = useReadContract({
    address: safe,
    abi: safeAbi,
    functionName: "getTransactionHash",
    args: call && info.nonce !== undefined ? safeTxArgs(call.to, call.data, info.nonce) : undefined,
    chainId: demoChain.id,
    query: { enabled: Boolean(safe && call && info.nonce !== undefined) },
  });
  const safeTxHash = hashQuery.data as Hash | undefined;

  const approvalsQuery = useReadContracts({
    allowFailure: false,
    contracts: safe && safeTxHash && info.owners
      ? info.owners.map((owner) => ({
          address: safe,
          abi: safeAbi,
          functionName: "approvedHashes" as const,
          args: [owner, safeTxHash] as const,
          chainId: demoChain.id,
        }))
      : [],
    query: { enabled: Boolean(safe && safeTxHash && info.owners) },
  });
  const approvals = new Map<string, boolean>(
    (info.owners ?? []).map((owner, i) => [owner.toLowerCase(), ((approvalsQuery.data?.[i] as bigint | undefined) ?? 0n) > 0n]),
  );

  const me = address?.toLowerCase();
  const isOwner = Boolean(me && approvals.has(me));
  const approvedCount = [...approvals.values()].filter(Boolean).length;
  const threshold = Number(info.threshold ?? 0n);
  // The executor's own signature counts without a prior approveHash (msg.sender == owner).
  const canExecute = isOwner && approvedCount + (approvals.get(me!) ? 0 : 1) >= threshold && threshold > 0;

  /** The module call exactly as the Safe will make it: refusals surface before anyone approves. */
  const moduleCheck = safe && call ? [{ from: safe, to: call.to, data: call.data }] : [];

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["readContracts"] });
    await hashQuery.refetch();
    await approvalsQuery.refetch();
  }

  async function approve() {
    if (!safe || !safeTxHash) return;
    await tx.run({
      checks: moduleCheck,
      send: { to: safe, data: encodeFunctionData({ abi: safeAbi, functionName: "approveHash", args: [safeTxHash] }) },
      ...(context ? { context } : {}),
    });
    await refresh();
  }

  async function execute() {
    if (!safe || !call || !info.owners || !me) return;
    const signers = info.owners.filter((owner) => approvals.get(owner.toLowerCase()) || owner.toLowerCase() === me);
    const outcome = await tx.run({
      checks: moduleCheck,
      send: {
        to: safe,
        data: encodeFunctionData({
          abi: safeAbi,
          functionName: "execTransaction",
          args: execTxArgs(call.to, call.data, approvalSignatures(signers)),
        }),
      },
      ...(context ? { context } : {}),
    });
    if (outcome.ok && outcome.blockNumber !== undefined) setExecuted({ blockNumber: outcome.blockNumber });
    await refresh();
    return outcome.ok;
  }

  return {
    executed,
    info,
    safeTxHash,
    approvals,
    approvedCount,
    threshold,
    isOwner,
    hasApproved: Boolean(me && approvals.get(me)),
    canExecute,
    approve,
    execute,
    tx,
  };
}
