import { buildLaunchAnchorCall, parsePriceX36, readAnchorStatus, type AnchorStatus } from "@mandate/sdk";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Address, PublicClient } from "viem";
import { usePublicClient } from "wagmi";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Hex } from "@/components/status";
import { formatDuration, formatPrice, formatUnits } from "@/lib/format";
import type { TokenDisplay } from "@/lib/types";
import { ANCHOR_LAUNCHER, demoChain } from "@/wallet/config";
import { TxStatus } from "@/wallet/TxStatus";
import { useTx } from "@/wallet/useTx";

import { CONFIG_CHAIN_ID } from "./SafeStep";

const Q96 = 1n << 96n;

/** Shared with the wizard so it knows when the anchor step is complete. */
export function useAnchorStatus(base: Address | null, quote: Address | null) {
  const publicClient = usePublicClient({ chainId: demoChain.id }) as PublicClient | undefined;
  return useQuery({
    queryKey: ["anchor-status", demoChain.id, ANCHOR_LAUNCHER, base, quote],
    queryFn: () => readAnchorStatus(publicClient!, { chainId: CONFIG_CHAIN_ID, launcher: ANCHOR_LAUNCHER!, base: base!, quote: quote! }),
    enabled: Boolean(publicClient && ANCHOR_LAUNCHER && base && quote),
    refetchInterval: 15_000,
  });
}

/**
 * In-range depth of the pool in token units (virtual reserves at the current price): quote = L·√P, base = L/√P
 * for base = currency0, swapped otherwise. A rough guide to how much it costs to move the price.
 */
function depth(status: AnchorStatus, base: Address): { base: bigint; quote: bigint } {
  if (status.liquidity === 0n || status.sqrtPriceX96 === 0n) return { base: 0n, quote: 0n };
  const amount0 = (status.liquidity * Q96) / status.sqrtPriceX96;
  const amount1 = (status.liquidity * status.sqrtPriceX96) / Q96;
  return base.toLowerCase() === status.poolKey.currency0.toLowerCase() ? { base: amount0, quote: amount1 } : { base: amount1, quote: amount0 };
}

/**
 * Step 4: a Uniswap v4 pool with the Mandate oracle hook and a TWAP anchor for (base, quote), via AnchorLauncher.
 * Done once the anchor exists and its pool has a full TWAP window of history.
 */
export function AnchorStep({ base, quote, baseToken, quoteToken }: { base: Address; quote: Address; baseToken: TokenDisplay; quoteToken: TokenDisplay }) {
  const status = useAnchorStatus(base, quote);
  const tx = useTx();
  const [price, setPrice] = useState("");

  if (!ANCHOR_LAUNCHER) {
    return <p className="text-sm text-blocked">No AnchorLauncher is registered for {demoChain.name}. Set VITE_ANCHOR_LAUNCHER for a local fork.</p>;
  }
  if (status.isPending) return <p className="text-sm text-muted-foreground">Reading the pool…</p>;
  if (status.isError) return <p className="text-sm text-blocked">Could not read the anchor pool: {status.error.message}</p>;
  const s = status.data;

  let priceX36: bigint | null = null;
  let priceError: string | null = null;
  if (price) {
    try {
      priceX36 = parsePriceX36(price.trim(), baseToken.decimals, quoteToken.decimals);
      if (priceX36 === 0n) throw new Error("Price must be positive");
    } catch (e) {
      priceError = e instanceof Error ? e.message : String(e);
    }
  }
  const needsPrice = !s.poolExists;

  async function launch() {
    const call = buildLaunchAnchorCall(CONFIG_CHAIN_ID, ANCHOR_LAUNCHER!, { base, quote, initialPriceX36: priceX36 ?? 1n });
    const outcome = await tx.run({ send: { to: call.to, data: call.data }, skipIndexerWait: true });
    if (outcome.ok) await status.refetch();
  }

  const d = depth(s, base);
  return (
    <div className="space-y-4">
      {s.poolExists ? (
        <PoolFacts status={s} depth={d} baseToken={baseToken} quoteToken={quoteToken} />
      ) : (
        <p className="text-sm text-muted-foreground">No pool exists for this pair yet. Launching creates it at your starting price.</p>
      )}

      {s.anchor ? (
        <Readiness status={s} anchor={s.anchor} />
      ) : (
        <div className="space-y-3 rounded-lg border p-4">
          {needsPrice && (
            <div className="space-y-1.5">
              <Label htmlFor="start-price">Starting price ({quoteToken.symbol} per {baseToken.symbol})</Label>
              <Input id="start-price" className="w-48 tabular font-mono" placeholder="0.40" value={price} onChange={(e) => setPrice(e.target.value)} />
              {priceError && <p className="text-xs text-blocked">{priceError}</p>}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            One transaction (~7.5M gas, mostly reserving 300 price-history slots): creates the pool if needed and deploys
            the anchor at <Hex value={s.predictedAnchor} />. Anyone can launch it; it holds no funds.
          </p>
          <Button disabled={(needsPrice && !priceX36) || tx.busy} onClick={() => void launch()}>
            {s.poolExists ? "Deploy anchor for the existing pool" : "Create pool and anchor"}
          </Button>
          <TxStatus state={tx.state} />
        </div>
      )}
    </div>
  );
}

function PoolFacts({ status, depth: d, baseToken, quoteToken }: { status: AnchorStatus; depth: { base: bigint; quote: bigint }; baseToken: TokenDisplay; quoteToken: TokenDisplay }) {
  const empty = status.liquidity === 0n;
  return (
    <div className="space-y-1 rounded-lg border p-3 text-sm">
      <p>
        Pool <Hex value={status.poolId} chars={6} /> · price{" "}
        <b className="tabular font-mono">{formatPrice(status.spotPriceX36, baseToken.decimals, quoteToken.decimals)}</b> {quoteToken.symbol} per {baseToken.symbol}
      </p>
      {!status.anchor && (
        <p className="text-xs text-warning">
          This pool already exists, so its current price stands. Check it is the market price before relying on it.
        </p>
      )}
      <p className={empty ? "text-blocked" : "text-muted-foreground"}>
        {empty
          ? "No liquidity: anyone can move this price for free, so the anchor would be meaningless. Add liquidity with Uniswap v4 before trading."
          : `In-range depth ≈ ${formatUnits(d.base, baseToken.decimals, 0)} ${baseToken.symbol} / ${formatUnits(d.quote, quoteToken.decimals, 0)} ${quoteToken.symbol}. Deeper pools make the anchor harder to move.`}
      </p>
    </div>
  );
}

function Readiness({ status, anchor }: { status: AnchorStatus; anchor: Address }) {
  // Chain time advances between reads; interpolate locally so the countdown ticks.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    const timer = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(timer);
  }, [status.source.timestamp]);
  const now = Number(status.source.timestamp) + elapsed;
  const remaining = status.readyAt === null ? null : Math.max(0, status.readyAt - now);

  return (
    <div className="space-y-1 rounded-lg border p-3 text-sm">
      <p>
        Anchor <Hex value={anchor} /> · price-history buffer {status.cardinalityNext} slots
      </p>
      {status.ready || remaining === 0 ? (
        <p className="text-filled">Ready: the pool has a full 30-minute price history.</p>
      ) : (
        <p className="text-warning">
          Collecting price history: quotes open in <span className="tabular font-mono">{remaining === null ? "…" : formatDuration(remaining)}</span>.
          You can prepare the mandate meanwhile.
        </p>
      )}
    </div>
  );
}
