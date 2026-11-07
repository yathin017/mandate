import { explainError, type ErrorContext, type ExplainedError } from "@mandate/sdk";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { Address, Hash, Hex } from "viem";
import { usePublicClient, useWalletClient } from "wagmi";

import { api } from "@/lib/api";

import { demoChain } from "./config";

/**
 * Waits (bounded) until the indexer has committed `block`, so refetched lists include this transaction.
 * Returns at once when the indexer is unreachable or indexes another chain: there is nothing to wait for.
 */
async function waitForIndexer(block: bigint, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await api.health().catch(() => undefined);
    if (!health?.ok || health.chainId !== demoChain.id) return;
    if (health.head && BigInt(health.head.number) >= block) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Every wallet action moves through these states (spec 10.2 rule 5). */
export type TxState =
  | { status: "idle" }
  | { status: "simulating" }
  /** Refused in simulation: nothing was sent. */
  | { status: "blocked"; error: ExplainedError }
  | { status: "signing" }
  | { status: "pending"; hash: Hash }
  | { status: "confirmed"; hash: Hash; blockNumber: bigint }
  /** Confirmed onchain; waiting for the indexer before refreshing what the page shows. */
  | { status: "indexing"; hash: Hash; blockNumber: bigint }
  /** simulateOnly run whose checks passed; nothing was sent. */
  | { status: "simulated" }
  | { status: "failed"; message: string; hash?: Hash };

export interface Call {
  /** Omitted for a contract deployment (data is then the creation code). */
  readonly to?: Address | undefined;
  readonly data: Hex;
}

/** What `run` resolved to; `blockNumber` is set only when a transaction was confirmed. */
export interface TxOutcome {
  readonly ok: boolean;
  readonly blockNumber?: bigint;
  /** Set when the transaction deployed a contract. */
  readonly contractAddress?: Address;
}

export interface TxRequest {
  /** The transaction the connected wallet sends. */
  readonly send: Call;
  /** eth_calls that must succeed first, e.g. the module call as the Safe would make it. Defaults to `send`. */
  readonly checks?: readonly (Call & { from: Address })[];
  readonly context?: ErrorContext;
  /** Run the checks only and never send, e.g. to demonstrate a refusal. */
  readonly simulateOnly?: boolean;
  /** Skip waiting for the indexer (for flows that read the chain directly, like onboarding). Default false. */
  readonly skipIndexerWait?: boolean;
}

/**
 * Simulate, sign, send and confirm one transaction. A refusal found in simulation is shown with its
 * plain-language reason and nothing is sent. After confirmation, cached reads are refetched.
 */
export function useTx() {
  const publicClient = usePublicClient({ chainId: demoChain.id });
  const { data: wallet } = useWalletClient({ chainId: demoChain.id });
  const queryClient = useQueryClient();
  const [state, setState] = useState<TxState>({ status: "idle" });

  const run = useCallback(
    async (request: TxRequest): Promise<TxOutcome> => {
      if (!wallet || !publicClient) {
        setState({ status: "failed", message: "Connect a wallet on the demo chain first." });
        return { ok: false };
      }
      const account = wallet.account.address;

      setState({ status: "simulating" });
      const checks = request.checks ?? [{ ...request.send, from: account }];
      for (const check of checks) {
        try {
          await publicClient.call({ account: check.from, data: check.data, ...(check.to ? { to: check.to } : {}) });
        } catch (error) {
          setState({ status: "blocked", error: explainError(error, request.context) });
          return { ok: false };
        }
      }

      if (request.simulateOnly) {
        setState({ status: "simulated" });
        return { ok: true };
      }

      setState({ status: "signing" });
      let hash: Hash;
      try {
        hash = await wallet.sendTransaction({
          account,
          chain: demoChain,
          data: request.send.data,
          ...(request.send.to ? { to: request.send.to } : {}),
        });
      } catch (error) {
        const rejected = error instanceof Error && /reject|denied/i.test(`${error.name} ${error.message}`);
        setState({ status: "failed", message: rejected ? "You rejected the request in your wallet." : explainError(error, request.context).message });
        return { ok: false };
      }

      setState({ status: "pending", hash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        setState({ status: "failed", hash, message: "The transaction reverted onchain. Refresh the state and try again." });
        return { ok: false };
      }
      setState({ status: "indexing", hash, blockNumber: receipt.blockNumber });
      if (!request.skipIndexerWait) await waitForIndexer(receipt.blockNumber);
      await queryClient.invalidateQueries();
      setState({ status: "confirmed", hash, blockNumber: receipt.blockNumber });
      return { ok: true, blockNumber: receipt.blockNumber, ...(receipt.contractAddress ? { contractAddress: receipt.contractAddress } : {}) };
    },
    [wallet, publicClient, queryClient],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);
  const busy = state.status === "simulating" || state.status === "signing" || state.status === "pending" || state.status === "indexing";
  return { state, run, reset, busy };
}
