import { explainError, type ErrorContext, type ExplainedError } from "@mandate/sdk";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { Address, Hash, Hex } from "viem";
import { usePublicClient, useWalletClient } from "wagmi";

import { demoChain } from "./config";

/** Every wallet action moves through these states (spec 10.2 rule 5). */
export type TxState =
  | { status: "idle" }
  | { status: "simulating" }
  /** Refused in simulation: nothing was sent. */
  | { status: "blocked"; error: ExplainedError }
  | { status: "signing" }
  | { status: "pending"; hash: Hash }
  | { status: "confirmed"; hash: Hash; blockNumber: bigint }
  /** simulateOnly run whose checks passed; nothing was sent. */
  | { status: "simulated" }
  | { status: "failed"; message: string; hash?: Hash };

export interface Call {
  readonly to: Address;
  readonly data: Hex;
}

export interface TxRequest {
  /** The transaction the connected wallet sends. */
  readonly send: Call;
  /** eth_calls that must succeed first, e.g. the module call as the Safe would make it. Defaults to `send`. */
  readonly checks?: readonly (Call & { from: Address })[];
  readonly context?: ErrorContext;
  /** Run the checks only and never send, e.g. to demonstrate a refusal. */
  readonly simulateOnly?: boolean;
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
    async (request: TxRequest): Promise<boolean> => {
      if (!wallet || !publicClient) {
        setState({ status: "failed", message: "Connect a wallet on the demo chain first." });
        return false;
      }
      const account = wallet.account.address;

      setState({ status: "simulating" });
      const checks = request.checks ?? [{ ...request.send, from: account }];
      for (const check of checks) {
        try {
          await publicClient.call({ account: check.from, to: check.to, data: check.data });
        } catch (error) {
          setState({ status: "blocked", error: explainError(error, request.context) });
          return false;
        }
      }

      if (request.simulateOnly) {
        setState({ status: "simulated" });
        return true;
      }

      setState({ status: "signing" });
      let hash: Hash;
      try {
        hash = await wallet.sendTransaction({ account, chain: demoChain, to: request.send.to, data: request.send.data });
      } catch (error) {
        const rejected = error instanceof Error && /reject|denied/i.test(`${error.name} ${error.message}`);
        setState({ status: "failed", message: rejected ? "You rejected the request in your wallet." : explainError(error, request.context).message });
        return false;
      }

      setState({ status: "pending", hash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        setState({ status: "failed", hash, message: "The transaction reverted onchain. Refresh the state and try again." });
        return false;
      }
      setState({ status: "confirmed", hash, blockNumber: receipt.blockNumber });
      await queryClient.invalidateQueries();
      return true;
    },
    [wallet, publicClient, queryClient],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);
  return { state, run, reset, busy: state.status === "simulating" || state.status === "signing" || state.status === "pending" };
}
