import { safeAbi } from "@mandate/sdk";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { getAddress, isAddress, type Address } from "viem";
import { useConnection, useReadContracts } from "wagmi";

import { AddressLink } from "@/components/AddressLink";
import { useInsights } from "@/components/LiquidityReport";
import { RiskBadge, StatusPill } from "@/components/status";
import { PolicySheet } from "@/components/TermSheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { formatPrice, formatUnits } from "@/lib/format";
import { savedSafes, saveSafe } from "@/lib/savedSafes";
import type { LaunchedToken, PolicySummary, TokenDisplay } from "@/lib/types";
import { useAnchorStatus } from "@/onboarding/AnchorStep";
import { useSafeCheck } from "@/onboarding/useSafeCheck";
import { useTokenInfo } from "@/onboarding/useTokenInfo";
import { DEMO_SAFES, demoChain, deployment, isLive, roleOf } from "@/wallet/config";

const LAUNCH_DECIMALS = 18;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The connected wallet's directory: every Safe it owns, and per Safe each token with its reference (quote) token, the
 * Uniswap v4 pool and oracle, the treasury policy and the strategies under it, plus tokens it launched into Safes it
 * does not own. Safes are found from Mandate data only, no outside service: Safes that received a token this wallet
 * launched, Safes with a policy, Safes created or added in this browser, and the demo Safes; each is kept only if
 * the wallet is an owner onchain. `owner` (from `?owner=` in the URL) shows another wallet's directory read-only.
 */
export function IssuerDirectory({ owner, onManage }: { owner?: Address | undefined; onManage: (safe: Address) => void }) {
  const { address: connected } = useConnection();
  const address = owner ?? connected;
  const me = address?.toLowerCase();
  const [saved, setSaved] = useState(savedSafes);
  const [typed, setTyped] = useState("");

  const launched = useQuery({ queryKey: ["launched-by", me], queryFn: () => api.launchedTokens({ creator: me! }), enabled: Boolean(me) });
  const policies = useQuery({ queryKey: ["policies-all"], queryFn: () => api.policies(), enabled: Boolean(me) });

  const candidates = useMemo(() => {
    const all = [
      ...(launched.data?.data ?? []).map((t) => t.recipient),
      ...(policies.data?.data ?? []).map((p) => p.safe),
      ...saved,
      ...DEMO_SAFES.map((s) => s.address),
    ].filter((a): a is Address => isAddress(a));
    return [...new Set(all.map((a) => getAddress(a)))];
  }, [launched.data, policies.data, saved]);

  const owners = useReadContracts({
    contracts: candidates.map((safe) => ({ address: safe, abi: safeAbi, functionName: "getOwners", chainId: demoChain.id }) as const),
    query: { enabled: Boolean(me) && candidates.length > 0 },
  });
  const owned = candidates.filter((_, i) => {
    const r = owners.data?.[i];
    return r?.status === "success" && (r.result as readonly string[]).some((o) => o.toLowerCase() === me);
  });
  // Launched into an address that is not one of these Safes, and not traded by one of them under a policy either
  // (a token launched to a wallet and then moved into the Safe is listed under that Safe).
  const inOwnedSafe = (token: string) => (policies.data?.data ?? []).some((p) => same(p.base, token) && owned.some((s) => same(s, p.safe)));
  const elsewhere = (launched.data?.data ?? []).filter((t) => !owned.some((s) => same(s, t.recipient)) && !inOwnedSafe(t.token));

  if (!address) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Your directory</CardTitle>
          <CardDescription>Connect a wallet to see every Safe you own and the tokens, pools and policies in each.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const loading = launched.isPending || policies.isPending || (candidates.length > 0 && owners.isPending);

  return (
    <section className="space-y-4" aria-labelledby="directory-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="directory-title" className="text-xl font-semibold">Your directory</h2>
          <p className="text-sm text-muted-foreground">
            Safes owned by <span className="font-mono">{address.slice(0, 6)}…{address.slice(-4)}</span>
            {roleOf(address) ? ` (${roleOf(address)})` : ""}, each token in them, its pool and treasury policy.
          </p>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!isAddress(typed)) return;
            saveSafe(typed);
            setSaved(savedSafes());
            setTyped("");
          }}
        >
          <Input className="w-72 font-mono" placeholder="Add a Safe by address (0x…)" value={typed} onChange={(e) => setTyped(e.target.value.trim())} />
          <Button type="submit" variant="outline" disabled={!isAddress(typed)}>
            Add
          </Button>
        </form>
      </div>

      {loading && <Skeleton className="h-40 w-full" />}
      {!loading && owned.length === 0 && (
        <Card>
          <CardContent className="space-y-2 pt-6 text-sm">
            <p>No Safe owned by this wallet yet.</p>
            <Button asChild size="sm">
              <Link to="/launch">
                <Plus /> Create a treasury Safe
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}
      {owned.map((safe) => (
        <SafeCard key={safe} safe={safe} launched={launched.data?.data ?? []} onManage={() => onManage(safe)} />
      ))}

      {elsewhere.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tokens you launched into other addresses</CardTitle>
            <CardDescription>Their supply went to an address this wallet does not own as a Safe.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {elsewhere.map((t) => (
              <div key={t.token} className="space-y-1 border-t pt-3 first:border-t-0 first:pt-0">
                <p>
                  <b>{t.symbol}</b> · {t.name} · supply {formatUnits(t.supply, LAUNCH_DECIMALS, 0)}
                </p>
                <AddressLink label="Token" value={getAddress(t.token)} kind="token" />
                <div>
                  <AddressLink label="Sent to" value={getAddress(t.recipient)} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </section>
  );
}

/**
 * One Safe: its owners and module, then one row per token: those with a policy here and those launched straight into
 * it. `launched` is every token this wallet launched, for their names and launch details.
 */
function SafeCard({ safe, launched, onManage }: { safe: Address; launched: LaunchedToken[]; onManage: () => void }) {
  const check = useSafeCheck(safe);
  const summary = useQuery({ queryKey: ["safe-summary", safe.toLowerCase()], queryFn: () => api.safeSummary(safe) });
  const rows = summary.data?.data ?? [];
  // One entry per base token: its live policy (else its latest), and the launch record if this wallet launched it.
  // The deployment's own demo Safe also holds its demo pair, minted rather than launched through the factory.
  const demoPair = "safe" in deployment && same(deployment.safe, safe) ? { base: deployment.base.toLowerCase(), quote: getAddress(deployment.quote) } : null;
  const bases = [
    ...new Set([...rows.map((r) => r.base), ...launched.filter((t) => same(t.recipient, safe)).map((t) => t.token.toLowerCase()), ...(demoPair ? [demoPair.base] : [])]),
  ];
  const policyFor = (base: string) =>
    rows.find((r) => same(r.base, base) && r.status !== 3) ?? rows.find((r) => same(r.base, base));

  return (
    <Card>
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="text-base">
            <AddressLink label="Safe" value={safe} />
          </CardTitle>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={onManage}>
              Manage
            </Button>
            <Button asChild size="sm" variant="ghost">
              <Link to={`/launch?safe=${safe}`}>
                <Plus /> Add a token
              </Link>
            </Button>
          </div>
        </div>
        <CardDescription className="flex flex-wrap items-center gap-2">
          <span>
            {check.threshold} of {check.owners.length} owners
          </span>
          {check.moduleEnabled ? <Badge variant="outline" className="border-filled text-filled">Mandate enabled</Badge> : <Badge variant="outline">Mandate not enabled</Badge>}
        </CardDescription>
        <ul className="space-y-1 text-sm">
          {check.owners.map((o) => (
            <li key={o}>
              <AddressLink label={roleOf(o) ?? "Owner"} value={o} />
            </li>
          ))}
        </ul>
      </CardHeader>
      <CardContent className="space-y-4">
        {summary.isPending && <Skeleton className="h-24 w-full" />}
        {!summary.isPending && bases.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No token in this Safe yet. <Link to={`/launch?safe=${safe}`} className="underline underline-offset-4">Launch one</Link>.
          </p>
        )}
        {bases.map((base) => (
          <TokenRow
            key={base}
            safe={safe}
            base={getAddress(base)}
            policy={policyFor(base)}
            launched={launched.find((t) => same(t.token, base))}
            {...(demoPair && same(demoPair.base, base) ? { quoteHint: demoPair.quote } : {})}
          />
        ))}
      </CardContent>
    </Card>
  );
}

/** A token in a Safe: what it is, what it trades against, the pool and oracle, the policy and its strategies. */
function TokenRow({
  safe,
  base,
  policy,
  launched,
  quoteHint,
}: {
  safe: Address;
  base: Address;
  policy: PolicySummary | undefined;
  launched: LaunchedToken | undefined;
  /** The reference token when there is no policy to say it (the deployment's demo pair). */
  quoteHint?: Address;
}) {
  const [open, setOpen] = useState(false);
  const quote = policy ? getAddress(policy.quote) : (quoteHint ?? null);
  const baseInfo = useTokenInfo(policy || launched ? null : base, safe);
  const quoteInfo = useTokenInfo(policy ? null : quote, safe);
  const pool = useAnchorStatus(base, quote);
  const fromInfo = (info: typeof baseInfo.info): TokenDisplay | null => (info?.ok ? { symbol: info.symbol, decimals: info.decimals } : null);
  const baseToken: TokenDisplay =
    policy?.tokens.base ?? (launched ? { symbol: launched.symbol, decimals: LAUNCH_DECIMALS } : fromInfo(baseInfo.info) ?? { symbol: "TOKEN", decimals: 18 });
  const quoteToken: TokenDisplay = policy?.tokens.quote ?? fromInfo(quoteInfo.info) ?? { symbol: "QUOTE", decimals: 18 };
  const c = policy?.config;
  const p = pool.data;

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold">{baseToken.symbol}</h3>
        {launched && <span className="text-sm text-muted-foreground">{launched.name}</span>}
        {launched && <Badge variant="outline">launched by you</Badge>}
        {policy && <StatusPill status={policy.status} />}
        {policy && policy.status !== 3 && <RiskBadge mode={policy.riskMode} reason={policy.riskReason} />}
      </div>

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
        <dt className="text-muted-foreground">Token</dt>
        <dd>
          <AddressLink value={base} kind="token" />
          {launched && (
            <span className="block text-xs text-muted-foreground">
              Supply {formatUnits(launched.supply, LAUNCH_DECIMALS, 0)} {launched.symbol} · launched {new Date(Number(launched.timestamp) * 1000).toLocaleString("en")}
            </span>
          )}
        </dd>

        <dt className="text-muted-foreground">Reference token</dt>
        <dd>
          {quote ? (
            <>
              <b>{quoteToken.symbol}</b> <AddressLink value={quote} kind="token" />
            </>
          ) : (
            <span className="text-muted-foreground">Chosen with the policy. <Link to={`/launch?safe=${safe}&base=${base}`} className="underline underline-offset-4">Continue setup</Link></span>
          )}
        </dd>

        {quote && (
          <>
            <dt className="text-muted-foreground">Uniswap v4 pool</dt>
            <dd>
              {p?.poolExists ? (
                <>
                  <AddressLink
                    value={p.poolId}
                    kind="id"
                    {...(isLive ? { href: `https://app.uniswap.org/explore/pools/base/${p.poolId}`, hrefLabel: "Open on Uniswap" } : {})}
                  />
                  <span className="block text-xs text-muted-foreground">
                    Price {formatPrice(p.spotPriceX36, baseToken.decimals, quoteToken.decimals)} {quoteToken.symbol} per {baseToken.symbol} ·
                    {p.liquidity > 0n ? " has liquidity" : " no liquidity yet"}
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">{pool.isPending ? "Reading…" : "No pool yet"}</span>
              )}
            </dd>
            <dt className="text-muted-foreground">Oracle</dt>
            <dd>{c ? <AddressLink value={getAddress(c.oracle.oracle)} /> : p?.anchor ? <AddressLink value={p.anchor} /> : "—"}</dd>
            {p?.poolExists && (
              <>
                <dt className="text-muted-foreground">Hook</dt>
                <dd>
                  <AddressLink value={getAddress(p.poolKey.hooks)} />
                </dd>
              </>
            )}
          </>
        )}

        <dt className="text-muted-foreground">Treasury policy</dt>
        <dd>
          {policy && c ? (
            <>
              <AddressLink value={policy.policyId} kind="id" href={`/policies/${policy.policyId}`} hrefLabel="Open the policy page" />
              <span className="block text-xs text-muted-foreground">
                Sold this period {formatUnits(policy.grossSold, baseToken.decimals, 0)} of {formatUnits(c.period.grossSellCap, baseToken.decimals, 0)} {baseToken.symbol} ·
                net {formatUnits(policy.netSold, baseToken.decimals, 0)} of {formatUnits(c.period.netSellCap, baseToken.decimals, 0)} · released{" "}
                {formatUnits(policy.released, baseToken.decimals, 0)} of {formatUnits(c.release.allotment, baseToken.decimals, 0)}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">
              None yet. <Link to={`/launch?safe=${safe}&base=${base}`} className="underline underline-offset-4">Set one up</Link>
            </span>
          )}
        </dd>

        {policy && (
          <>
            <dt className="text-muted-foreground">Liquidity</dt>
            <dd>
              <ReportSummary policyId={policy.policyId} base={baseToken} quote={quoteToken} />
            </dd>
            <dt className="text-muted-foreground">Strategies</dt>
            <dd className="space-y-2">
              {policy.strategies.length === 0 && <span className="text-muted-foreground">None yet.</span>}
              {policy.strategies.map((s) => (
                <div key={s.strategyId} className="space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill status={s.status} />
                    <span>{s.kind === 1 ? "Buyback" : "Market making"}</span>
                    <span className="text-xs text-muted-foreground">
                      {s.fills} fills · spread {s.spreadBps !== null ? `${(s.spreadBps / 100).toFixed(2)}%` : "—"}
                    </span>
                  </div>
                  <AddressLink label="Strategy" value={s.strategyId} kind="id" href={`/strategies/${s.strategyId}`} hrefLabel="Open the strategy page" />
                  <div>
                    <AddressLink label={roleOf(s.mm) ?? "Market maker"} value={getAddress(s.mm)} />
                  </div>
                </div>
              ))}
            </dd>
          </>
        )}
      </dl>

      {policy && c && (
        <div>
          <Button variant="ghost" size="sm" onClick={() => setOpen(!open)} aria-expanded={open}>
            <ChevronDown className={open ? "rotate-180 transition-transform" : "transition-transform"} /> {open ? "Hide" : "Show"} the policy's terms
          </Button>
          {open && (
            <div className="mt-2 rounded-lg border p-4">
              <PolicySheet config={c} base={baseToken} quote={quoteToken} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One line from the policy's liquidity report, linking to the full report on the policy page. */
function ReportSummary({ policyId, base, quote }: { policyId: string; base: TokenDisplay; quote: TokenDisplay }) {
  const insights = useInsights({ kind: "policy", id: policyId });
  const t = insights.data?.data.totals;
  if (!t) return <span className="text-muted-foreground">{insights.isPending ? "Reading…" : "No report yet"}</span>;
  const refused = (insights.data?.data.refusals ?? []).reduce((n, r) => n + r.count, 0);
  return (
    <span>
      {t.trades} trades by {t.unique_takers} {t.unique_takers === 1 ? "trader" : "traders"} · {formatUnits(t.base_sold, base.decimals, 0)} {base.symbol} to
      buyers, {formatUnits(t.base_bought_back, base.decimals, 0)} bought back · MM earned {formatUnits(t.mm_fees_quote, quote.decimals, 2)} {quote.symbol} ·{" "}
      {refused} refused ·{" "}
      <Link to={`/policies/${policyId}`} className="underline underline-offset-4">
        full report
      </Link>
    </span>
  );
}

