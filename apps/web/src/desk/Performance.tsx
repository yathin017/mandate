import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { useConnection } from "wagmi";

import { ScoreBadge, ScoreBreakdown } from "@/components/score";
import { RiskBadge, StatusPill } from "@/components/status";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatBps, formatCompact, formatUnits } from "@/lib/format";
import { useMmScores } from "@/lib/hooks";

/**
 * The market maker's own record: the onchain score with its evidence, and per strategy the volume, fills, execution
 * against the market, fees earned and still claimable, and trades the rails refused. Public data; no sign-in needed.
 */
export function Performance() {
  const { address } = useConnection();
  const me = address?.toLowerCase();
  const scores = useMmScores();
  const summary = useQuery({ queryKey: ["mm-summary", me], queryFn: () => api.mmSummary(me!), enabled: Boolean(me) });
  if (!me) return <p className="text-sm text-muted-foreground">Connect the wallet you make markets from.</p>;
  const score = scores.data?.data.scores.find((s) => s.mm === me);
  const rows = summary.data?.data ?? [];

  return (
    <div className="grid gap-6 xl:grid-cols-[340px_1fr]">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Your score <ScoreBadge score={score} className="text-base" />
          </CardTitle>
          <CardDescription>Last 30 days, from onchain activity only. Issuers see the same numbers.</CardDescription>
        </CardHeader>
        <CardContent>
          {score ? <ScoreBreakdown score={score} /> : <p className="text-sm text-muted-foreground">Your score starts with your first strategy.</p>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Strategies</CardTitle>
          <CardDescription>Your fixed share of the spread fees on every fill (quote on sells, base on buybacks); claim it from My strategies.</CardDescription>
        </CardHeader>
        <CardContent>
          {summary.isPending && <Skeleton className="h-32 w-full" />}
          {summary.data && rows.length === 0 && <p className="text-sm text-muted-foreground">No strategies yet.</p>}
          {rows.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Strategy</TableHead>
                  <TableHead className="text-right">Fills</TableHead>
                  <TableHead className="text-right">Volume</TableHead>
                  <TableHead className="text-right">Vs market</TableHead>
                  <TableHead className="text-right">You earned</TableHead>
                  <TableHead className="text-right">Claimable</TableHead>
                  <TableHead className="text-right">Refused</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((m) => {
                  const quote = m.tokens.quote ?? { symbol: "?", decimals: 18 };
                  const base = m.tokens.base ?? { symbol: "?", decimals: 18 };
                  // Sells pay fees in quote, buybacks in base; show base only when there is any.
                  const both = (q: bigint, b: bigint) => (
                    <>
                      <span className="block">
                        {formatUnits(q > 0n ? q : 0n, quote.decimals, 2)} {quote.symbol}
                      </span>
                      {b > 0n && (
                        <span className="block text-xs text-muted-foreground">
                          + {formatUnits(b, base.decimals, 2)} {base.symbol}
                        </span>
                      )}
                    </>
                  );
                  return (
                    <TableRow key={m.strategyId}>
                      <TableCell>
                        <Link to={`/strategies/${m.strategyId}`} className="flex items-center gap-2 whitespace-nowrap underline-offset-4 hover:underline">
                          {m.tokens.base?.symbol ?? "?"} / {quote.symbol} <StatusPill status={m.status} /> <RiskBadge mode={m.riskMode} reason={m.riskReason} />
                        </Link>
                      </TableCell>
                      <TableCell className="tabular text-right font-mono">{m.fills}</TableCell>
                      <TableCell className="tabular text-right font-mono">
                        {formatCompact(m.quoteVolume, quote.decimals)} <span className="text-xs text-muted-foreground">{quote.symbol}</span>
                      </TableCell>
                      <TableCell className="tabular text-right font-mono" title="Volume-weighted fill price against the Uniswap price before each fill; + favours the treasury">
                        {m.avgQualityBps === null ? "–" : `${m.avgQualityBps >= 0 ? "+" : "−"}${formatBps(Math.abs(Math.round(m.avgQualityBps)))}`}
                      </TableCell>
                      <TableCell className="tabular text-right font-mono">{both(BigInt(m.mmEarnedQuote), BigInt(m.mmEarnedBase))}</TableCell>
                      <TableCell className="tabular text-right font-mono">
                        {both(BigInt(m.mmEarnedQuote) - BigInt(m.claimedQuote), BigInt(m.mmEarnedBase) - BigInt(m.claimedBase))}
                      </TableCell>
                      <TableCell className="tabular text-right font-mono">{m.refused}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
