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

import { LiquidityPanel } from "./LiquidityPanel";
import { CONFIG_CHAIN_ID } from "./SafeStep";

const Q96 = 1n << 96n;

/**
 * Shared with the wizard so it knows when the anchor step is complete. `window` is the treasury policy's TWAP window
 * once a policy exists; without it readiness is not judged (there is no window to cover yet).
 */
export function useAnchorStatus(base: Address | null, quote: Address | null, window?: number) {
  const publicClient = usePublicClient({ chainId: demoChain.id }) as PublicClient | undefined;
  return useQuery({
    queryKey: ["anchor-status", demoChain.id, ANCHOR_LAUNCHER, base, quote, window ?? null],
    queryFn: () =>
      readAnchorStatus(publicClient!, { chainId: CONFIG_CHAIN_ID, launcher: ANCHOR_LAUNCHER!, base: base!, quote: quote!, ...(window ? { window } : {}) }),
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
 * Step 4: a Uniswap v4 pool with the Mandate oracle hook and a market oracle for (base, quote), via AnchorLauncher,
 * and liquidity in it. Done once the oracle exists and the pool has liquidity; the policy then decides how much
 * history, age and depth it requires before the treasury trades.
 */
export function AnchorStep({
  base,
  quote,
  baseToken,
  quoteToken,
  safe,
  holdings,
  lpParam,
  onLp,
  window,
}: {
  base: Address;
  quote: Address;
  baseToken: TokenDisplay;
  quoteToken: TokenDisplay;
  /** Treasury Safe: when given, the step offers to add liquidity from it once the anchor exists. */
  safe?: Address;
  holdings?: { base?: bigint | undefined; quote?: bigint | undefined };
  lpParam?: string | null;
  onLp?: (encoded: string | null) => void;
  /** The treasury policy's TWAP window, once there is a policy. */
  window?: number;
}) {
  const status = useAnchorStatus(base, quote, window);
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
              <Input id="start-price" className="w-48 tabular font-mono" placeholder="price" value={price} onChange={(e) => setPrice(e.target.value)} />
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

      {s.anchor && safe && onLp && (
        <LiquidityPanel
          safe={safe}
          base={base}
          baseToken={baseToken}
          quoteToken={quoteToken}
          status={s}
          holdings={holdings ?? {}}
          lpParam={lpParam ?? null}
          onLp={onLp}
          onAdded={() => void status.refetch()}
        />
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
          ? "No liquidity: anyone can move this price for free, so the anchor would be meaningless. Add liquidity from the Safe below before trading."
          : `In-range depth ≈ ${formatUnits(d.base, baseToken.decimals, 0)} ${baseToken.symbol} / ${formatUnits(d.quote, quoteToken.decimals, 0)} ${quoteToken.symbol}. Deeper pools make the anchor harder to move.`}
      </p>
      {!empty && status.trustedLiquidity < status.liquidity && (
        <p className="text-xs text-warning">
          Some liquidity was added recently and is not trusted yet: the oracle counts it once it has stayed for its settle
          period, so a just-in-time deposit cannot inflate depth.
        </p>
      )}
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
  const age = status.initializedAt === null ? null : Math.max(0, now - status.initializedAt);

  return (
    <div className="space-y-1 rounded-lg border p-3 text-sm">
      <p>
        Oracle <Hex value={anchor} /> · price-history buffer {status.cardinalityNext} slots
      </p>
      <p className="text-muted-foreground">
        Pool age <span className="tabular font-mono">{age === null ? "…" : formatDuration(age)}</span> · price history{" "}
        <span className="tabular font-mono">{formatDuration(status.historySeconds + elapsed)}</span>
      </p>
      {status.ready === null ? (
        <p className="text-muted-foreground">Your treasury policy sets how much history, pool age and depth trading needs.</p>
      ) : status.ready || remaining === 0 ? (
        <p className="text-filled">The pool covers the policy's TWAP window.</p>
      ) : (
        <p className="text-warning">
          Collecting price history: the policy's TWAP window is covered in{" "}
          <span className="tabular font-mono">{remaining === null ? "…" : formatDuration(remaining)}</span>.
        </p>
      )}
    </div>
  );
}
