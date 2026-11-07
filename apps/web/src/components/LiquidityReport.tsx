import { useQuery } from "@tanstack/react-query";
import { Download, ExternalLink } from "lucide-react";
import { getAddress } from "viem";

import { RiskBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type Subject } from "@/lib/api";
import { clauseOf } from "@/lib/clauses";
import { formatChainTime, formatPrice, formatUnits } from "@/lib/format";
import type { Insights, RiskMode, TokenDisplay } from "@/lib/types";
import { roleOf, txUrl } from "@/wallet/config";

/** Insights query; its key sits under the subject so the live stream refreshes it with every new fill. */
export const useInsights = (subject: Subject) =>
  useQuery({ queryKey: [subject.kind, subject.id, "insights"], queryFn: () => api.insights(subject), refetchInterval: 30_000 });

/** Volume-weighted price of `quote` per `base` from raw totals, as an X36 price for formatPrice. */
const avgPriceX36 = (quoteRaw: string, baseRaw: string) => (BigInt(baseRaw) === 0n ? null : (BigInt(quoteRaw) * 10n ** 36n) / BigInt(baseRaw));
const bps = (v: number | null) => (v === null ? "—" : `${(v / 100).toFixed(2)}%`);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * What the market maker's order did, for judges and issuers: who traded, how much liquidity it gave buyers and
 * took from sellers, at what prices against the market, what it earned and for whom, and which rules refused what.
 * Then every trade, exportable as CSV. Works for one strategy or every strategy of a policy.
 */
export function LiquidityReport({ subject, base, quote }: { subject: Subject; base: TokenDisplay; quote: TokenDisplay }) {
  const insights = useInsights(subject);
  if (insights.isPending) return <Skeleton className="h-64 w-full" />;
  if (insights.isError) return <p className="text-sm text-blocked">Could not load the report: {insights.error.message}</p>;
  const { totals: t, refusals, trades } = insights.data.data;
  const b = (raw: string, digits = 2) => `${formatUnits(raw, base.decimals, digits)} ${base.symbol}`;
  const q = (raw: string, digits = 2) => `${formatUnits(raw, quote.decimals, digits)} ${quote.symbol}`;
  const buyPrice = avgPriceX36(t.quote_received, t.base_sold);
  const sellPrice = avgPriceX36(t.quote_paid, t.base_bought_back);
  const price = (x36: bigint | null) => (x36 === null ? "—" : `${formatPrice(x36, base.decimals, quote.decimals, 4)} ${quote.symbol}`);
  const onchainRefusals = refusals.filter((r) => r.source === "onchain_actor").reduce((n, r) => n + r.count, 0);
  const simulatedRefusals = refusals.filter((r) => r.source === "simulated").reduce((n, r) => n + r.count, 0);
  const treasuryFees = (total: string, mm: string) => (BigInt(total) - BigInt(mm)).toString();

  if (t.trades === 0 && refusals.length === 0) {
    return <p className="text-sm text-muted-foreground">No trades yet. Once takers fill the order, this report shows the liquidity it provided.</p>;
  }

  return (
    <div className="space-y-5">
      <p className="text-sm leading-relaxed">
        Across <b>{t.trades}</b> trades by <b>{t.unique_takers}</b> {t.unique_takers === 1 ? "trader" : "traders"}, the order sold{" "}
        <b>{b(t.base_sold, 0)}</b> to buyers and bought back <b>{b(t.base_bought_back, 0)}</b> from sellers, on average{" "}
        <b>{bps(t.avg_abs_quality_bps)}</b> from the market price. Every trade passed the treasury policy
        {onchainRefusals + simulatedRefusals > 0 ? (
          <>
            , and <b>{onchainRefusals + simulatedRefusals}</b> attempts that broke it were refused.
          </>
        ) : (
          "."
        )}
      </p>

      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Trades" value={String(t.trades)} detail={`${t.buys} buys · ${t.sells} sells back`} />
        <Kpi label="Liquidity to buyers" value={b(t.base_sold, 0)} detail={`for ${q(t.quote_received)} · avg ${price(buyPrice)}`} />
        <Kpi label="Liquidity from sellers" value={b(t.base_bought_back, 0)} detail={`for ${q(t.quote_paid)} · avg ${price(sellPrice)}`} />
        <Kpi
          label="Execution vs market"
          value={bps(t.avg_abs_quality_bps)}
          detail={t.avg_quality_bps === null ? "no reference yet" : `${t.avg_quality_bps >= 0 ? "+" : ""}${bps(t.avg_quality_bps)} net, + favours the treasury`}
        />
        <Kpi label="Spread fees earned" value={q(t.fees_quote)} detail={`and ${b(t.fees_base)}`} />
        <Kpi label="Market maker's share" value={q(t.mm_fees_quote)} detail={`and ${b(t.mm_fees_base)}`} />
        <Kpi label="Kept by the treasury" value={q(treasuryFees(t.fees_quote, t.mm_fees_quote))} detail={`and ${b(treasuryFees(t.fees_base, t.mm_fees_base))}`} />
        <Kpi
          label="Rules enforced"
          value={`${onchainRefusals + simulatedRefusals} refused`}
          detail={`${onchainRefusals} onchain · ${simulatedRefusals} simulated · ${t.defensive_fills} fills in defensive mode`}
        />
      </dl>

      {refusals.length > 0 && (
        <div className="space-y-1">
          <p className="text-sm font-medium">Refused, by rule</p>
          <ul className="flex flex-wrap gap-2 text-xs">
            {refusals.map((r) => (
              <li key={`${r.errorName}-${r.source}`} className="rounded-full border px-2.5 py-1">
                {clauseOf(r.errorName) ?? "Other"} · {r.count} {r.source === "simulated" ? "simulated" : "onchain"}
              </li>
            ))}
          </ul>
        </div>
      )}

      {trades.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Every trade{trades.length >= 500 ? " (newest 500)" : ""}</p>
            <Button size="sm" variant="outline" onClick={() => downloadCsv(trades, base, quote, subject)}>
              <Download /> Export CSV
            </Button>
          </div>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Trade</TableHead>
                  <TableHead>Trader</TableHead>
                  <TableHead className="text-right">{base.symbol}</TableHead>
                  <TableHead className="text-right">{quote.symbol}</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">vs market</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {trades.map((x) => {
                  const baseAmount = x.is_sell ? x.amount_out : x.amount_in;
                  const quoteAmount = x.is_sell ? x.amount_in : x.amount_out;
                  const url = txUrl(x.tx_hash);
                  return (
                    <TableRow key={`${x.tx_hash}:${x.log_index}`}>
                      <TableCell className="whitespace-nowrap text-xs">{formatChainTime(x.timestamp)}</TableCell>
                      <TableCell>{x.is_sell ? <span className="text-filled">Buy</span> : <span className="text-primary">Sell back</span>}</TableCell>
                      <TableCell className="font-mono text-xs" title={x.taker}>
                        {roleOf(x.taker) ?? short(getAddress(x.taker))}
                      </TableCell>
                      <TableCell className="text-right tabular">{formatUnits(baseAmount, base.decimals, 2)}</TableCell>
                      <TableCell className="text-right tabular">{formatUnits(quoteAmount, quote.decimals, 2)}</TableCell>
                      <TableCell className="text-right tabular">{formatPrice(x.price_x36, base.decimals, quote.decimals, 4)}</TableCell>
                      <TableCell className="text-right tabular">{bps(x.quality_bps)}</TableCell>
                      <TableCell>
                        <RiskBadge mode={x.risk_mode as RiskMode} />
                      </TableCell>
                      <TableCell>
                        {url && (
                          <a href={url} target="_blank" rel="noreferrer noopener" aria-label="Open the transaction on Basescan" title="Open on Basescan">
                            <ExternalLink className="size-3.5" />
                          </a>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular">{value}</dd>
      <dd className="text-xs text-muted-foreground">{detail}</dd>
    </div>
  );
}

/** The trade list as CSV with human amounts, built in the browser (nothing leaves it). */
function downloadCsv(trades: Insights["trades"], base: TokenDisplay, quote: TokenDisplay, subject: Subject) {
  const plain = (raw: string, decimals: number) => formatUnits(raw, decimals, decimals).replaceAll(",", "");
  const rows = [
    ["time_utc", "trade", "trader", base.symbol, quote.symbol, `price_${quote.symbol}_per_${base.symbol}`, "vs_market_bps", "risk_mode", "strategy", "tx"],
    ...trades.map((x) => [
      new Date(Number(x.timestamp) * 1000).toISOString(),
      x.is_sell ? "buy" : "sell_back",
      x.taker,
      plain(x.is_sell ? x.amount_out : x.amount_in, base.decimals),
      plain(x.is_sell ? x.amount_in : x.amount_out, quote.decimals),
      formatPrice(x.price_x36, base.decimals, quote.decimals, 6).replaceAll(",", ""),
      x.quality_bps === null ? "" : String(x.quality_bps),
      ["normal", "defensive", "paused"][x.risk_mode] ?? String(x.risk_mode),
      x.strategy_id,
      x.tx_hash,
    ]),
  ];
  const csv = rows.map((r) => r.join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `mandate-${subject.kind}-${subject.id.slice(0, 10)}-trades.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
