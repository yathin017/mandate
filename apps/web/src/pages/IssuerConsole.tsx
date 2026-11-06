import { buildPauseCall, buildRevokeCall, buildUnpauseCall, safeAbi, type PreparedCall } from "@mandate/sdk";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { isAddress, type Address, type Hash } from "viem";
import { useConnection, useReadContract } from "wagmi";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Hex, StatusPill } from "@/components/status";
import { api } from "@/lib/api";
import type { MandateListItem, TokenDisplay } from "@/lib/types";
import { CreateMandateForm } from "@/issuer/CreateMandateForm";
import { STANDARD_RAILS, type Terms } from "@/issuer/terms";
import { useTokenInfo } from "@/onboarding/useTokenInfo";
import { ACCOUNT_HELP, DEMO_ACCOUNTS, DEMO_SAFES, demoChain, deployment, isLive, roleOf } from "@/wallet/config";
import { SafeActionPanel } from "@/wallet/SafeActionPanel";
import { useSafeInfo } from "@/wallet/useSafe";

const FALLBACK: TokenDisplay = { symbol: "TOKEN", decimals: 18 };

/** Demo terms mirror contracts/script/lib/DemoConfig.sol, scaled to fit the demo Safe's balance. */
const DEMO_TERMS: Partial<Terms> = {
  ...STANDARD_RAILS,
  allotment: "1000000",
  dailyCap: "50000",
  floor: "0.30",
  shippedBase: "1000000",
  shippedQuote: "400000",
};

/**
 * Issuer Console (spec 10.3 B). Every action here is a Safe transaction approved onchain by the Safe's owners.
 * Mandate lists come from the indexer; Safe owners, nonce and approvals are read from the Safe.
 */
export function IssuerConsole() {
  const [selected, setSelected] = useState<string>(DEMO_SAFES[0]!.address);
  // ?safe=0x… (e.g. from onboarding) preselects a Safe that is not one of the demo Safes.
  const [params] = useSearchParams();
  const [custom, setCustom] = useState(() => params.get("safe") ?? "");
  const safe = (isAddress(custom) ? custom : selected) as Address;
  const { address } = useConnection();
  const info = useSafeInfo(safe);
  const moduleEnabled = useReadContract({
    address: safe,
    abi: safeAbi,
    functionName: "isModuleEnabled",
    args: [deployment.module],
    chainId: demoChain.id,
  });
  const mandates = useQuery({
    queryKey: ["mandates", "safe", safe],
    queryFn: async () => (await api.mandates()).data.filter((m) => m.safe === safe.toLowerCase()),
  });
  const tokens = mandates.data?.[0]?.tokens;
  const base = tokens?.base ?? { symbol: "LAUNCH", decimals: 18 };
  const quote = tokens?.quote ?? { symbol: "sUSDC", decimals: 6 };
  const baseHolding = useTokenInfo(deployment.base, safe);
  const quoteHolding = useTokenInfo(deployment.quote, safe);
  const isOwner = Boolean(address && info.owners?.some((o) => o.toLowerCase() === address.toLowerCase()));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-serif text-3xl font-semibold tracking-tight">Issuer console</h1>
        <p className="text-muted-foreground">
          Create and manage mandates for your treasury Safe. Every action is approved onchain by the Safe's owners.
          New project? <Link to="/onboard" className="underline underline-offset-4">Onboard it step by step</Link>.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Treasury Safe</CardTitle>
          <CardDescription>
            {isLive
              ? `The live demo Safe is 2-of-2: Safe Owner 1 (${DEMO_ACCOUNTS.safeOwner1.slice(0, 6)}…) and Safe Owner 2 (${DEMO_ACCOUNTS.safeOwner2.slice(0, 6)}…).`
              : "Demo Safes are 2-of-2, owned by Anvil dev accounts #0 and #1."}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Demo Safe</Label>
              <Select value={selected} onValueChange={(v) => { setSelected(v); setCustom(""); }}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DEMO_SAFES.map((s) => (
                    <SelectItem key={s.address} value={s.address}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="custom-safe">Or another Safe address</Label>
              <Input id="custom-safe" className="font-mono" placeholder="0x…" value={custom} onChange={(e) => setCustom(e.target.value.trim())} />
            </div>
          </div>
          <div className="space-y-2 text-sm">
            <p>Safe <Hex value={safe} chars={6} /></p>
            <p>Threshold: <b>{info.threshold?.toString() ?? "…"}</b> of {info.owners?.length ?? "…"} owners</p>
            <ul className="space-y-1">
              {info.owners?.map((o) => (
                <li key={o}>
                  <Hex value={o} />
                  {roleOf(o) && <span className="ml-2 text-xs text-muted-foreground">{roleOf(o)}</span>}
                  {address && o.toLowerCase() === address.toLowerCase() && <span className="ml-2 text-xs text-filled">you</span>}
                </li>
              ))}
            </ul>
            <p>Mandate module: {moduleEnabled.data === undefined ? "…" : moduleEnabled.data ? <span className="text-filled">enabled</span> : <span className="text-blocked">not enabled</span>}</p>
            {info.error && <p className="text-blocked">Could not read this Safe from the chain RPC.</p>}
          </div>
        </CardContent>
      </Card>

      {!isOwner && (
        <Alert>
          <AlertTitle>Connect a Safe owner</AlertTitle>
          <AlertDescription>
            {ACCOUNT_HELP}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Mandates of this Safe</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {mandates.data?.length === 0 && <p className="text-sm text-muted-foreground">No mandates yet. Create one below.</p>}
          {mandates.data?.map((m) => <MandateActions key={m.mandateId} safe={safe} mandate={m} />)}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Create a mandate</CardTitle>
          <CardDescription>Set the terms, review them as a term sheet, then have the owners approve.</CardDescription>
        </CardHeader>
        <CardContent>
          {moduleEnabled.data === false ? (
            <p className="text-sm text-blocked">Enable the Mandate module on this Safe first.</p>
          ) : (
            <CreateMandateForm
              safe={safe}
              base={{ ...base, address: deployment.base }}
              quote={{ ...quote, address: deployment.quote }}
              anchor={deployment.anchor}
              holdings={{ base: baseHolding.balance, quote: quoteHolding.balance }}
              initial={{ ...DEMO_TERMS, mm: DEMO_ACCOUNTS.marketMaker }}
              releaseOffsetDays={20}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

type Action = "pause" | "unpause" | "revoke";

function MandateActions({ safe, mandate }: { safe: Address; mandate: MandateListItem }) {
  const [action, setAction] = useState<Action | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const id = mandate.mandateId as Hash;
  const calls: Record<Action, PreparedCall> = {
    pause: buildPauseCall(deployment, id),
    unpause: buildUnpauseCall(deployment, id),
    revoke: buildRevokeCall(deployment, id),
  };
  const base = mandate.tokens.base ?? FALLBACK;
  const quote = mandate.tokens.quote ?? FALLBACK;

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link to={`/mandates/${mandate.mandateId}`} className="font-medium underline-offset-4 hover:underline">
          {base.symbol} / {quote.symbol} · <Hex value={mandate.mandateId} chars={6} />
        </Link>
        <StatusPill status={mandate.status} />
        <span className="text-xs text-muted-foreground">MM <Hex value={mandate.mm} /></span>
        <div className="ml-auto flex flex-wrap gap-2">
          {mandate.status === 1 && <Button size="sm" variant="outline" onClick={() => setAction("pause")}>Pause</Button>}
          {mandate.status === 2 && <Button size="sm" variant="outline" onClick={() => setAction("unpause")}>Unpause</Button>}
          {mandate.status !== 3 && (
            <Button size="sm" variant="destructive" onClick={() => { setConfirmRevoke(true); setAction(null); }}>
              Revoke
            </Button>
          )}
        </div>
      </div>

      {confirmRevoke && action !== "revoke" && (
        <Alert className="border-blocked/50">
          <AlertTitle>Revoke permanently?</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>
              The strategy is docked and every future fill is refused. The market maker loses every power except claiming
              fees it already earned. This cannot be undone; a new mandate would be needed.
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" onClick={() => setAction("revoke")}>Yes, prepare revoke</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRevoke(false)}>Cancel</Button>
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
