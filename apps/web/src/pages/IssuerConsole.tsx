import { buildPauseCall, buildRevokeCall, buildUnpauseCall, safeAbi, type PreparedCall } from "@mandate/sdk";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { isAddress, type Address, type Hash } from "viem";
import { useConnection, useReadContract } from "wagmi";

import { ScoreBadge } from "@/components/score";
import { Hex, StatusPill } from "@/components/status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ProposalList } from "@/issuer/ProposalList";
import { api } from "@/lib/api";
import { formatCompact, formatUnits } from "@/lib/format";
import { useMmProfiles, useMmScores } from "@/lib/hooks";
import type { SafeMandateSummary, TokenDisplay } from "@/lib/types";
import { ACCOUNT_HELP, DEMO_SAFES, demoChain, deployment, roleOf } from "@/wallet/config";
import { SafeActionPanel } from "@/wallet/SafeActionPanel";
import { useSafeInfo } from "@/wallet/useSafe";

const FALLBACK: TokenDisplay = { symbol: "TOKEN", decimals: 18 };

/**
 * Issuer console: one treasury Safe at a glance. Proposals waiting on the market maker or ready to execute, every
 * mandate's progress (released vs sold, today vs the daily cap, fills, fees, refused trades) and the owner actions
 * (pause, unpause, revoke), each a Safe transaction approved onchain. New mandates start in the launch wizard.
 */
export function IssuerConsole() {
  // ?safe=0x… (from the wizard or a shared link) selects a Safe that is not a demo Safe.
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get("safe");
  const [typed, setTyped] = useState(fromUrl ?? "");
  const safe = (fromUrl && isAddress(fromUrl) ? fromUrl : DEMO_SAFES[0]!.address) as Address;
  const choose = (value: string) => setParams(isAddress(value) ? { safe: value } : {}, { replace: true });

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
  const newMandate = rows[0] ? `/launch?safe=${safe}&base=${rows[0].base}&quote=${rows[0].quote}` : `/launch?safe=${safe}`;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl font-semibold tracking-tight">Issuer</h1>
          <p className="text-muted-foreground">Your treasury Safe: proposals, mandates and their progress. Owners approve every action onchain.</p>
        </div>
        <Button asChild>
          <Link to={newMandate}>
            <Plus /> New mandate
          </Link>
        </Button>
      </div>

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
          <CardDescription>Terms sent to market makers. Once one signs, the owners execute the mandate here.</CardDescription>
        </CardHeader>
        <CardContent>
          <ProposalList safe={safe} tokens={(p) => tokenOf(p.base, p.quote)} onExecuted={() => void summary.refetch()} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Mandates</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {summary.isPending && <Skeleton className="h-32 w-full" />}
          {summary.isError && <p className="text-sm text-blocked">Could not load mandates: {summary.error.message}</p>}
          {summary.data && rows.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No mandates yet.{" "}
              <Link to={newMandate} className="underline underline-offset-4">
                Propose one to a market maker
              </Link>
              .
            </p>
          )}
          {rows.map((m) => (
            <MandateRow key={m.mandateId} safe={safe} mandate={m} />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

/** Safe-wide counts. Amounts are per token, so they stay on the mandate rows; these are the comparable totals. */
function Overview({ rows, loading }: { rows: readonly SafeMandateSummary[]; loading: boolean }) {
  if (loading) return <Skeleton className="h-24 w-full" />;
  const stats = [
    { label: "Active mandates", value: rows.filter((r) => r.status === 1).length },
    { label: "Paused", value: rows.filter((r) => r.status === 2).length },
    { label: "Fills", value: rows.reduce((n, r) => n + r.fills, 0) },
    { label: "Refused trades", value: rows.reduce((n, r) => n + r.refused, 0), hint: "Trades the rails stopped" },
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

function MandateRow({ safe, mandate: m }: { safe: Address; mandate: SafeMandateSummary }) {
  const [action, setAction] = useState<Action | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const profiles = useMmProfiles();
  const scores = useMmScores();
  const base = m.tokens.base ?? FALLBACK;
  const quote = m.tokens.quote ?? FALLBACK;
  const id = m.mandateId as Hash;
  const calls: Record<Action, PreparedCall> = {
    pause: buildPauseCall(deployment, id),
    unpause: buildUnpauseCall(deployment, id),
    revoke: buildRevokeCall(deployment, id),
  };
  const pct = (part: string, whole: string) => (BigInt(whole) === 0n ? 0 : Number((BigInt(part) * 100n) / BigInt(whole)));
  const mmName = profiles.data?.data.find((p) => p.address === m.mm)?.displayName;

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link to={`/mandates/${m.mandateId}`} className="font-medium underline-offset-4 hover:underline">
          {base.symbol} / {quote.symbol}
        </Link>
        <StatusPill status={m.status} />
        <Link to={`/market-makers/${m.mm}`} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          {mmName ?? <Hex value={m.mm} />} <ScoreBadge score={scores.data?.data.scores.find((s) => s.mm === m.mm)} />
        </Link>
        <div className="ml-auto flex flex-wrap gap-2">
          {m.status === 1 && (
            <Button size="sm" variant="outline" onClick={() => setAction("pause")}>
              Pause
            </Button>
          )}
          {m.status === 2 && (
            <Button size="sm" variant="outline" onClick={() => setAction("unpause")}>
              Unpause
            </Button>
          )}
          {m.status !== 3 && (
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
          )}
        </div>
      </div>

      <div className="grid gap-4 text-sm md:grid-cols-2">
        <Meter
          label="Sold of released"
          value={`${formatCompact(m.totalNetSold, base.decimals)} / ${formatCompact(m.released, base.decimals)} ${base.symbol}`}
          pct={pct(m.totalNetSold, m.released)}
          hint={`${pct(m.released, m.allotment)}% of the ${formatCompact(m.allotment, base.decimals)} allotment released`}
        />
        <Meter
          label="Today vs daily cap"
          value={`${formatCompact(m.soldToday, base.decimals)} / ${formatCompact(m.dailyCap, base.decimals)} ${base.symbol}`}
          pct={pct(m.soldToday, m.dailyCap)}
        />
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Stat label="Fills" value={String(m.fills)} />
        <Stat label="Volume" value={`${formatCompact(m.quoteVolume, quote.decimals)} ${quote.symbol}`} />
        <Stat label="Fees earned by the MM" value={`${formatUnits(m.feesQuote, quote.decimals, 2)} ${quote.symbol}`} />
        <Stat label="Refused trades" value={String(m.refused)} />
      </dl>

      {confirmRevoke && action !== "revoke" && (
        <Alert className="border-blocked/50">
          <AlertTitle>Revoke permanently?</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>
              The strategy is docked and every future fill is refused. The market maker loses every power except claiming
              fees it already earned. This cannot be undone; a new mandate would be needed.
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
          label={`${action[0]!.toUpperCase()}${action.slice(1)} this mandate`}
          context={{ base, quote }}
          onDone={() => setConfirmRevoke(false)}
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
