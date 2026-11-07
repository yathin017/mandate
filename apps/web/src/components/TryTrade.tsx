import { buildApproveRouterCall, buildSwapCall, erc20Abi, mandateModuleAbi } from "@mandate/sdk";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { getAddress, type Address, type Hash } from "viem";
import { useConnection, usePublicClient, useReadContract } from "wagmi";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BlockedStamp, SyntheticTag } from "@/components/status";
import { api } from "@/lib/api";
import { formatUnits, parseUnits } from "@/lib/format";
import type { Strategy, TokenDisplay } from "@/lib/types";
import { demoChain, deployment } from "@/wallet/config";
import { TxStatus } from "@/wallet/TxStatus";
import { useTx } from "@/wallet/useTx";

/** Any address works as the quote's `from` (nothing is signed); Anvil's account 0 is used on every chain. */
const DEMO_TAKER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

type Side = "buy" | "sell";

/**
 * Asks the indexer to simulate a trade against the live strategy. The server runs the router quote and decides
 * the outcome; this form only sends the trade parameters.
 */
export function TryTrade({ strategy, base, quote }: { strategy: Strategy; base: TokenDisplay; quote: TokenDisplay }) {
  const [side, setSide] = useState<Side>("buy");
  // A probe amount for the form, not an economic setting: the user edits it before simulating.
  const [amount, setAmount] = useState("100");
  const payToken = side === "buy" ? quote : base;
  const raw = parseUnits(amount, payToken.decimals);

  const simulate = useMutation({
    mutationFn: () =>
      api.simulate(strategy.strategyId, {
        taker: DEMO_TAKER,
        tokenIn: side === "buy" ? strategy.quote : strategy.base,
        tokenOut: side === "buy" ? strategy.base : strategy.quote,
        amount: raw!.toString(),
        isExactIn: true,
      }),
  });
  const result = simulate.data?.data;
  const receiveToken = side === "buy" ? base : quote;

  return (
    <div className="space-y-4">
      <Tabs value={side} onValueChange={(v) => { setSide(v as Side); simulate.reset(); }}>
        <TabsList className="w-full">
          <TabsTrigger value="buy">Buy {base.symbol}</TabsTrigger>
          <TabsTrigger value="sell">Sell {base.symbol}</TabsTrigger>
        </TabsList>
      </Tabs>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (raw && raw > 0n) simulate.mutate();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="amount">You pay ({payToken.symbol})</Label>
          <Input
            id="amount"
            inputMode="decimal"
            className="tabular font-mono"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              simulate.reset();
            }}
            aria-invalid={raw === null}
          />
          {raw === null && <p className="text-xs text-blocked">Enter a positive amount with at most {payToken.decimals} decimals.</p>}
        </div>
        <Button type="submit" className="w-full" disabled={!raw || raw === 0n || simulate.isPending}>
          {simulate.isPending ? "Asking the quoter…" : "Simulate against the live strategy"}
        </Button>
      </form>

      {simulate.isError && <p className="text-sm text-blocked">{simulate.error.message}</p>}
      {result && (
        <div className="space-y-2 rounded-lg border p-3" aria-live="polite">
          <div className="flex items-center justify-between">
            <SyntheticTag label="SIMULATED" />
            <span className="tabular font-mono text-[11px] text-muted-foreground">at block {result.blockNumber}</span>
          </div>
          {result.outcome === "allowed" ? (
            <>
              <p className="text-sm">
                Fills. You would receive{" "}
                <span className="tabular font-mono font-semibold text-filled">
                  {formatUnits(result.amountOut!, receiveToken.decimals, 4)} {receiveToken.symbol}
                </span>
                .
              </p>
              <RunTrade
                strategy={strategy}
                side={side}
                amountIn={raw!}
                quotedOut={BigInt(result.amountOut!)}
                payToken={payToken}
                receiveToken={receiveToken}
                onDone={() => simulate.reset()}
              />
            </>
          ) : (
            <div className="space-y-2">
              <BlockedStamp clause={result.errorName} />
              <p className="text-sm">{result.explanation}</p>
            </div>
          )}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">
        Runs the real router quote via eth_call at the indexed block. Nothing is signed or sent; the attempt is added
        to the public feed as simulated.
      </p>
    </div>
  );
}

/**
 * Sends the simulated trade from the connected wallet through the canonical SwapVM router: approve the router for the
 * exact amount, then swap with at most 1% less than the simulated output. Each step is simulated first and refused
 * with its reason if the policy or the wallet would not allow it.
 */
function RunTrade({
  strategy,
  side,
  amountIn,
  quotedOut,
  payToken,
  receiveToken,
  onDone,
}: {
  strategy: Strategy;
  side: Side;
  amountIn: bigint;
  quotedOut: bigint;
  payToken: TokenDisplay;
  receiveToken: TokenDisplay;
  onDone: () => void;
}) {
  const { address, chainId } = useConnection();
  const client = usePublicClient({ chainId: demoChain.id });
  const approve = useTx();
  const swap = useTx();
  const tokenIn = getAddress(side === "buy" ? strategy.quote : strategy.base);
  const tokenOut = getAddress(side === "buy" ? strategy.base : strategy.quote);
  const balance = useReadContract({
    address: tokenIn,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: demoChain.id,
    query: { enabled: Boolean(address) },
  });
  const held = balance.data as bigint | undefined;

  if (!address) return <p className="text-xs text-muted-foreground">Connect a wallet to run this trade for real.</p>;
  if (chainId !== demoChain.id) return <p className="text-xs text-blocked">Switch your wallet to {demoChain.name} to run this trade.</p>;
  const short = held !== undefined && held < amountIn;

  async function run() {
    if (!client) return;
    const approved = await approve.run({ send: buildApproveRouterCall(deployment, tokenIn, amountIn), context: { base: receiveToken, quote: payToken } });
    if (!approved.ok) return;
    const order = await client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "activeOrder", args: [strategy.strategyId as Hash] });
    const block = await client.getBlock();
    const call = buildSwapCall(deployment, {
      order, tokenIn, tokenOut: tokenOut as Address, amount: amountIn, isExactIn: true,
      threshold: (quotedOut * 99n) / 100n, deadline: block.timestamp + 600n,
    });
    const swapped = await swap.run({ send: call });
    if (swapped.ok) {
      void balance.refetch();
      onDone();
    }
  }

  return (
    <div className="space-y-2 border-t pt-2">
      {short && (
        <p className="text-xs text-blocked">
          This wallet holds {formatUnits(held!, payToken.decimals, 2)} {payToken.symbol}; the trade needs {formatUnits(amountIn, payToken.decimals, 2)}.
        </p>
      )}
      <Button className="w-full" disabled={short || approve.busy || swap.busy} onClick={() => void run()}>
        {approve.busy ? "Approving…" : swap.busy ? "Trading…" : `Run this trade with my wallet (${side === "buy" ? "buy" : "sell"})`}
      </Button>
      <TxStatus state={approve.state} />
      <TxStatus state={swap.state} />
      <p className="text-[11px] text-muted-foreground">
        Two transactions: approve the router for exactly this amount, then swap through the canonical 1inch SwapVM router
        with at most 1% slippage. The fill appears in the activity feed and the liquidity report.
      </p>
    </div>
  );
}

