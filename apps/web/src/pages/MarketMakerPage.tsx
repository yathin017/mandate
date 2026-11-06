import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { Link, useParams } from "react-router";
import { isAddress } from "viem";

import { MandateCards } from "@/components/MandateCards";
import { ScoreBadge, ScoreBreakdown } from "@/components/score";
import { Hex } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError } from "@/lib/api";
import { qk, useMmScores } from "@/lib/hooks";
import { formatChainTime } from "@/lib/format";

/** One market maker: self-written profile, onchain score with its evidence, and its mandates. */
export function MarketMakerPage() {
  const address = (useParams().address ?? "").toLowerCase();
  const valid = isAddress(address);
  const profile = useQuery({
    queryKey: qk.mmProfile(address),
    queryFn: async () => {
      try {
        return (await api.mmProfile(address)).data;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: valid,
  });
  const scores = useMmScores();
  const mandates = useQuery({ queryKey: ["mandates", "mm", address], queryFn: () => api.mandatesByMm(address), enabled: valid });
  const score = scores.data?.data.scores.find((s) => s.mm === address);

  if (!valid) return <p className="text-blocked">Not a valid address.</p>;
  if (profile.isPending) return <Skeleton className="h-64 w-full" />;
  const p = profile.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-serif text-3xl font-semibold tracking-tight">{p?.displayName ?? "Unlisted market maker"}</h1>
          <p className="text-sm text-muted-foreground">
            <Hex value={address} chars={6} />
            {p && !p.listed && <span> · not listed in the marketplace</span>}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ScoreBadge score={score} className="px-3 py-1 text-lg" />
          <Button asChild>
            <Link to={`/launch?mm=${address}`}>Propose a mandate</Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>Written by the market maker.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {!p && <p className="text-muted-foreground">This address has not published a profile.</p>}
            {p?.bio && <p className="whitespace-pre-line">{p.bio}</p>}
            {p && p.coverage.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {p.coverage.map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
            {p?.minDealUsd != null && <p>Minimum deal: ${p.minDealUsd.toLocaleString("en")}</p>}
            {p?.contact && <p>Contact: {p.contact}</p>}
            {p?.website && (
              <a href={p.website} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 underline underline-offset-4">
                {new URL(p.website).host} <ExternalLink className="size-3" />
              </a>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Onchain score</CardTitle>
            <CardDescription>
              {score ? `Last 30 days to ${formatChainTime(score.window.to)}.` : "No mandates on this chain yet."}
            </CardDescription>
          </CardHeader>
          <CardContent>{score ? <ScoreBreakdown score={score} /> : <p className="text-sm text-muted-foreground">Scores start with the first mandate.</p>}</CardContent>
        </Card>
      </div>

      <section className="space-y-3">
        <h2 className="font-serif text-xl font-semibold">Mandates</h2>
        {mandates.data?.data.length ? <MandateCards mandates={mandates.data.data} /> : <p className="text-sm text-muted-foreground">None yet.</p>}
      </section>
    </div>
  );
}
