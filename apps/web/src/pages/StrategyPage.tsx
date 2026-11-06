import { Ban, Radio } from "lucide-react";
import { Link, useParams } from "react-router";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ActivityFeed } from "@/components/ActivityFeed";
import { Stat } from "@/components/gauges";
import { PolicyGauges } from "@/components/PolicyGauges";
import { Hex, RiskBadge, StatusPill, SyntheticTag } from "@/components/status";
import { PolicySheet, StrategySheet } from "@/components/TermSheet";
import { TryTrade } from "@/components/TryTrade";
import { ApiError } from "@/lib/api";
import { formatBps, formatUnits } from "@/lib/format";
import { useLiveStream, usePolicySeries, useStrategy, type StreamState } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import type { StrategyDetail, TokenDisplay } from "@/lib/types";

import { NotFound } from "./NotFound";

const FALLBACK_TOKEN: TokenDisplay = { symbol: "TOKEN", decimals: 18 };

/** One strategy's public page: its treasury's limits and market reading, its own pay and activity, and its terms. */
export function StrategyPage() {
  const { strategyId = "" } = useParams();
  const detail = useStrategy(strategyId);
  const stream = useLiveStream(strategyId ? { kind: "strategy", id: strategyId } : undefined);
  // The policy's readings (shared limits, risk mode) change with every strategy's fills.
  useLiveStream(detail.data?.data.strategy.policyId ? { kind: "policy", id: detail.data.data.strategy.policyId } : undefined);

  if (detail.isPending) return <Skeleton className="h-96 w-full" />;
  if (detail.isError) {
    if (detail.error instanceof ApiError && detail.error.status < 500) return <NotFound message="No strategy with this id is indexed." />;
    return <p className="text-blocked">Could not load the strategy: {detail.error.message}</p>;
  }
  const { data } = detail.data;
  return <StrategyView data={data} base={data.tokens.base ?? FALLBACK_TOKEN} quote={data.tokens.quote ?? FALLBACK_TOKEN} stream={stream} />;
}

function StrategyView({ data, base, quote, stream }: { data: StrategyDetail; base: TokenDisplay; quote: TokenDisplay; stream: StreamState }) {
  const { strategy, snapshot, policy, policySnapshot } = data;
  const series = usePolicySeries(strategy.policyId);
  const environment = data.chain?.environment;
  const revoked = strategy.status === 3 || policy?.status === 3;

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-serif text-3xl font-semibold tracking-tight">
            {base.symbol} / {quote.symbol} {strategy.kind === 1 ? "buyback" : "market making"}
          </h1>
          <StatusPill status={strategy.status} />
          <RiskBadge mode={policySnapshot?.riskMode} reason={policySnapshot?.riskReason} />
          <LiveBadge state={stream} />
          {environment === "local-mainnet-fork" && <SyntheticTag label="LOCAL FORK · SYNTHETIC TOKENS" />}
          {environment === "live" && <SyntheticTag label="LIVE · MOCK TOKENS" />}
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
          <span>Issuer Safe <Hex value={strategy.safe} /></span>
          <span>Market maker <Link to={`/market-makers/${strategy.mm}`} className="hover:text-foreground"><Hex value={strategy.mm} /></Link></span>
          <span>Policy <Link to={`/policies/${strategy.policyId}`} className="hover:text-foreground"><Hex value={strategy.policyId} chars={6} /></Link></span>
          {snapshot && <span className="tabular font-mono">as of block {snapshot.blockNumber}</span>}
        </div>
      </header>

      {revoked && (
        <Alert className="border-blocked/50">
          <Ban className="text-blocked" />
          <AlertTitle>Revoked by the issuer</AlertTitle>
          <AlertDescription>The strategy is docked and every fill is refused. The market maker can still claim fees it earned.</AlertDescription>
        </Alert>
      )}
      {!revoked && policy?.status === 2 && (
        <Alert className="border-warning/50">
          <AlertTitle>Treasury policy paused</AlertTitle>
          <AlertDescription>The issuer paused every strategy of this treasury. Only the issuer can resume.</AlertDescription>
        </Alert>
      )}

      {policy && policySnapshot && <PolicyGauges snapshot={policySnapshot} config={policy.config} base={base} quote={quote} series={series.data?.data ?? []} />}

      {snapshot && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">This strategy</CardTitle>
            <CardDescription className="text-[11px]">{formatBps(strategy.bounds.mmFeeShareBps)} of its fees go to the market maker</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Spread" value={formatBps(snapshot.spreadBps)} caption={`range ${formatBps(strategy.bounds.spreadBpsMin)}–${formatBps(strategy.bounds.spreadBpsMax)}`} />
            <Stat label={`Inventory (${base.symbol})`} value={formatUnits(snapshot.shippedBase, base.decimals, 0)} caption="as last shipped" />
            <Stat label={`Inventory (${quote.symbol})`} value={formatUnits(snapshot.shippedQuote, quote.decimals, 0)} caption="as last shipped" />
            <Stat label={`Fees (${quote.symbol})`} value={formatUnits(snapshot.feesQuote, quote.decimals)} />
            <Stat label={`Fees (${base.symbol})`} value={formatUnits(snapshot.feesBase, base.decimals)} />
            <Stat label="Version" value={snapshot.nonce} caption="ships so far" />
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <Card>
          <CardHeader>
            <CardTitle>Activity</CardTitle>
            <CardDescription>Every fill and every refused attempt, newest first.</CardDescription>
          </CardHeader>
          <CardContent>
            <ActivityFeed subject={{ kind: "strategy", id: strategy.strategyId }} base={base} quote={quote} />
          </CardContent>
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Try a trade</CardTitle>
              <CardDescription>See whether the strategy would let it through.</CardDescription>
            </CardHeader>
            <CardContent>
              <TryTrade strategy={strategy} base={base} quote={quote} />
            </CardContent>
          </Card>
          <CannotDo />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="font-serif text-2xl">Strategy terms</CardTitle>
          <CardDescription>The market maker's rails. Only the issuer can change them; the fee share is fixed.</CardDescription>
        </CardHeader>
        <CardContent>
          <StrategySheet strategy={strategy} base={base} quote={quote} />
        </CardContent>
      </Card>
      {policy && (
        <Card>
          <CardHeader>
            <CardTitle className="font-serif text-2xl">Treasury policy</CardTitle>
            <CardDescription>The issuer's limits for every strategy of this treasury.</CardDescription>
          </CardHeader>
          <CardContent>
            <PolicySheet config={policy.config} base={base} quote={quote} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function CannotDo() {
  const items = ["Move tokens out of the Safe", "Ship tokens the Safe does not hold", "Exceed or reset the treasury's limits", "Change its fee share", "Undo a revoke"];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">What the market maker can't do</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2 text-sm">
          {items.map((item) => (
            <li key={item} className="flex items-center gap-2">
              <Ban className="size-4 shrink-0 text-blocked" /> {item}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function LiveBadge({ state }: { state: StreamState }) {
  return (
    <span className={cn("flex items-center gap-1.5 text-xs", state === "live" ? "text-filled" : "text-muted-foreground")}>
      <Radio className={cn("size-3.5", state === "live" && "animate-pulse")} />
      {state === "live" ? "Live" : state === "connecting" ? "Connecting…" : "Offline"}
    </span>
  );
}
