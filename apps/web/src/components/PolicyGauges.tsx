import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PriceChart, ReleaseChart } from "@/components/charts";
import { RingGauge, Stat } from "@/components/gauges";
import { RiskPanel } from "@/components/RiskPanel";
import { Source } from "@/components/status";
import { formatBps, formatDuration, formatUnits, ratio } from "@/lib/format";
import type { PolicyConfig, PolicySnapshot, TokenDisplay } from "@/lib/types";

/**
 * A treasury policy at the indexed head: the shared per-period limits, the release curve, the market reading and the
 * price with its floor and quote band. Every strategy of the policy draws on these same numbers.
 */
export function PolicyGauges({ snapshot, config, base, quote, series }: { snapshot: PolicySnapshot; config: PolicyConfig; base: TokenDisplay; quote: TokenDisplay; series: PolicySnapshot[] }) {
  const p = config.period;
  const resetsIn = Number(snapshot.periodEndsAt) - Number(snapshot.timestamp);
  const src = (fn: string) => ({ block: snapshot.blockNumber, detail: `MandateQuoter.${fn}` });
  const meters: { title: string; used: string; cap: string; token: TokenDisplay }[] = [
    { title: "Net sold this period", used: snapshot.netSold, cap: p.netSellCap, token: base },
    { title: "Gross sold this period", used: snapshot.grossSold, cap: p.grossSellCap, token: base },
    { title: "Buyback spend this period", used: snapshot.quoteSpent, cap: p.quoteSpendCap, token: quote },
  ];
  const sellable = (() => {
    const unlocked = BigInt(snapshot.released) - BigInt(snapshot.totalNetSold);
    const period = BigInt(p.netSellCap) - BigInt(snapshot.netSold);
    const gross = BigInt(p.grossSellCap) - BigInt(snapshot.grossSold);
    const min = [unlocked, period, gross].reduce((a, b) => (a < b ? a : b));
    return min > 0n ? min : 0n;
  })();

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <Card className="xl:col-span-2">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Period limits</CardTitle>
          <CardDescription className="text-[11px]">Shared by every strategy · resets in {formatDuration(resetsIn)}</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-2 text-center">
          {meters.map((m) => {
            const used = ratio(m.used, m.cap);
            return (
              <div key={m.title} className="space-y-1">
                <RingGauge value={used} label={`${Math.round(used * 100)}%`} sublabel="used" />
                <p className="text-xs font-medium">{m.title}</p>
                <p className="text-[11px] text-muted-foreground">
                  <Source {...src("policyCounters")}>
                    <span className="tabular font-mono">{formatUnits(m.used, m.token.decimals, 0)}</span>
                  </Source>{" "}
                  / {formatUnits(m.cap, m.token.decimals, 0)} {m.token.symbol}
                </p>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <div className="xl:col-span-2">
        <RiskPanel snapshot={snapshot} config={config} base={base} quote={quote} />
      </div>

      <Card className="md:col-span-2">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Unlocked vs sold</CardTitle>
          <CardDescription className="text-[11px]">release curve (dashed) vs cumulative net sold; sold stays under the curve</CardDescription>
        </CardHeader>
        <CardContent>
          {series.length > 1 ? <ReleaseChart series={series} base={base} /> : <Skeleton className="h-[220px]" />}
          <div className="mt-3 grid grid-cols-3 gap-3">
            <Stat label="Unlocked" value={<Source {...src("policyCounters")}>{formatUnits(snapshot.released, base.decimals, 0)}</Source>} />
            <Stat label="Net sold" value={formatUnits(snapshot.totalNetSold, base.decimals, 0)} />
            <Stat label="Sellable now" value={formatUnits(sellable, base.decimals, 0)} caption="release and period limits" />
          </div>
        </CardContent>
      </Card>

      <Card className="md:col-span-2">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Price, floor and quote band</CardTitle>
          <CardDescription className="text-[11px]">
            Uniswap v4 spot and TWAP with the ±{formatBps(config.price.maxQuoteDeviationBps)} quote band; floor in red.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {series.length > 1 ? (
            <PriceChart series={series} base={base} quote={quote} floorX36={config.price.floorPriceX36} maxDeviationBps={Number(config.price.maxQuoteDeviationBps)} />
          ) : (
            <Skeleton className="h-[220px]" />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
