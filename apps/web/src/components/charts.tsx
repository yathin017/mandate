import { Area, AreaChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { formatChainTime, formatPrice, formatUnits } from "@/lib/format";
import type { PolicySnapshot, TokenDisplay } from "@/lib/types";

const toNumber = (raw: string, decimals: number) => Number(formatUnits(raw, decimals, 6).replaceAll(",", ""));
const price = (x36: string, base: TokenDisplay, quote: TokenDisplay) =>
  Number(formatPrice(x36, base.decimals, quote.decimals, 6).replaceAll(",", ""));

const axis = { stroke: "var(--muted-foreground)", fontSize: 11, tickLine: false, axisLine: false } as const;
const tooltipStyle = {
  contentStyle: { background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 },
  labelFormatter: (t: unknown) => formatChainTime(Number(t)),
} as const;

/** Release curve (dashed) vs cumulative net sold (solid). Sold must always stay under the curve. */
export function ReleaseChart({ series, base }: { series: PolicySnapshot[]; base: TokenDisplay }) {
  const data = series.map((s) => ({
    t: Number(s.timestamp),
    released: toNumber(s.released, base.decimals),
    sold: toNumber(s.totalNetSold, base.decimals),
  }));
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={() => ""} {...axis} />
        <YAxis width={56} tickFormatter={(v: number) => Intl.NumberFormat("en", { notation: "compact" }).format(v)} {...axis} />
        <Tooltip {...tooltipStyle} formatter={(v, name) => [`${Number(v).toLocaleString()} ${base.symbol}`, String(name)]} />
        <Area type="stepAfter" dataKey="released" name="Unlocked" stroke="var(--chart-2)" strokeDasharray="5 4" fill="var(--chart-2)" fillOpacity={0.08} />
        <Area type="stepAfter" dataKey="sold" name="Net sold" stroke="var(--chart-1)" fill="var(--chart-1)" fillOpacity={0.25} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** v4 spot and TWAP with the policy's quote tolerance band and the price floor. */
export function PriceChart({
  series,
  base,
  quote,
  floorX36,
  maxDeviationBps,
}: {
  series: PolicySnapshot[];
  base: TokenDisplay;
  quote: TokenDisplay;
  floorX36: string;
  maxDeviationBps: number;
}) {
  const band = maxDeviationBps / 10_000;
  const data = series
    .filter((s) => s.priced)
    .map((s) => {
      const twap = price(s.twapX36, base, quote);
      return {
        t: Number(s.timestamp),
        spot: price(s.spotX36, base, quote),
        twap,
        upper: twap * (1 + band),
        lower: twap * (1 - band),
      };
    });
  const floor = BigInt(floorX36) === 0n ? null : price(floorX36, base, quote);
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={() => ""} {...axis} />
        <YAxis width={56} domain={["auto", "auto"]} tickFormatter={(v: number) => v.toFixed(3)} {...axis} />
        <Tooltip {...tooltipStyle} formatter={(v, name) => [`${Number(v).toFixed(4)} ${quote.symbol}`, String(name)]} />
        <Line dataKey="upper" name="Band (upper)" stroke="var(--muted-foreground)" strokeDasharray="2 4" dot={false} />
        <Line dataKey="lower" name="Band (lower)" stroke="var(--muted-foreground)" strokeDasharray="2 4" dot={false} />
        <Line dataKey="twap" name="Uniswap TWAP" stroke="var(--chart-2)" strokeWidth={2} dot={false} />
        <Line dataKey="spot" name="Uniswap spot" stroke="var(--chart-1)" dot={false} />
        {floor !== null && <ReferenceLine y={floor} stroke="var(--blocked)" strokeDasharray="4 3" label={{ value: "floor", fill: "var(--blocked)", fontSize: 11, position: "insideBottomRight" }} />}
      </LineChart>
    </ResponsiveContainer>
  );
}
