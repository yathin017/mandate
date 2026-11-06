import { Ban, Radio } from "lucide-react";
import { useParams } from "react-router";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ActivityFeed } from "@/components/ActivityFeed";
import { PriceChart, ReleaseChart } from "@/components/charts";
import { RingGauge, Stat } from "@/components/gauges";
import { Hex, Source, StatusPill, SyntheticTag } from "@/components/status";
import { TermSheet } from "@/components/TermSheet";
import { TryTrade } from "@/components/TryTrade";
import { ApiError } from "@/lib/api";
import { formatBps, formatDuration, formatPrice, formatUnits, ratio } from "@/lib/format";
import { useMandate, useMandateStream, useSeries, type StreamState } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import type { MandateDetail, Snapshot, TokenDisplay } from "@/lib/types";

import { NotFound } from "./NotFound";

const FALLBACK_TOKEN: TokenDisplay = { symbol: "TOKEN", decimals: 18 };

export function MandatePage() {
  const { mandateId = "" } = useParams();
  const detail = useMandate(mandateId);
  const stream = useMandateStream(mandateId);

  if (detail.isPending) return <Skeleton className="h-96 w-full" />;
  if (detail.isError) {
    if (detail.error instanceof ApiError && detail.error.status < 500) return <NotFound message="No mandate with this id is indexed." />;
    return <p className="text-blocked">Could not load the mandate: {detail.error.message}</p>;
  }
  const { data } = detail.data;
  const base = data.tokens.base ?? FALLBACK_TOKEN;
  const quote = data.tokens.quote ?? FALLBACK_TOKEN;
  return <MandateView data={data} base={base} quote={quote} stream={stream} />;
}

function MandateView({ data, base, quote, stream }: { data: MandateDetail; base: TokenDisplay; quote: TokenDisplay; stream: StreamState }) {
  const { mandate, snapshot } = data;
  const series = useSeries(mandate.mandateId);
  const environment = data.chain?.environment;

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-serif text-3xl font-semibold tracking-tight">
            {base.symbol} / {quote.symbol} mandate
          </h1>
          <StatusPill status={mandate.status} />
          <LiveBadge state={stream} />
          {environment === "local-mainnet-fork" && <SyntheticTag label="LOCAL FORK · SYNTHETIC TOKENS" />}
          {environment === "live" && <SyntheticTag label="LIVE · MOCK TOKENS" />}
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
          <span>Issuer Safe <Hex value={mandate.safe} /></span>
          <span>Market maker <Hex value={mandate.mm} /></span>
          <span>Mandate <Hex value={mandate.mandateId} chars={6} /></span>
          {snapshot && <span className="tabular font-mono">as of block {snapshot.blockNumber}</span>}
        </div>
      </header>

      {mandate.status === 3 && (
        <Alert className="border-blocked/50">
          <Ban className="text-blocked" />
          <AlertTitle>Revoked by the issuer</AlertTitle>
          <AlertDescription>The strategy is docked and every fill is refused. The market maker can still claim fees it earned.</AlertDescription>
        </Alert>
      )}

      {snapshot ? <Gauges snapshot={snapshot} mandate={data} base={base} quote={quote} series={series.data?.data ?? []} /> : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <Card>
          <CardHeader>
            <CardTitle>Activity</CardTitle>
            <CardDescription>Every fill and every refused attempt, newest first.</CardDescription>
          </CardHeader>
          <CardContent>
            <ActivityFeed mandateId={mandate.mandateId} base={base} quote={quote} />
          </CardContent>
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Try a trade</CardTitle>
              <CardDescription>See whether the mandate would let it through.</CardDescription>
            </CardHeader>
            <CardContent>
              <TryTrade mandate={mandate} base={base} quote={quote} />
            </CardContent>
          </Card>
          <CannotDo />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="font-serif text-2xl">Terms</CardTitle>
          <CardDescription>The deal, as enforced. Only the issuer can change bounds; the fee share is fixed.</CardDescription>
        </CardHeader>
        <CardContent>
          <TermSheet mandate={mandate} base={base} quote={quote} />
        </CardContent>
      </Card>
    </div>
  );
}

function Gauges({ snapshot, mandate, base, quote, series }: { snapshot: Snapshot; mandate: MandateDetail; base: TokenDisplay; quote: TokenDisplay; series: Snapshot[] }) {
  const b = mandate.mandate.bounds;
  const cap = BigInt(snapshot.epochCap) < BigInt(b.maxEpochCap) ? snapshot.epochCap : b.maxEpochCap;
  const used = ratio(snapshot.netSoldThisEpoch, cap);
  const resetsIn = Number(snapshot.epochResetsAt) - Number(snapshot.timestamp);
  const src = (fn: string) => ({ block: snapshot.blockNumber, detail: `MandateQuoter.${fn}` });

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Today's sell limit</CardTitle>
          <CardDescription className="text-[11px]">epoch cap</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-center">
          <RingGauge value={used} label={`${Math.round(used * 100)}%`} sublabel="used" />
          <p className="text-sm">
            <Source {...src("epochState")}>
              <span className="tabular font-mono">{formatUnits(snapshot.netSoldThisEpoch, base.decimals, 0)}</span>
            </Source>{" "}
            / <span className="tabular font-mono">{formatUnits(cap, base.decimals, 0)}</span> {base.symbol}
          </p>
          <p className="text-xs text-muted-foreground">Resets in {formatDuration(resetsIn)}</p>
        </CardContent>
      </Card>

      <Card className="xl:col-span-2">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Unlocked vs sold</CardTitle>
          <CardDescription className="text-[11px]">release curve (dashed) vs cumulative net sold; sold stays under the curve</CardDescription>
        </CardHeader>
        <CardContent>
          {series.length > 1 ? <ReleaseChart series={series} base={base} /> : <Skeleton className="h-[220px]" />}
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label="Unlocked" value={<Source {...src("released")}>{formatUnits(snapshot.released, base.decimals, 0)}</Source>} />
            <Stat label="Net sold" value={formatUnits(snapshot.totalNetSold, base.decimals, 0)} />
            <Stat label="Sellable now" value={<Source {...src("sellableNow")}>{formatUnits(snapshot.sellableNow, base.decimals, 0)}</Source>} />
          </div>
        </CardContent>
      </Card>

      <AnchorCard snapshot={snapshot} base={base} quote={quote} />

      <Card className="md:col-span-2 xl:col-span-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Price, floor and anchor band</CardTitle>
          <CardDescription className="text-[11px]">Uniswap v4 spot and TWAP with the ±{formatBps(b.maxAnchorDeviationBps)} band; floor in red. Oracle history is synthetic.</CardDescription>
        </CardHeader>
        <CardContent>
          {series.length > 1 ? (
            <PriceChart series={series} base={base} quote={quote} floorX36={b.floorPriceX36} maxDeviationBps={Number(b.maxAnchorDeviationBps)} />
          ) : (
            <Skeleton className="h-[220px]" />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Market maker pay</CardTitle>
          <CardDescription className="text-[11px]">{formatBps(b.mmFeeShareBps)} of fees on real fills</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          <Stat label={`Fees (${quote.symbol})`} value={formatUnits(snapshot.feesQuote, quote.decimals)} />
          <Stat label={`Fees (${base.symbol})`} value={formatUnits(snapshot.feesBase, base.decimals)} />
          <Stat label={`Claimed (${quote.symbol})`} value={formatUnits(snapshot.claimedQuote, quote.decimals)} />
          <Stat label="Spread" value={formatBps(snapshot.spreadBps)} caption={`range ${formatBps(b.spreadBpsMin)}–${formatBps(b.spreadBpsMax)}`} />
        </CardContent>
      </Card>
    </div>
  );
}

function AnchorCard({ snapshot, base, quote }: { snapshot: Snapshot; base: TokenDisplay; quote: TokenDisplay }) {
  const ok = snapshot.anchorStatus === "within-spot-band";
  const unavailable = snapshot.anchorStatus === "unavailable";
  return (
    <Card className={cn(!ok && "border-blocked/50")}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Anchor health</CardTitle>
        <CardDescription className="text-[11px]">Uniswap v4 spot vs TWAP circuit breaker</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Badge className={cn("rounded-full", ok ? "bg-filled text-filled-foreground" : "bg-blocked text-blocked-foreground")}>
          {ok ? "In range" : unavailable ? "Unavailable: trading halted" : "Paused: price out of range"}
        </Badge>
        {!unavailable && (
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Spot" value={formatPrice(snapshot.anchorSpotX36!, base.decimals, quote.decimals)} />
            <Stat label="30m TWAP" value={formatPrice(snapshot.anchorTwapX36!, base.decimals, quote.decimals)} />
            <Stat label="Distance" value={formatBps(snapshot.anchorDeviationBps!)} caption={`limit ${formatBps(snapshot.anchorMaxDeviationBps ?? 0)}`} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CannotDo() {
  const items = ["Move tokens out of the Safe", "Raise the sell limit or lower the floor", "Swap in a different quoter", "Change its fee share", "Undo a revoke"];
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

function LiveBadge({ state }: { state: StreamState }) {
  return (
    <span className={cn("flex items-center gap-1.5 text-xs", state === "live" ? "text-filled" : "text-muted-foreground")}>
      <Radio className={cn("size-3.5", state === "live" && "animate-pulse")} />
      {state === "live" ? "Live" : state === "connecting" ? "Connecting…" : "Offline"}
    </span>
  );
}
