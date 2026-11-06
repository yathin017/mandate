import { Link } from "react-router";

import { ScoreBadge } from "@/components/score";
import { Hex } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useMmProfiles, useMmScores } from "@/lib/hooks";
import type { MmScore } from "@/lib/types";

/**
 * The marketplace: listed market makers with their onchain score. Profiles are self-written; scores come only from
 * indexed chain activity, so a market maker cannot write its own performance.
 */
export function MarketMakers() {
  const profiles = useMmProfiles();
  const scores = useMmScores();
  const scoreOf = new Map((scores.data?.data.scores ?? []).map((s) => [s.mm, s] as const));
  const rank = (s: MmScore | undefined) => s?.score ?? -1;
  const listed = [...(profiles.data?.data ?? [])].sort((a, b) => rank(scoreOf.get(b.address)) - rank(scoreOf.get(a.address)));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl font-semibold tracking-tight">Market makers</h1>
          <p className="max-w-2xl text-muted-foreground">
            Scores are computed from onchain behaviour only: quoting inside the price band, fill quality, volume, kept
            mandates and how fast problems are fixed.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/desk">List your desk</Link>
        </Button>
      </div>
      {profiles.isPending && <Skeleton className="h-40 w-full" />}
      {profiles.isError && <p className="text-blocked">Could not load market makers: {profiles.error.message}</p>}
      {profiles.data?.data.length === 0 && <p className="text-muted-foreground">No market makers listed yet.</p>}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {listed.map((p) => (
          <Link key={p.address} to={`/market-makers/${p.address}`} className="group">
            <Card className="h-full transition-colors group-hover:border-primary/60">
              <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
                <div className="min-w-0">
                  <CardTitle className="truncate font-serif">{p.displayName}</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    <Hex value={p.address} />
                  </p>
                </div>
                <ScoreBadge score={scoreOf.get(p.address)} className="text-sm" />
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {p.bio && <p className="line-clamp-3 text-muted-foreground">{p.bio}</p>}
                <div className="flex flex-wrap gap-1">
                  {p.coverage.map((tag) => (
                    <Badge key={tag} variant="secondary">
                      {tag}
                    </Badge>
                  ))}
                </div>
                {p.minDealUsd !== null && <p className="text-xs text-muted-foreground">Min. deal ${p.minDealUsd.toLocaleString("en")}</p>}
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
