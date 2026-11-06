import { buildClaimFeesCall, buildPauseStrategyCall, buildReshipCall, mandateModuleAbi, type StrategyParams } from "@mandate/sdk";
import { useQuery } from "@tanstack/react-query";
import { Ban } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import type { Address, Hash } from "viem";
import { useConnection, useReadContract } from "wagmi";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Stat } from "@/components/gauges";
import { RiskPanel } from "@/components/RiskPanel";
import { Hex, RiskBadge, StatusPill } from "@/components/status";
import { BoundedSlider } from "@/desk/BoundedSlider";
import { useBacking } from "@/issuer/useBacking";
import { api } from "@/lib/api";
import { formatBps, formatUnits, parseUnits } from "@/lib/format";
import { useStrategy } from "@/lib/hooks";
import type { StrategyListItem, StrategySnapshot, TokenDisplay } from "@/lib/types";
import { demoChain, deployment } from "@/wallet/config";
import { TxStatus } from "@/wallet/TxStatus";
import { useTx } from "@/wallet/useTx";

const FALLBACK: TokenDisplay = { symbol: "TOKEN", decimals: 18 };

/**
 * The desk's "My strategies" tab: the market maker tunes its strategy inside the issuer's bounds and what the Safe can
 * back, pauses, and claims its fee share. Every action is sent by the market maker's own wallet and simulated first.
 */
export function MyStrategies() {
  const { address, status } = useConnection();
  const strategies = useQuery({
    queryKey: ["strategies", "list", { mm: address?.toLowerCase() }],
    queryFn: async () => (await api.strategies({ mm: address!.toLowerCase() })).data,
    enabled: Boolean(address),
  });
  const [selected, setSelected] = useState<string>();
  const list = strategies.data ?? [];
  const current = list.find((s) => s.strategyId === selected) ?? list.find((s) => s.status !== 3) ?? list[0];

  return (
    <div className="space-y-8">
      {status === "connected" && strategies.isPending && <Skeleton className="h-40 w-full" />}
      {status === "connected" && strategies.data?.length === 0 && (
        <Alert>
          <AlertTitle>No strategies yet</AlertTitle>
          <AlertDescription>
            <Hex value={address!} /> runs no strategy. Accept a proposal in the Inbox, or make sure your{" "}
            <Link to="/desk?tab=profile" className="underline">profile</Link> is listed so issuers can find you.
          </AlertDescription>
        </Alert>
      )}

      {current && (
        <>
          {list.length > 1 && (
            <Select value={current.strategyId} onValueChange={setSelected}>
              <SelectTrigger className="w-full sm:w-96"><SelectValue /></SelectTrigger>
              <SelectContent>
                {list.map((s) => (
                  <SelectItem key={s.strategyId} value={s.strategyId}>
                    {s.tokens.base?.symbol ?? "?"} / {s.tokens.quote?.symbol ?? "?"} · {s.kind === 1 ? "buyback" : "market making"} ·{" "}
                    {s.strategyId.slice(0, 10)}… {s.status === 3 ? "(revoked)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Desk key={current.strategyId} item={current} />
        </>
      )}
    </div>
  );
}

function Desk({ item }: { item: StrategyListItem }) {
  const detail = useStrategy(item.strategyId);
  const snapshot = detail.data?.data.snapshot ?? null;
  const policy = detail.data?.data.policy ?? null;
  const policySnapshot = detail.data?.data.policySnapshot ?? null;
  const base = item.tokens.base ?? FALLBACK;
  const quote = item.tokens.quote ?? FALLBACK;
  const b = item.bounds;
  const p = item.params;
  const id = item.strategyId as Hash;
  const revoked = item.status === 3 || policy?.status === 3;
  const backing = useBacking(item.safe as Address, item.base as Address, item.quote as Address, id);

  const [spread, setSpread] = useState(Number(p.spreadBps));
  const [shippedBase, setShippedBase] = useState(formatUnits(p.shippedBase, base.decimals, base.decimals).replaceAll(",", ""));
  const [shippedQuote, setShippedQuote] = useState(formatUnits(p.shippedQuote, quote.decimals, quote.decimals).replaceAll(",", ""));
  useEffect(() => setSpread(Number(p.spreadBps)), [p.spreadBps]);

  const rawBase = parseUnits(shippedBase, base.decimals);
  const rawQuote = parseUnits(shippedQuote, quote.decimals);
  const canBack = backing.data;
  const inputError =
    rawBase === null || rawBase === 0n ? "Token inventory must be a positive amount." :
    rawBase > BigInt(b.maxShippedBase) ? `Token inventory cannot exceed the issuer's ${formatUnits(b.maxShippedBase, base.decimals, 0)} ${base.symbol}.` :
    canBack?.base !== undefined && rawBase > canBack.base ? `The Safe can back only ${formatUnits(canBack.base, base.decimals, 2)} ${base.symbol} for this strategy.` :
    rawQuote === null || rawQuote === 0n ? "Quote inventory must be a positive amount." :
    rawQuote > BigInt(b.maxShippedQuote) ? `Quote inventory cannot exceed the issuer's ${formatUnits(b.maxShippedQuote, quote.decimals, 0)} ${quote.symbol}.` :
    canBack?.quote !== undefined && rawQuote > canBack.quote ? `The Safe can back only ${formatUnits(canBack.quote, quote.decimals, 2)} ${quote.symbol} for this strategy.` : null;

  const next: StrategyParams | null = inputError ? null : { spreadBps: spread, shippedBase: rawBase!, shippedQuote: rawQuote! };

  const reship = useTx();
  const pause = useTx();
  const claim = useTx();
  const probe = useTx();
  const context = { base, quote };

  const claimable = useReadContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "claimable", args: [id], chainId: demoChain.id });
  const [claimBase, claimQuote] = (claimable.data ?? [0n, 0n]) as readonly [bigint, bigint];
  const modeMin = policy && policySnapshot ? Number((policySnapshot.riskMode === 1 ? policy.config.defensive : policy.config.normal).minSpreadBps) : 0;

  const changes = useMemo(() => {
    if (!next) return [];
    const rows: [string, string, string][] = [];
    if (next.spreadBps !== Number(p.spreadBps)) rows.push(["Spread", formatBps(p.spreadBps), formatBps(next.spreadBps)]);
    if (next.shippedBase !== BigInt(p.shippedBase)) rows.push([`Inventory (${base.symbol})`, formatUnits(p.shippedBase, base.decimals, 0), formatUnits(next.shippedBase, base.decimals, 0)]);
    if (next.shippedQuote !== BigInt(p.shippedQuote)) rows.push([`Inventory (${quote.symbol})`, formatUnits(p.shippedQuote, quote.decimals, 0), formatUnits(next.shippedQuote, quote.decimals, 0)]);
    return rows;
  }, [next, p, base.decimals, base.symbol, quote.decimals, quote.symbol]);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center gap-3">
              <CardTitle className="font-serif text-xl">{base.symbol} / {quote.symbol}</CardTitle>
              <StatusPill status={item.status} />
              <RiskBadge mode={policySnapshot?.riskMode} reason={policySnapshot?.riskReason} />
              <Link to={`/strategies/${item.strategyId}`} className="ml-auto text-sm underline-offset-4 hover:underline">Public page</Link>
            </div>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Issuer Safe" value={<Hex value={item.safe} />} />
            <Stat label="Kind" value={item.kind === 1 ? "Buyback" : "Market making"} />
            <Stat label="Net sold this period" value={policySnapshot && policy ? `${formatUnits(policySnapshot.netSold, base.decimals, 0)} / ${formatUnits(policy.config.period.netSellCap, base.decimals, 0)}` : "…"} caption={`${base.symbol}, shared by every strategy`} />
            <Stat label="Quote tolerance" value={policy ? formatBps(policy.config.price.maxQuoteDeviationBps) : "…"} caption="keep your price near the TWAP" />
          </CardContent>
        </Card>

        {policy && policySnapshot && <RiskPanel snapshot={policySnapshot} config={policy.config} base={base} quote={quote} />}

        <Card>
          <CardHeader>
            <CardTitle>Tune the strategy</CardTitle>
            <CardDescription>
              Re-shipping docks the live order and ships a new one. The treasury's limits carry over: a reship never resets them.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <BoundedSlider label="Spread" caption="spreadBps" value={spread} min={Number(b.spreadBpsMin)} max={Number(b.spreadBpsMax)} step={1} format={(v) => formatBps(v)} onChange={setSpread} />
            {modeMin > spread && (
              <p className="text-xs text-warning">The current risk mode requires at least {formatBps(modeMin)}; fills are priced at that until the mode changes.</p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="shipped-base">Token inventory ({base.symbol})</Label>
                <Input id="shipped-base" className="tabular font-mono" value={shippedBase} onChange={(e) => setShippedBase(e.target.value)} />
                <p className="text-[11px] text-muted-foreground">
                  Issuer cap {formatUnits(b.maxShippedBase, base.decimals, 0)} · Safe can back {canBack?.base !== undefined ? formatUnits(canBack.base, base.decimals, 0) : "…"}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="shipped-quote">Quote inventory ({quote.symbol})</Label>
                <Input id="shipped-quote" className="tabular font-mono" value={shippedQuote} onChange={(e) => setShippedQuote(e.target.value)} />
                <p className="text-[11px] text-muted-foreground">
                  Issuer cap {formatUnits(b.maxShippedQuote, quote.decimals, 0)} · Safe can back {canBack?.quote !== undefined ? formatUnits(canBack.quote, quote.decimals, 0) : "…"}
                </p>
              </div>
            </div>
            {inputError && <p className="text-sm text-blocked">{inputError}</p>}
            {changes.length > 0 && (
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground"><tr><th className="py-1 font-normal">Parameter</th><th className="font-normal">Live</th><th className="font-normal">New</th></tr></thead>
                <tbody className="tabular font-mono">
                  {changes.map(([name, from, to]) => (
                    <tr key={name} className="border-t"><td className="py-1.5 font-sans">{name}</td><td>{from}</td><td className="text-primary">{to}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
            <Button disabled={!next || changes.length === 0 || revoked || reship.busy} onClick={() => next && void reship.run({ send: buildReshipCall(deployment, id, next), context })}>
              Re-ship strategy
            </Button>
            <TxStatus state={reship.state} />
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6">
        <Earnings snapshot={snapshot} base={base} quote={quote} claimBase={claimBase} claimQuote={claimQuote} shareBps={b.mmFeeShareBps} />
        <Card>
          <CardContent className="space-y-3 pt-6">
            <Button className="w-full" disabled={(claimBase === 0n && claimQuote === 0n) || claim.busy} onClick={() => void claim.run({ send: buildClaimFeesCall(deployment, id), context })}>
              Claim earned fees
            </Button>
            <TxStatus state={claim.state} />
            <Button variant="outline" className="w-full" disabled={item.status !== 1 || pause.busy} onClick={() => void pause.run({ send: buildPauseStrategyCall(deployment, id), context })}>
              Pause fills
            </Button>
            <p className="text-[11px] text-muted-foreground">Pausing only reduces risk. Only the issuer can resume.</p>
            <TxStatus state={pause.state} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">What I can't do</CardTitle>
            <CardDescription className="text-[11px]">Each of these is refused by the contracts, not by this page.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="space-y-2 text-sm">
              {["Move tokens out of the Safe", "Ship tokens the Safe does not hold", "Exceed or reset the treasury's limits", "Change my fee share", "Undo a revoke"].map((t) => (
                <li key={t} className="flex items-center gap-2"><Ban className="size-4 shrink-0 text-blocked" /> {t}</li>
              ))}
            </ul>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              disabled={probe.busy}
              onClick={() =>
                void probe.run({
                  // Simulation only: shows the module's refusal of a spread above the issuer's bound; never sent.
                  simulateOnly: true,
                  send: buildReshipCall(deployment, id, { spreadBps: Number(b.spreadBpsMax) + 1, shippedBase: BigInt(p.shippedBase), shippedQuote: BigInt(p.shippedQuote) }),
                  context,
                })
              }
            >
              Try to exceed the issuer's spread range
            </Button>
            <TxStatus state={probe.state} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Earnings({ snapshot, base, quote, claimBase, claimQuote, shareBps }: { snapshot: StrategySnapshot | null; base: TokenDisplay; quote: TokenDisplay; claimBase: bigint; claimQuote: bigint; shareBps: number | string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Earnings</CardTitle>
        <CardDescription className="text-[11px]">{formatBps(shareBps)} of fees on real fills, claimable directly</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-4">
        <Stat label={`Fees (${quote.symbol})`} value={snapshot ? formatUnits(snapshot.feesQuote, quote.decimals) : "…"} />
        <Stat label={`Fees (${base.symbol})`} value={snapshot ? formatUnits(snapshot.feesBase, base.decimals) : "…"} />
        <Stat label={`Claimable (${quote.symbol})`} value={formatUnits(claimQuote, quote.decimals)} />
        <Stat label={`Claimable (${base.symbol})`} value={formatUnits(claimBase, base.decimals)} />
        <Stat label={`Claimed (${quote.symbol})`} value={snapshot ? formatUnits(snapshot.claimedQuote, quote.decimals) : "…"} />
      </CardContent>
    </Card>
  );
}
