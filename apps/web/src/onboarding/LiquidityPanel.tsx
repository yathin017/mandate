import { buildAddLiquidityCall, planFullRangeLiquidity, type AnchorStatus, type LiquidityPlan } from "@mandate/sdk";
import { useEffect, useMemo, useState } from "react";
import { getAddress, type Address } from "viem";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { nice, priceOf } from "@/issuer/explain";
import { formatUnits, parseUnits } from "@/lib/format";
import type { TokenDisplay } from "@/lib/types";
import { SafeActionPanel } from "@/wallet/SafeActionPanel";

import { CONFIG_CHAIN_ID } from "./SafeStep";

/**
 * `lp` URL parameter: the base amount and the pool price the plan was made at (`<baseRaw>.<sqrtPriceX96>`). Co-owners
 * rebuild the plan from it, not from the live price, so every owner approves byte-identical calldata.
 */
export function encodeLp(baseAmount: bigint, sqrtPriceX96: bigint): string {
  return `${baseAmount}.${sqrtPriceX96}`;
}

function decodeLp(value: string | null): { baseAmount: bigint; sqrtPriceX96: bigint } | null {
  const match = value ? /^(\d{1,40})\.(\d{1,49})$/.exec(value) : null;
  if (!match) return null;
  return { baseAmount: BigInt(match[1]!), sqrtPriceX96: BigInt(match[2]!) };
}

/**
 * Adds full-range liquidity from the Safe to the anchor pool, so its price costs real money to move. One batched Safe
 * transaction through the canonical Uniswap v4 PositionManager; the position NFT belongs to the Safe, and its owners
 * can remove the liquidity later (for example in the Uniswap app).
 */
export function LiquidityPanel({
  safe,
  base,
  baseToken,
  quoteToken,
  status,
  holdings,
  lpParam,
  onLp,
  onAdded,
}: {
  safe: Address;
  base: Address;
  baseToken: TokenDisplay;
  quoteToken: TokenDisplay;
  status: AnchorStatus;
  holdings: { base?: bigint | undefined; quote?: bigint | undefined };
  lpParam: string | null;
  onLp: (encoded: string | null) => void;
  onAdded: () => void;
}) {
  const shared = decodeLp(lpParam);
  // Suggested once the Safe's balances are known: 40% of its tokens, or less if its quote cannot match that at the
  // pool price (10% headroom for the slippage cap). The owner can change it before preparing.
  const [amount, setAmount] = useState("");
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (touched || shared || holdings.base === undefined || holdings.quote === undefined || status.spotPriceX36 === 0n) return;
    const price = priceOf(status.spotPriceX36, { address: base, ...baseToken }, { address: base, ...quoteToken });
    const baseHeld = Number(holdings.base) / 10 ** baseToken.decimals;
    const quoteHeld = Number(holdings.quote) / 10 ** quoteToken.decimals;
    const suggested = nice(Math.min(baseHeld * 0.4, (quoteHeld / price) * 0.9));
    if (suggested > 0) setAmount(String(suggested));
  }, [touched, shared, holdings.base, holdings.quote, status.spotPriceX36]);
  const baseIs0 = getAddress(status.poolKey.currency0) === getAddress(base);

  const typed = parseUnits(amount, baseToken.decimals);
  // A shared plan keeps its recorded price; a new one uses the live price.
  const baseAmount = shared?.baseAmount ?? typed ?? null;
  const sqrtPriceX96 = shared?.sqrtPriceX96 ?? status.sqrtPriceX96;
  const planned = useMemo((): { plan: LiquidityPlan } | { error: string } | null => {
    if (!baseAmount) return null;
    try {
      return { plan: planFullRangeLiquidity({ poolKey: status.poolKey, sqrtPriceX96, base, baseAmount }) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [baseAmount, sqrtPriceX96, status.poolKey, base]);

  const plan = planned && "plan" in planned ? planned.plan : null;
  const baseNeed = plan ? (baseIs0 ? plan.amount0 : plan.amount1) : 0n;
  const quoteNeed = plan ? (baseIs0 ? plan.amount1 : plan.amount0) : 0n;
  const baseCap = plan ? (baseIs0 ? plan.amount0Max : plan.amount1Max) : 0n;
  const quoteCap = plan ? (baseIs0 ? plan.amount1Max : plan.amount0Max) : 0n;
  const short =
    plan && holdings.base !== undefined && holdings.quote !== undefined && (baseCap > holdings.base || quoteCap > holdings.quote)
      ? `The Safe holds ${formatUnits(holdings.base, baseToken.decimals, 2)} ${baseToken.symbol} and ${formatUnits(holdings.quote, quoteToken.decimals, 2)} ${quoteToken.symbol}; this needs up to ${formatUnits(baseCap, baseToken.decimals, 2)} and ${formatUnits(quoteCap, quoteToken.decimals, 2)}.`
      : null;
  const moved = shared && shared.sqrtPriceX96 !== status.sqrtPriceX96;
  // Stable across renders so the Safe panel keeps one transaction hash while owners approve.
  const call = useMemo(() => (plan ? buildAddLiquidityCall(CONFIG_CHAIN_ID, safe, plan) : null), [plan, safe]);
  const amounts = plan && (
    <p className="text-sm">
      Adds about <b className="tabular font-mono">{formatUnits(baseNeed, baseToken.decimals, 2)}</b> {baseToken.symbol} and{" "}
      <b className="tabular font-mono">{formatUnits(quoteNeed, quoteToken.decimals, 2)}</b> {quoteToken.symbol} at the current price, across all
      prices. At most {formatUnits(baseCap, baseToken.decimals, 2)} / {formatUnits(quoteCap, quoteToken.decimals, 2)} (1% slippage); a bigger price move
      makes the transaction revert.
    </p>
  );

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div>
        <p className="font-medium">Add liquidity from the Safe</p>
        <p className="text-xs text-muted-foreground">
          A full-range Uniswap v4 position owned by the Safe. The deeper the pool, the more it costs anyone to push the anchor price.
        </p>
      </div>

      {shared ? (
        <>
          {amounts}
          {moved && <p className="text-sm text-warning">The pool price moved since this was prepared; if it moved more than 1%, executing reverts.</p>}
          {short && <p className="text-sm text-blocked">{short}</p>}
          {call && !short && (
            <SafeActionPanel
              safe={safe}
              call={call}
              label="Add liquidity (one batched Safe transaction)"
              onDone={() => {
                onLp(null);
                onAdded();
              }}
            />
          )}
          <Button variant="ghost" size="sm" onClick={() => onLp(null)}>
            Change amount
          </Button>
        </>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="lp-amount">{baseToken.symbol} to add</Label>
            <Input id="lp-amount" className="w-56 tabular font-mono" placeholder="100000" value={amount} onChange={(e) => {
                setTouched(true);
                setAmount(e.target.value);
              }} />
          </div>
          {amount && !typed && <p className="text-sm text-blocked">Enter an amount of {baseToken.symbol}.</p>}
          {planned && "error" in planned && <p className="text-sm text-blocked">{planned.error}</p>}
          {amounts}
          {short && <p className="text-sm text-blocked">{short}</p>}
          <Button disabled={!plan || Boolean(short)} onClick={() => typed && onLp(encodeLp(typed, status.sqrtPriceX96))}>
            Review
          </Button>
        </>
      )}
    </div>
  );
}
