import {
  buildPausePolicyCall,
  buildPauseStrategyCall,
  buildRevokePolicyCall,
  buildRevokeStrategyCall,
  buildUnpausePolicyCall,
  buildUnpauseStrategyCall,
  safeAbi,
  type PreparedCall,
} from "@mandate/sdk";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { getAddress, isAddress, type Address, type Hash } from "viem";
import { useConnection, useReadContract } from "wagmi";

import { ScoreBadge } from "@/components/score";
import { Hex, RiskBadge, StatusPill } from "@/components/status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { IssuerDirectory } from "@/issuer/Directory";
import { PolicyForm } from "@/issuer/PolicyForm";
import { policyToTerms } from "@/issuer/policy";
import { ProposalList } from "@/issuer/ProposalList";
import { api } from "@/lib/api";
import { formatBps, formatCompact, formatDuration, formatUnits } from "@/lib/format";
import { useMmProfiles, useMmScores } from "@/lib/hooks";
import type { PolicySummary, StrategySummary, TokenDisplay } from "@/lib/types";
import { ACCOUNT_HELP, DEMO_SAFES, demoChain, deployment, roleOf } from "@/wallet/config";
import { SafeActionPanel } from "@/wallet/SafeActionPanel";
import { useSafeInfo } from "@/wallet/useSafe";

const FALLBACK: TokenDisplay = { symbol: "TOKEN", decimals: 18 };

/**
 * Issuer console: first the connected wallet's directory (every Safe it owns, each token, pool and policy), then one
 * treasury Safe at a glance. Per token, its policy (shared limits used this period, release, the
 * market risk mode) and the strategies running under it, proposals waiting on market makers or ready to execute,
 * and the owner actions (edit the policy, pause, unpause, revoke), each a Safe transaction approved onchain. New
 * policies and strategies start in the launch wizard.
 */
export function IssuerConsole() {
  // ?safe=0x… (from the wizard or a shared link) selects a Safe that is not a demo Safe.
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get("safe");
  const [typed, setTyped] = useState(fromUrl ?? "");
  const safe = (fromUrl && isAddress(fromUrl) ? fromUrl : DEMO_SAFES[0]!.address) as Address;
  const choose = (value: string) => {
    const next = new URLSearchParams(params);
    if (isAddress(value)) next.set("safe", value);
    else next.delete("safe");
    setParams(next, { replace: true });
  };

  const { address } = useConnection();
  const info = useSafeInfo(safe);
  const moduleEnabled = useReadContract({ address: safe, abi: safeAbi, functionName: "isModuleEnabled", args: [deployment.module], chainId: demoChain.id });
  const summary = useQuery({ queryKey: ["safe-summary", safe.toLowerCase()], queryFn: () => api.safeSummary(safe) });
  const rows = summary.data?.data ?? [];
  const isOwner = Boolean(address && info.owners?.some((o) => o.toLowerCase() === address.toLowerCase()));
  const tokenOf = (base: string, quote: string) => {
    const row = rows.find((r) => r.base === base && r.quote === quote);
    return row ? { base: row.tokens.base ?? FALLBACK, quote: row.tokens.quote ?? FALLBACK } : undefined;
  };
  const newStrategy = (row?: PolicySummary) => (row ? `/launch?safe=${safe}&base=${row.base}&quote=${row.quote}` : `/launch?safe=${safe}`);
  const live = rows.filter((r) => r.status !== 3);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl font-semibold tracking-tight">Issuer</h1>
          <p className="text-muted-foreground">Your treasury Safe: its policies, the strategies under them, and proposals. Owners approve every action onchain.</p>
        </div>
        <Button asChild>
          <Link to={newStrategy(live[0])}>
            <Plus /> {live.length ? "New strategy" : "Set up a treasury"}
          </Link>
        </Button>
      </div>

      <IssuerDirectory
        owner={params.get("owner") && isAddress(params.get("owner")!) ? (params.get("owner") as Address) : undefined}
        onManage={(selected) => {
          setTyped(selected);
          choose(selected);
          document.getElementById("manage-safe")?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
      />

      <h2 id="manage-safe" className="scroll-mt-20 text-xl font-semibold">Manage a Safe</h2>
      <Card>
        <CardContent className="grid gap-6 pt-6 md:grid-cols-[1fr_1fr]">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="safe-address">Safe address</Label>
              <div className="flex gap-2">
                <Input id="safe-address" className="font-mono" placeholder="0x…" value={typed} onChange={(e) => setTyped(e.target.value.trim())} />
                <Button variant="outline" disabled={!isAddress(typed)} onClick={() => choose(typed)}>
                  Open
                </Button>
              </div>
            </div>
            {DEMO_SAFES.length > 0 && (
              <div className="space-y-1.5">
                <Label>Or a demo Safe</Label>
                <Select
                  value={DEMO_SAFES.some((s) => s.address === safe) ? safe : ""}
                  onValueChange={(v) => {
                    setTyped(v);
                    choose(v);
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose…" />
                  </SelectTrigger>
                  <SelectContent>
                    {DEMO_SAFES.map((s) => (
                      <SelectItem key={s.address} value={s.address}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div className="space-y-2 text-sm">
            <p>
              Safe <Hex value={safe} chars={6} /> · {info.threshold?.toString() ?? "…"} of {info.owners?.length ?? "…"} owners
            </p>
            <ul className="space-y-1">
              {info.owners?.map((o) => (
                <li key={o}>
                  <Hex value={o} />
                  {roleOf(o) && <span className="ml-2 text-xs text-muted-foreground">{roleOf(o)}</span>}
                  {address && o.toLowerCase() === address.toLowerCase() && <span className="ml-2 text-xs text-filled">you</span>}
                </li>
              ))}
            </ul>
            <p>
              Mandate module:{" "}
              {moduleEnabled.data === undefined ? "…" : moduleEnabled.data ? <span className="text-filled">enabled</span> : <span className="text-blocked">not enabled</span>}
            </p>
            {info.error && <p className="text-blocked">Could not read this Safe from the chain RPC.</p>}
          </div>
        </CardContent>
      </Card>

      {!isOwner && (
        <Alert>
          <AlertTitle>Connect a Safe owner to act</AlertTitle>
          <AlertDescription>{ACCOUNT_HELP}</AlertDescription>
        </Alert>
      )}

      <Overview rows={rows} loading={summary.isPending} />

      <Card>
        <CardHeader>
          <CardTitle>Proposals</CardTitle>
          <CardDescription>Strategies offered to market makers. Once one signs, the owners add it here.</CardDescription>
        </CardHeader>
        <CardContent>
          <ProposalList safe={safe} tokens={(p) => tokenOf(p.base, p.quote)} onExecuted={() => void summary.refetch()} />
        </CardContent>
      </Card>

      {summary.isPending && <Skeleton className="h-32 w-full" />}
      {summary.isError && <p className="text-sm text-blocked">Could not load the treasury: {summary.error.message}</p>}
      {summary.data && rows.length === 0 && (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No treasury policy yet.{" "}
            <Link to={newStrategy()} className="underline underline-offset-4">
              Set one up and propose a strategy to a market maker
            </Link>
            .
          </CardContent>
        </Card>
      )}
      {rows.map((p) => (
        <PolicyCard key={p.policyId} safe={safe} policy={p} isOwner={isOwner} addStrategy={newStrategy(p)} />
      ))}
    </div>
  );
}

/** Safe-wide counts across its policies' strategies; amounts are per token, so they stay on the policy cards. */
function Overview({ rows, loading }: { rows: readonly PolicySummary[]; loading: boolean }) {
  if (loading) return <Skeleton className="h-24 w-full" />;
  const strategies = rows.flatMap((r) => r.strategies);
  const stats = [
    { label: "Live strategies", value: strategies.filter((s) => s.status === 1).length },
    { label: "Paused", value: strategies.filter((s) => s.status === 2).length },
    { label: "Fills", value: strategies.reduce((n, s) => n + s.fills, 0) },
    { label: "Refused trades", value: strategies.reduce((n, s) => n + s.refused, 0), hint: "Trades the rails stopped" },
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {stats.map((s) => (
        <Card key={s.label}>
          <CardContent className="pt-6">
            <p className="text-xs text-muted-foreground">{s.label}</p>
            <p className="tabular font-mono text-2xl">{s.value}</p>
            {s.hint && <p className="text-xs text-muted-foreground">{s.hint}</p>}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

type Action = "pause" | "unpause" | "revoke";

/** One token's treasury: the policy's shared limits and market mode, its actions, and its strategies. */
function PolicyCard({ safe, policy: p, isOwner, addStrategy }: { safe: Address; policy: PolicySummary; isOwner: boolean; addStrategy: string }) {
  const [action, setAction] = useState<Action | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [editing, setEditing] = useState(false);
  const base = p.tokens.base ?? FALLBACK;
  const quote = p.tokens.quote ?? FALLBACK;
  const id = p.policyId as Hash;
  const c = p.config;
  const calls: Record<Action, PreparedCall> = {
    pause: buildPausePolicyCall(deployment, id),
    unpause: buildUnpausePolicyCall(deployment, id),
    revoke: buildRevokePolicyCall(deployment, id),
  };
  const pct = (part: string, whole: string) => (BigInt(whole) === 0n ? 0 : Number((BigInt(part) * 100n) / BigInt(whole)));
  // Chain time: a fork's clock need not match the wall clock.
  const resetsIn = p.periodEndsAt && p.readAt ? Number(p.periodEndsAt) - Number(p.readAt) : null;
  const refs = { base: { address: getAddress(p.base), ...base }, quote: { address: getAddress(p.quote), ...quote } };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle className="font-serif text-xl">
            <Link to={`/policies/${p.policyId}`} className="underline-offset-4 hover:underline">
              {base.symbol} treasury
            </Link>{" "}
            <span className="text-base font-normal text-muted-foreground">against {quote.symbol}</span>
          </CardTitle>
          <StatusPill status={p.status} />
          {p.status !== 3 && <RiskBadge mode={p.riskMode} reason={p.riskReason} />}
          {isOwner && p.status !== 3 && (
            <div className="ml-auto flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setEditing(!editing)}>
                {editing ? "Close editor" : "Edit policy"}
              </Button>
              {p.status === 1 && (
                <Button size="sm" variant="outline" onClick={() => setAction("pause")}>
                  Pause all
                </Button>
              )}
              {p.status === 2 && (
                <Button size="sm" variant="outline" onClick={() => setAction("unpause")}>
                  Resume
                </Button>
              )}
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  setConfirmRevoke(true);
                  setAction(null);
                }}
              >
                Revoke
              </Button>
            </div>
          )}
        </div>
        <CardDescription>
          Limits reset every {formatDuration(Number(c.period.periodLength))}
          {resetsIn !== null && resetsIn > 0 ? `; next in ${formatDuration(resetsIn)}` : ""}. Every strategy below shares them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 text-sm md:grid-cols-2">
          <Meter
            label="Net sold this period"
            value={`${formatCompact(p.netSold, base.decimals)} / ${formatCompact(c.period.netSellCap, base.decimals)} ${base.symbol}`}
            pct={pct(p.netSold, c.period.netSellCap)}
          />
          <Meter
            label="Gross sold this period"
            value={`${formatCompact(p.grossSold, base.decimals)} / ${formatCompact(c.period.grossSellCap, base.decimals)} ${base.symbol}`}
            pct={pct(p.grossSold, c.period.grossSellCap)}
          />
          <Meter
            label="Buyback spend this period"
            value={`${formatCompact(p.quoteSpent, quote.decimals)} / ${formatCompact(c.period.quoteSpendCap, quote.decimals)} ${quote.symbol}`}
            pct={pct(p.quoteSpent, c.period.quoteSpendCap)}
          />
          <Meter
            label="Sold of released"
            value={`${formatCompact(p.totalNetSold, base.decimals)} / ${formatCompact(p.released, base.decimals)} ${base.symbol}`}
            pct={pct(p.totalNetSold, p.released)}
            hint={`${pct(p.released, c.release.allotment)}% of the ${formatCompact(c.release.allotment, base.decimals)} allotment released`}
          />
        </div>

        {confirmRevoke && action !== "revoke" && (
          <Alert className="border-blocked/50">
            <AlertTitle>Revoke the whole treasury policy?</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>
                Every strategy under it is revoked and docked, and every future fill is refused. Market makers keep only
                the fees they already earned. This cannot be undone; a new policy would be needed.
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="destructive" onClick={() => setAction("revoke")}>
                  Yes, prepare revoke
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmRevoke(false)}>
                  Cancel
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
        {action && (
          <SafeActionPanel
            key={action}
            safe={safe}
            call={calls[action]}
            label={`${action[0]!.toUpperCase()}${action.slice(1)} the ${base.symbol} policy`}
            context={{ base, quote }}
            onDone={() => setConfirmRevoke(false)}
          />
        )}
        {editing && (
          <div className="space-y-2 rounded-lg border p-4">
            <p className="text-sm text-muted-foreground">
              Starts from the policy's current values. Changes apply to every strategy from the next fill; tightening and
              loosening both need the owners' approval.
            </p>
            <PolicyForm
              safe={safe}
              base={refs.base}
              quote={refs.quote}
              oracle={getAddress(c.oracle.oracle)}
              policyId={id}
              initial={policyToTerms(c, refs.base, refs.quote)}
              onDone={() => setEditing(false)}
            />
          </div>
        )}

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="font-medium">Strategies</p>
            {p.status !== 3 && (
              <Button asChild size="sm" variant="outline">
                <Link to={addStrategy}>
                  <Plus /> Add strategy
                </Link>
              </Button>
            )}
          </div>
          {p.strategies.length === 0 && <p className="text-sm text-muted-foreground">No strategies under this policy yet.</p>}
          {p.strategies.map((s) => (
            <StrategyRow key={s.strategyId} safe={safe} strategy={s} base={base} quote={quote} isOwner={isOwner} />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Quote tolerance {formatBps(c.price.maxQuoteDeviationBps)} · impact allowance {formatBps(c.price.maxImpactBps)} · pauses beyond a{" "}
          {formatBps(c.oracle.pauseMoveBps)} move. <Link to={`/policies/${p.policyId}`} className="underline underline-offset-4">Full terms and market reading</Link>
        </p>
      </CardContent>
    </Card>
  );
}

function StrategyRow({ safe, strategy: s, base, quote, isOwner }: { safe: Address; strategy: Omit<StrategySummary, "tokens">; base: TokenDisplay; quote: TokenDisplay; isOwner: boolean }) {
  const [action, setAction] = useState<Action | null>(null);
  const profiles = useMmProfiles();
  const scores = useMmScores();
  const id = s.strategyId as Hash;
  const calls: Record<Action, PreparedCall> = {
    pause: buildPauseStrategyCall(deployment, id),
    unpause: buildUnpauseStrategyCall(deployment, id),
    revoke: buildRevokeStrategyCall(deployment, id),
  };
  const mmName = profiles.data?.data.find((p) => p.address === s.mm)?.displayName;

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link to={`/strategies/${s.strategyId}`} className="font-medium underline-offset-4 hover:underline">
          {s.kind === 1 ? "Buyback" : "Market making"}
        </Link>
        <StatusPill status={s.status} />
        <Link to={`/market-makers/${s.mm}`} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          {mmName ?? <Hex value={s.mm} />} <ScoreBadge score={scores.data?.data.scores.find((x) => x.mm === s.mm)} />
        </Link>
        {isOwner && s.status !== 3 && (
          <div className="ml-auto flex flex-wrap gap-2">
            {s.status === 1 && (
              <Button size="sm" variant="outline" onClick={() => setAction("pause")}>
                Pause
              </Button>
            )}
            {s.status === 2 && (
              <Button size="sm" variant="outline" onClick={() => setAction("unpause")}>
                Unpause
              </Button>
            )}
            <Button size="sm" variant="destructive" onClick={() => setAction("revoke")}>
              Revoke
            </Button>
          </div>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
        <Stat label="Fills" value={String(s.fills)} />
        <Stat label="Volume" value={`${formatCompact(s.quoteVolume, quote.decimals)} ${quote.symbol}`} />
        <Stat
          label="Execution vs market"
          value={s.avgQualityBps === null ? "–" : `${s.avgQualityBps >= 0 ? "+" : "−"}${formatBps(Math.abs(Math.round(s.avgQualityBps)))}`}
        />
        <Stat label={`MM pay (${s.mmFeeShareBps / 100}% of fees)`} value={`${formatUnits(s.mmEarnedQuote, quote.decimals, 2)} ${quote.symbol}`} />
        <Stat label="Refused trades" value={String(s.refused)} />
      </dl>
      {action === "revoke" && (
        <p className="text-sm text-blocked">
          Revoking docks this strategy for good; the market maker keeps only the fees it already earned. The policy and
          its other strategies are unaffected.
        </p>
      )}
      {action && (
        <SafeActionPanel
          key={action}
          safe={safe}
          call={calls[action]}
          label={`${action[0]!.toUpperCase()}${action.slice(1)} this strategy`}
          context={{ base, quote }}
          onDone={() => setAction(null)}
        />
      )}
    </div>
  );
}

function Meter({ label, value, pct, hint }: { label: string; value: string; pct: number; hint?: string }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between gap-2">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular font-mono text-xs">{value}</span>
      </div>
      <Progress value={Math.min(100, pct)} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular font-mono">{value}</dd>
    </div>
  );
}
