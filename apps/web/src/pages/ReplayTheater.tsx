import { CheckCircle2, Pause, Play, RotateCcw, StepForward } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BlockedStamp, Hex, SyntheticTag } from "@/components/status";
import { formatPrice, formatUnits } from "@/lib/format";
import { useReplay } from "@/lib/hooks";
import type { Replay, ReplayAct, ReplayState, ReplayStep } from "@/lib/replay";
import { cn } from "@/lib/utils";

const CLAUSE: Record<string, string> = {
  EpochCapReached: "Daily sell limit",
  ReleaseExceeded: "Release schedule",
  BelowFloor: "Price floor",
  AnchorDeviation: "Uniswap anchor",
  SpotTwapDivergence: "Manipulation guard",
  MandatePaused: "Mandate paused",
  MandateRevoked: "Mandate revoked",
  ParamsOutOfBounds: "Issuer bounds",
  NotModule: "Safe permissions",
  SafeCallFailed: "Safe permissions",
};

const isTraditional = (step: ReplayStep) => step.kind === "approval" || step.kind === "traditional-sell";

/**
 * Step-by-step playback of the committed demo receipts (served by the indexer at /v1/replay).
 * Every step is a real transaction on the local fork; tokens and oracle history are synthetic.
 */
export function ReplayTheater() {
  const replay = useReplay();
  const [actIndex, setActIndex] = useState(0);

  if (replay.isPending) return <Skeleton className="h-[600px] w-full" />;
  if (replay.isError) return <p className="text-blocked">Could not load the replay: {replay.error.message}</p>;
  const act = replay.data.acts[actIndex]!;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="font-serif text-3xl font-semibold tracking-tight">Replay theater</h1>
        <p className="max-w-2xl text-muted-foreground">
          The same sell intent, run twice: once with tokens handed to a market maker, once under a Mandate. Every
          step below is a confirmed transaction on a local fork of Ethereum mainnet.
        </p>
      </div>
      <Tabs value={String(actIndex)} onValueChange={(v) => setActIndex(Number(v))}>
        <TabsList className="h-auto flex-wrap">
          {replay.data.acts.map((a, i) => (
            <TabsTrigger key={a.act} value={String(i)}>
              Act {a.act}: {a.title}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <ActPlayer key={act.act} act={act} replay={replay.data} />
    </div>
  );
}

function ActPlayer({ act, replay }: { act: ReplayAct; replay: Replay }) {
  const [position, setPosition] = useState(0); // number of steps shown
  const [playing, setPlaying] = useState(false);
  const total = act.steps.length;
  // Long acts (150 repeated intents) play faster so the story fits a demo.
  const interval = total > 40 ? 90 : 900;

  useEffect(() => {
    if (!playing) return;
    if (position >= total) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setPosition((p) => p + 1), interval);
    return () => clearTimeout(timer);
  }, [playing, position, total, interval]);

  const shown = act.steps.slice(0, position);
  const current = shown.at(-1);
  const state = current?.state ?? act.initialState;
  const { base, quote } = replay.tokens;
  const hasTraditional = act.steps.some(isTraditional);

  return (
    <div className="space-y-6">
      <Alert className="border-warning/50">
        <AlertTitle className="flex items-center gap-2">
          <SyntheticTag label={act.label} /> Modeled scenario
        </AlertTitle>
        <AlertDescription>{act.disclosure}</AlertDescription>
      </Alert>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => (position >= total ? (setPosition(0), setPlaying(true)) : setPlaying(!playing))}>
          {playing ? <Pause /> : <Play />} {playing ? "Pause" : position >= total ? "Replay" : "Run"}
        </Button>
        <Button variant="outline" onClick={() => setPosition((p) => Math.min(p + 1, total))} disabled={playing || position >= total}>
          <StepForward /> Step
        </Button>
        <Button variant="ghost" onClick={() => { setPlaying(false); setPosition(0); }}>
          <RotateCcw /> Reset
        </Button>
        <span className="tabular ml-auto font-mono text-sm text-muted-foreground">
          step {position} / {total}
        </span>
      </div>

      {current && <CurrentStep step={current} />}

      <div className={cn("grid gap-4", hasTraditional && "lg:grid-cols-2")}>
        {hasTraditional && (
          <Side title="Traditional loan" subtitle="Tokens moved to the MM's wallet on day one" tone="bad">
            <Holding label="MM wallet holds" raw={state.traditionalBase} token={base} />
            <Holding label="Treasury tokens remaining" raw="0" token={base} />
            <PriceLine label="Pool price" x36={state.traditionalSpotX36} initial={act.initialState.traditionalSpotX36} base={base} quote={quote} />
          </Side>
        )}
        <Side title="Mandate" subtitle="Tokens stay in the issuer Safe; every fill is checked" tone="good">
          <Holding label="Treasury tokens remaining" raw={state.safeBase} token={base} />
          <Holding label="Sold this epoch" raw={state.epochNetSold} token={base} caption={`of ${formatUnits(act.epochCap, base.decimals, 0)} cap`} />
          <PriceLine label="Uniswap price" x36={state.v4SpotX36} initial={act.initialState.v4SpotX36} base={base} quote={quote} />
        </Side>
      </div>

      <PriceHistory act={act} steps={shown} showTraditional={hasTraditional} base={base} quote={quote} />
      <Damage act={act} steps={shown} state={state} showTraditional={hasTraditional} base={base} />
      <Timeline steps={shown} />
    </div>
  );
}

function CurrentStep({ step }: { step: ReplayStep }) {
  const blocked = step.outcome === "blocked";
  return (
    <Card key={step.step} className={cn("animate-in fade-in", blocked && "border-blocked/50 bg-blocked/5")}>
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center">
        {blocked ? (
          <BlockedStamp clause={CLAUSE[step.error?.name ?? ""] ?? step.error?.name} className="shrink-0" />
        ) : (
          <CheckCircle2 className="size-6 shrink-0 text-filled" />
        )}
        <div className="space-y-1">
          <p className="font-medium">{step.label}</p>
          {blocked && <p className="text-sm text-muted-foreground">{step.error?.message}</p>}
          <p className="tabular font-mono text-[11px] text-muted-foreground">
            block {step.blockNumber} · tx <Hex value={step.transactionHash} /> · {isTraditional(step) ? "traditional side" : "mandate side"}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function Side({ title, subtitle, tone, children }: { title: string; subtitle: string; tone: "good" | "bad"; children: React.ReactNode }) {
  return (
    <Card className={tone === "good" ? "border-filled/40" : "border-blocked/30"}>
      <CardHeader>
        <CardTitle className="font-serif text-xl">{title}</CardTitle>
        <CardDescription>{subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3">{children}</CardContent>
    </Card>
  );
}

function Holding({ label, raw, token, caption }: { label: string; raw: string; token: { symbol: string; decimals: number }; caption?: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="tabular font-mono text-lg font-semibold">{formatUnits(raw, token.decimals, 0)}</div>
      <div className="text-[11px] text-muted-foreground">{caption ?? token.symbol}</div>
    </div>
  );
}

function PriceLine({ label, x36, initial, base, quote }: { label: string; x36: string; initial: string; base: { decimals: number }; quote: { decimals: number; symbol: string } }) {
  const change = Number(((BigInt(x36) - BigInt(initial)) * 10_000n) / BigInt(initial)) / 100;
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="tabular font-mono text-lg font-semibold">{formatPrice(x36, base.decimals, quote.decimals)}</div>
      <div className={cn("tabular text-[11px]", change < -5 ? "text-blocked" : "text-muted-foreground")}>
        {change >= 0 ? "+" : ""}
        {change.toFixed(1)}% · {quote.symbol}
      </div>
    </div>
  );
}

function PriceHistory({ act, steps, showTraditional, base, quote }: { act: ReplayAct; steps: ReplayStep[]; showTraditional: boolean; base: { decimals: number }; quote: { decimals: number; symbol: string } }) {
  const data = useMemo(() => {
    const p = (x36: string) => Number(formatPrice(x36, base.decimals, quote.decimals, 6).replaceAll(",", ""));
    return [{ state: act.initialState, i: 0 }, ...steps.map((s, i) => ({ state: s.state, i: i + 1 }))].map(({ state, i }) => ({
      i,
      traditional: p(state.traditionalSpotX36),
      mandate: p(state.v4SpotX36),
      twap: p(state.twapX36),
    }));
  }, [act, steps, base.decimals, quote.decimals]);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Price path</CardTitle>
        <CardDescription className="text-[11px]">{showTraditional ? "Traditional pool vs the Mandate anchor pool" : "Uniswap v4 spot and 30-minute TWAP"} · synthetic history</CardDescription>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="i" type="number" domain={[0, act.steps.length]} stroke="var(--muted-foreground)" fontSize={11} tickLine={false} axisLine={false} />
            <YAxis width={52} domain={[0, "auto"]} stroke="var(--muted-foreground)" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v: number) => v.toFixed(2)} />
            <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} formatter={(v, name) => [`${Number(v).toFixed(4)} ${quote.symbol}`, String(name)]} labelFormatter={(l) => `step ${l}`} />
            {showTraditional && <Line dataKey="traditional" name="Traditional pool" stroke="var(--blocked)" dot={false} isAnimationActive={false} />}
            <Line dataKey="mandate" name="Uniswap spot" stroke="var(--chart-1)" dot={false} isAnimationActive={false} />
            {!showTraditional && <Line dataKey="twap" name="30m TWAP" stroke="var(--chart-2)" strokeDasharray="4 3" dot={false} isAnimationActive={false} />}
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

function Damage({ act, steps, state, showTraditional, base }: { act: ReplayAct; steps: ReplayStep[]; state: ReplayState; showTraditional: boolean; base: { decimals: number; symbol: string } }) {
  const dumped = BigInt(act.initialState.traditionalBase) - BigInt(state.traditionalBase);
  const crash = Number(((BigInt(state.traditionalSpotX36) - BigInt(act.initialState.traditionalSpotX36)) * 10_000n) / BigInt(act.initialState.traditionalSpotX36)) / 100;
  const blocked = steps.filter((s) => s.outcome === "blocked").length;
  return (
    <div className={cn("grid gap-4", showTraditional ? "md:grid-cols-2" : "md:grid-cols-1")}>
      {showTraditional && (
        <Card className="border-blocked/30">
          <CardContent className="grid grid-cols-2 gap-4">
            <Figure label="Tokens dumped" value={`${formatUnits(dumped, base.decimals, 0)} ${base.symbol}`} bad={dumped > 0n} />
            <Figure label="Price impact" value={`${crash.toFixed(1)}%`} bad={crash < -5} />
          </CardContent>
        </Card>
      )}
      <Card className="border-filled/40">
        <CardContent className="grid grid-cols-2 gap-4">
          <Figure label="Net sold under Mandate" value={`${formatUnits(state.totalNetSold, base.decimals, 0)} ${base.symbol}`} />
          <Figure label="Attempts refused" value={String(blocked)} />
        </CardContent>
      </Card>
    </div>
  );
}

function Figure({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("tabular font-mono text-xl font-semibold", bad && "text-blocked")}>{value}</div>
    </div>
  );
}

function Timeline({ steps }: { steps: ReplayStep[] }) {
  if (!steps.length) return null;
  const recent = steps.slice(-12).reverse();
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Steps so far</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y text-sm">
          {recent.map((s) => (
            <li key={s.step} className="flex items-center gap-3 py-2">
              <span className="tabular w-10 font-mono text-xs text-muted-foreground">#{s.step}</span>
              <span className="flex-1">{s.label}</span>
              {s.outcome === "blocked" ? (
                <span className="text-xs font-semibold text-blocked uppercase">Blocked</span>
              ) : (
                <span className="text-xs text-filled">Filled</span>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
