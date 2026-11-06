import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BlockedStamp, SyntheticTag } from "@/components/status";
import { api } from "@/lib/api";
import { formatUnits, parseUnits } from "@/lib/format";
import type { Mandate, TokenDisplay } from "@/lib/types";

/** Anvil's public development account 0: the demo's taker. Only used as the quote's `from`; nothing is signed. */
const DEMO_TAKER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

type Side = "buy" | "sell";

/**
 * Asks the indexer to simulate a trade against the live strategy. The server runs the router quote and decides
 * the outcome; this form only sends the trade parameters.
 */
export function TryTrade({ mandate, base, quote }: { mandate: Mandate; base: TokenDisplay; quote: TokenDisplay }) {
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("100");
  const payToken = side === "buy" ? quote : base;
  const raw = parseUnits(amount, payToken.decimals);

  const simulate = useMutation({
    mutationFn: () =>
      api.simulate(mandate.mandateId, {
        taker: DEMO_TAKER,
        tokenIn: side === "buy" ? mandate.quote : mandate.base,
        tokenOut: side === "buy" ? mandate.base : mandate.quote,
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
            <p className="text-sm">
              Fills. You would receive{" "}
              <span className="tabular font-mono font-semibold text-filled">
                {formatUnits(result.amountOut!, receiveToken.decimals, 4)} {receiveToken.symbol}
              </span>
              .
            </p>
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
