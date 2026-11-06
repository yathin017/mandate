import { Link } from "react-router";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Hex, StatusPill } from "@/components/status";
import { formatCompact } from "@/lib/format";
import { useMandates } from "@/lib/hooks";

export function MandateList() {
  const mandates = useMandates();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-3xl font-semibold tracking-tight">Mandates</h1>
        <p className="text-muted-foreground">Public pages. No wallet needed: every term and every refusal is visible.</p>
      </div>
      {mandates.isPending && <Skeleton className="h-40 w-full" />}
      {mandates.isError && <p className="text-blocked">Could not load mandates: {mandates.error.message}</p>}
      {mandates.data?.data.length === 0 && <p className="text-muted-foreground">No mandates indexed yet. Start the worker against a chain with mandates.</p>}
      <div className="grid gap-4 md:grid-cols-3">
        {mandates.data?.data.map((m) => {
          const base = m.tokens.base ?? { symbol: "TOKEN", decimals: 18 };
          return (
            <Link key={m.mandateId} to={`/mandates/${m.mandateId}`} className="group">
              <Card className="h-full transition-colors group-hover:border-primary/60">
                <CardHeader className="flex-row items-center justify-between space-y-0">
                  <CardTitle className="font-serif">
                    {base.symbol} / {m.tokens.quote?.symbol ?? "?"}
                  </CardTitle>
                  <StatusPill status={m.status} />
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div className="text-muted-foreground">
                    Safe <Hex value={m.safe} /> · MM <Hex value={m.mm} />
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Shipped of allotment</span>
                      <span className="tabular font-mono">
                        {formatCompact(m.params.shippedBase, base.decimals)} / {formatCompact(m.bounds.allotment, base.decimals)}
                      </span>
                    </div>
                    <Progress value={Number((BigInt(m.params.shippedBase) * 100n) / BigInt(m.bounds.allotment))} />
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
