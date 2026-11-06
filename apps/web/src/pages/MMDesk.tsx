import { buildClaimFeesCall, buildPauseCall, buildReshipCall, mandateModuleAbi, type MandateParams } from "@mandate/sdk";
import { useQuery } from "@tanstack/react-query";
import { Ban } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import type { Hash } from "viem";
import { useConnection, useReadContract } from "wagmi";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Stat } from "@/components/gauges";
import { Hex, StatusPill } from "@/components/status";
import { BoundedSlider } from "@/desk/BoundedSlider";
import { api } from "@/lib/api";
import { formatBps, formatPrice, formatUnits, parseUnits } from "@/lib/format";
import { useMandate } from "@/lib/hooks";
import type { MandateListItem, Snapshot, TokenDisplay } from "@/lib/types";
import { DEMO_ACCOUNTS, demoChain, deployment, isLive } from "@/wallet/config";
import { TxStatus } from "@/wallet/TxStatus";
import { useTx } from "@/wallet/useTx";

const FALLBACK: TokenDisplay = { symbol: "TOKEN", decimals: 18 };

/**
 * MM Desk (spec 10.3 C): the market maker tunes its strategy inside the issuer's bounds, pauses, and claims its
 * fee share. Every action is sent by the MM's own wallet and simulated first.
 */
export function MMDesk() {
  const { address, status } = useConnection();
  const mandates = useQuery({
    queryKey: ["mandates", "mm", address],
    queryFn: async () => (await api.mandatesByMm(address!)).data,
    enabled: Boolean(address),
  });
  const [selected, setSelected] = useState<string>();
  const list = mandates.data ?? [];
  const current = list.find((m) => m.mandateId === selected) ?? list.find((m) => m.status !== 3) ?? list[0];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-serif text-3xl font-semibold tracking-tight">MM desk</h1>
        <p className="text-muted-foreground">Operate a mandate inside the issuer's bounds. You never hold the treasury's tokens.</p>
      </div>

      {status !== "connected" && (
        <Alert>
          <AlertTitle>Connect the market maker's wallet</AlertTitle>
          <AlertDescription>
            The demo market maker is <Hex value={DEMO_ACCOUNTS.marketMaker} />
            {isLive ? " (the live mandate's MM)." : " (Anvil account #2): create a mandate for it in the Issuer console, then connect it here."}
          </AlertDescription>
        </Alert>
      )}
      {status === "connected" && mandates.isPending && <Skeleton className="h-40 w-full" />}
      {status === "connected" && mandates.data?.length === 0 && (
        <Alert>
          <AlertTitle>No mandates for this address</AlertTitle>
          <AlertDescription>
            <Hex value={address!} /> is not the market maker of any indexed mandate. <Link to="/issuer" className="underline">Create one in the Issuer console</Link>.
          </AlertDescription>
        </Alert>
      )}

      {current && (
        <>
          {list.length > 1 && (
            <Select value={current.mandateId} onValueChange={setSelected}>
              <SelectTrigger className="w-full sm:w-96"><SelectValue /></SelectTrigger>
              <SelectContent>
                {list.map((m) => (
                  <SelectItem key={m.mandateId} value={m.mandateId}>
                    {m.tokens.base?.symbol ?? "?"} / {m.tokens.quote?.symbol ?? "?"} · {m.mandateId.slice(0, 10)}… {m.status === 3 ? "(revoked)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Desk key={current.mandateId} item={current} />
        </>
      )}
    </div>
  );
}

function Desk({ item }: { item: MandateListItem }) {
  const detail = useMandate(item.mandateId);
  const snapshot = detail.data?.data.snapshot ?? null;
  const base = item.tokens.base ?? FALLBACK;
  const quote = item.tokens.quote ?? FALLBACK;
  const b = item.bounds;
  const p = item.params;
  const id = item.mandateId as Hash;
  const revoked = item.status === 3;

  const unit = 10n ** BigInt(base.decimals);
  const maxCapWhole = Number(BigInt(b.maxEpochCap) / unit);
  const [spread, setSpread] = useState(Number(p.spreadBps));
  const [capWhole, setCapWhole] = useState(Number(BigInt(p.epochCap) / unit));
  const [shippedBase, setShippedBase] = useState(formatUnits(p.shippedBase, base.decimals, base.decimals).replaceAll(",", ""));
  const [shippedQuote, setShippedQuote] = useState(formatUnits(p.shippedQuote, quote.decimals, quote.decimals).replaceAll(",", ""));
  useEffect(() => setSpread(Number(p.spreadBps)), [p.spreadBps]);

  const unsold = snapshot ? BigInt(b.allotment) - BigInt(snapshot.totalNetSold) : BigInt(b.allotment);
  const rawBase = parseUnits(shippedBase, base.decimals);
  const rawQuote = parseUnits(shippedQuote, quote.decimals);
  const inputError =
    rawBase === null || rawBase === 0n ? "Inventory must be a positive amount." :
    rawBase > unsold ? `Inventory cannot exceed the unsold allotment (${formatUnits(unsold, base.decimals, 0)} ${base.symbol}).` :
    rawQuote === null || rawQuote === 0n ? "Buyback inventory must be a positive amount." :
    rawQuote > BigInt(b.maxShippedQuote) ? `Buyback inventory cannot exceed ${formatUnits(b.maxShippedQuote, quote.decimals, 0)} ${quote.symbol}.` : null;

  const next: MandateParams | null = inputError
    ? null
    : { spreadBps: spread, epochCap: BigInt(capWhole) * unit, shippedBase: rawBase!, shippedQuote: rawQuote! };

  const reship = useTx();
  const pause = useTx();
  const claim = useTx();
  const probe = useTx();
  const context = { base, quote };

  const claimable = useReadContract({
    address: deployment.module,
    abi: mandateModuleAbi,
    functionName: "claimable",
    args: [id],
    chainId: demoChain.id,
  });
  const [claimBase, claimQuote] = (claimable.data ?? [0n, 0n]) as readonly [bigint, bigint];

  const changes = useMemo(() => {
    if (!next) return [];
    const rows: [string, string, string][] = [];
    if (next.spreadBps !== Number(p.spreadBps)) rows.push(["Spread", formatBps(p.spreadBps), formatBps(next.spreadBps)]);
    if (next.epochCap !== BigInt(p.epochCap)) rows.push(["Daily sell limit", formatUnits(p.epochCap, base.decimals, 0), formatUnits(next.epochCap, base.decimals, 0)]);
    if (next.shippedBase !== BigInt(p.shippedBase)) rows.push([`Inventory (${base.symbol})`, formatUnits(p.shippedBase, base.decimals, 0), formatUnits(next.shippedBase, base.decimals, 0)]);
    if (next.shippedQuote !== BigInt(p.shippedQuote)) rows.push([`Buyback (${quote.symbol})`, formatUnits(p.shippedQuote, quote.decimals, 0), formatUnits(next.shippedQuote, quote.decimals, 0)]);
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
              <Link to={`/mandates/${item.mandateId}`} className="ml-auto text-sm underline-offset-4 hover:underline">Public page</Link>
            </div>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Issuer Safe" value={<Hex value={item.safe} />} />
            <Stat label="Floor" value={b.floorPriceX36 === "0" ? "none" : formatPrice(b.floorPriceX36, base.decimals, quote.decimals)} caption={quote.symbol} />
            <Stat label="Anchor band" value={formatBps(b.maxAnchorDeviationBps)} />
            <Stat label="Sellable now" value={snapshot ? formatUnits(snapshot.sellableNow, base.decimals, 0) : "…"} caption={base.symbol} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Tune the strategy</CardTitle>
            <CardDescription>Re-shipping docks the live strategy and ships a new one with these parameters.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <BoundedSlider label="Spread" caption="spreadBps" value={spread} min={Number(b.spreadBpsMin)} max={Number(b.spreadBpsMax)} step={1} format={(v) => formatBps(v)} onChange={setSpread} />
            <BoundedSlider label="Daily sell limit" caption="epochCap" value={capWhole} min={0} max={maxCapWhole} step={Math.max(1, Math.round(maxCapWhole / 200))} format={(v) => `${v.toLocaleString()} ${base.symbol}`} onChange={setCapWhole} />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="shipped-base">Inventory to ship ({base.symbol})</Label>
                <Input id="shipped-base" className="tabular font-mono" value={shippedBase} onChange={(e) => setShippedBase(e.target.value)} />
                <p className="text-[11px] text-muted-foreground">At most the unsold allotment: {formatUnits(unsold, base.decimals, 0)}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="shipped-quote">Buyback inventory ({quote.symbol})</Label>
                <Input id="shipped-quote" className="tabular font-mono" value={shippedQuote} onChange={(e) => setShippedQuote(e.target.value)} />
                <p className="text-[11px] text-muted-foreground">Issuer cap: {formatUnits(b.maxShippedQuote, quote.decimals, 0)}</p>
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
            <Button
              disabled={!next || changes.length === 0 || revoked || reship.busy}
              onClick={() => next && void reship.run({ send: buildReshipCall(deployment, id, next), context })}
            >
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
            <Button variant="outline" className="w-full" disabled={item.status !== 1 || pause.busy} onClick={() => void pause.run({ send: buildPauseCall(deployment, id), context })}>
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
              {["Move tokens out of the Safe", "Raise the sell limit or lower the floor", "Swap in a different quoter", "Change my fee share", "Undo a revoke"].map((t) => (
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
                  // Simulation only: shows the module's refusal of a cap above the issuer's bound; never sent.
                  simulateOnly: true,
                  send: buildReshipCall(deployment, id, { spreadBps: Number(p.spreadBps), epochCap: BigInt(b.maxEpochCap) * 2n, shippedBase: BigInt(p.shippedBase), shippedQuote: BigInt(p.shippedQuote) }),
                  context,
                })
              }
            >
              Try to exceed the issuer's cap
            </Button>
            <TxStatus state={probe.state} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Earnings({ snapshot, base, quote, claimBase, claimQuote, shareBps }: { snapshot: Snapshot | null; base: TokenDisplay; quote: TokenDisplay; claimBase: bigint; claimQuote: bigint; shareBps: number | string }) {
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
