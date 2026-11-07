import { riskReasonText } from "@mandate/sdk";

import { Stat } from "@/components/gauges";
import { RiskBadge } from "@/components/status";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBps, formatDuration, formatPrice, formatUnits } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PolicyConfig, PolicySnapshot, TokenDisplay } from "@/lib/types";

/** Distance of `a` from `b` in bps, rounded up like MandateMath.deviationBps. */
function deviationBps(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  if (y === 0n) return 0;
  const diff = x > y ? x - y : y - x;
  return Number((diff * 10_000n + y - 1n) / y);
}

/**
 * The policy's market reading: the risk mode the quoter applies, why, and each oracle reading next to the issuer's
 * threshold for it. Everything here comes from one indexed block.
 */
export function RiskPanel({ snapshot, config, base, quote }: { snapshot: PolicySnapshot; config: PolicyConfig; base: TokenDisplay; quote: TokenDisplay }) {
  const o = config.oracle;
  const move = snapshot.priced ? deviationBps(snapshot.spotX36, snapshot.twapX36) : null;
  const volatility = snapshot.priced ? deviationBps(snapshot.shortTwapX36, snapshot.twapX36) : null;
  const limits = snapshot.riskMode === 1 ? config.defensive : config.normal;
  return (
    <Card className={cn(snapshot.riskMode === 2 && "border-blocked/50", snapshot.riskMode === 1 && "border-warning/50")}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          Market risk <RiskBadge mode={snapshot.riskMode} reason={snapshot.riskReason} />
        </CardTitle>
        <CardDescription className="text-[11px]">
          {snapshot.riskMode === 2 ? "No fills" : snapshot.riskMode === 1 ? "Defensive limits" : "Normal limits"} because{" "}
          {riskReasonText(snapshot.riskReason)}. Read from the Uniswap v4 pool at block {snapshot.blockNumber}.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {snapshot.priced ? (
          <>
            <Stat label="Spot" value={formatPrice(snapshot.spotX36, base.decimals, quote.decimals)} caption={quote.symbol} />
            <Stat label={`${formatDuration(Number(o.twapWindow))} TWAP`} value={formatPrice(snapshot.twapX36, base.decimals, quote.decimals)} caption={quote.symbol} />
            <Stat label="Move from TWAP" value={formatBps(move!)} caption={`defensive > ${formatBps(o.defensiveMoveBps)} · pause > ${formatBps(o.pauseMoveBps)}`} />
            <Stat label="Short-term volatility" value={formatBps(volatility!)} caption={`defensive > ${formatBps(o.defensiveVolatilityBps)} · pause > ${formatBps(o.pauseVolatilityBps)}`} />
            <Stat
              label={`Trusted depth (±${formatBps(o.depthBandBps)})`}
              value={formatUnits(snapshot.trustedDepthBase, base.decimals, 0)}
              caption={`${base.symbol} · pause < ${formatUnits(o.minTrustedDepth, base.decimals, 0)} · defensive < ${formatUnits(o.defensiveDepth, base.decimals, 0)}`}
            />
            <Stat label="Pool age" value={formatDuration(Number(snapshot.poolAge))} caption={`minimum ${formatDuration(Number(o.minPoolAge))}`} />
          </>
        ) : (
          <p className="col-span-full text-sm text-muted-foreground">
            The oracle has no price yet: the pool needs {formatDuration(Number(o.twapWindow))} of history.
          </p>
        )}
        {snapshot.riskMode !== 2 && (
          <p className="col-span-full text-xs text-muted-foreground">
            Now: fills up to {formatUnits(limits.maxFillBase, base.decimals, 0)} {base.symbol} and {formatBps(limits.maxFillDepthBps)} of trusted depth,
            spread at least {formatBps(limits.minSpreadBps)}, buybacks {limits.buybacksAllowed ? "allowed" : "off"}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
