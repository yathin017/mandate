import { Link } from "react-router";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Hex, StatusPill } from "@/components/status";
import { formatBps, formatCompact } from "@/lib/format";
import type { StrategyListItem } from "@/lib/types";

/** Grid of strategy summary cards linking to their public pages. */
export function StrategyCards({ strategies }: { strategies: readonly StrategyListItem[] }) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {strategies.map((s) => {
        const base = s.tokens.base ?? { symbol: "TOKEN", decimals: 18 };
        const quote = s.tokens.quote ?? { symbol: "?", decimals: 18 };
        return (
          <Link key={s.strategyId} to={`/strategies/${s.strategyId}`} className="group">
            <Card className="h-full transition-colors group-hover:border-primary/60">
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle className="font-serif">
                  {base.symbol} / {quote.symbol}
                </CardTitle>
                <StatusPill status={s.status} />
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="text-muted-foreground">
                  {s.kind === 1 ? "Buyback" : "Market making"} · Safe <Hex value={s.safe} /> · MM <Hex value={s.mm} />
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Spread {formatBps(s.params.spreadBps)}</span>
                  <span className="tabular font-mono">
                    {formatCompact(s.params.shippedBase, base.decimals)} {base.symbol} · {formatCompact(s.params.shippedQuote, quote.decimals)} {quote.symbol}
                  </span>
                </div>
              </CardContent>
            </Card>
          </Link>
        );
      })}
    </div>
  );
}
