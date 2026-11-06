import { useParams } from "react-router";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ActivityFeed } from "@/components/ActivityFeed";
import { PolicyGauges } from "@/components/PolicyGauges";
import { Hex, RiskBadge, StatusPill, SyntheticTag } from "@/components/status";
import { StrategyCards } from "@/components/StrategyCards";
import { PolicySheet } from "@/components/TermSheet";
import { ApiError } from "@/lib/api";
import { useLiveStream, usePolicy, usePolicySeries } from "@/lib/hooks";
import type { TokenDisplay } from "@/lib/types";

import { NotFound } from "./NotFound";
import { LiveBadge } from "./StrategyPage";

const FALLBACK_TOKEN: TokenDisplay = { symbol: "TOKEN", decimals: 18 };

/** A treasury policy's public page: its shared limits, market reading, every strategy under it and their activity. */
export function PolicyPage() {
  const { policyId = "" } = useParams();
  const detail = usePolicy(policyId);
  const series = usePolicySeries(policyId);
  const stream = useLiveStream(policyId ? { kind: "policy", id: policyId } : undefined);

  if (detail.isPending) return <Skeleton className="h-96 w-full" />;
  if (detail.isError) {
    if (detail.error instanceof ApiError && detail.error.status < 500) return <NotFound message="No policy with this id is indexed." />;
    return <p className="text-blocked">Could not load the policy: {detail.error.message}</p>;
  }
  const { policy, snapshot, strategies, tokens, chain } = detail.data.data;
  const base = tokens.base ?? FALLBACK_TOKEN;
  const quote = tokens.quote ?? FALLBACK_TOKEN;

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-serif text-3xl font-semibold tracking-tight">{base.symbol} treasury policy</h1>
          <StatusPill status={policy.status} />
          <RiskBadge mode={snapshot?.riskMode} reason={snapshot?.riskReason} />
          <LiveBadge state={stream} />
          {chain?.environment === "local-mainnet-fork" && <SyntheticTag label="LOCAL FORK · SYNTHETIC TOKENS" />}
          {chain?.environment === "live" && <SyntheticTag label="LIVE · MOCK TOKENS" />}
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
          <span>Issuer Safe <Hex value={policy.safe} /></span>
          <span>Quote {quote.symbol} <Hex value={policy.quote} /></span>
          <span>Policy <Hex value={policy.policyId} chars={6} /></span>
          {snapshot && <span className="tabular font-mono">as of block {snapshot.blockNumber}</span>}
        </div>
      </header>

      {snapshot && <PolicyGauges snapshot={snapshot} config={policy.config} base={base} quote={quote} series={series.data?.data ?? []} />}

      <section className="space-y-3">
        <h2 className="font-serif text-xl font-semibold">Strategies</h2>
        {strategies.length ? (
          <StrategyCards strategies={strategies.map((s) => ({ ...s, tokens }))} />
        ) : (
          <p className="text-sm text-muted-foreground">No strategies yet.</p>
        )}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Activity</CardTitle>
          <CardDescription>Fills and refused attempts across every strategy of this treasury, newest first.</CardDescription>
        </CardHeader>
        <CardContent>
          <ActivityFeed subject={{ kind: "policy", id: policy.policyId }} base={base} quote={quote} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="font-serif text-2xl">Terms</CardTitle>
          <CardDescription>Set by the issuer's Safe; every strategy of the treasury runs inside them.</CardDescription>
        </CardHeader>
        <CardContent>
          <PolicySheet config={policy.config} base={base} quote={quote} />
        </CardContent>
      </Card>
    </div>
  );
}
