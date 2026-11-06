import { buildAddStrategyCall, mandateModuleAbi, termsFromJson } from "@mandate/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { Address, Hash, PublicClient } from "viem";
import { useConnection, usePublicClient, useReadContract } from "wagmi";

import { ScoreBadge } from "@/components/score";
import { Hex } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { formatBps, formatPrice, formatUnits } from "@/lib/format";
import { useMmProfiles, useMmScores } from "@/lib/hooks";
import type { Proposal, ProposalStatus, TokenDisplay } from "@/lib/types";
import { SignInButton } from "@/wallet/ConnectButton";
import { demoChain, deployment } from "@/wallet/config";
import { SafeActionPanel } from "@/wallet/SafeActionPanel";
import { useSession } from "@/wallet/session";

export const proposalsKey = (safe: string) => ["proposals", "safe", safe.toLowerCase()] as const;

const STATUS: Record<ProposalStatus, { label: string; tone: string }> = {
  draft: { label: "Draft", tone: "border-muted-foreground/40 text-muted-foreground" },
  sent: { label: "Waiting for the market maker", tone: "border-warning text-warning" },
  accepted: { label: "Accepted: ready to execute", tone: "border-filled text-filled" },
  executed: { label: "Executed", tone: "bg-filled text-filled-foreground" },
  declined: { label: "Declined", tone: "border-blocked text-blocked" },
  withdrawn: { label: "Withdrawn", tone: "text-muted-foreground" },
  expired: { label: "Expired", tone: "text-muted-foreground" },
};

/**
 * An issuer Safe's proposals and their next step: send a draft, wait for the market maker, then (once it signed the
 * exact terms) add the strategy through the Safe under its policy for the pair and link it. Listing needs a signed-in
 * owner.
 */
export function ProposalList({
  safe,
  tokens,
  filter,
  onExecuted,
}: {
  safe: Address;
  /** Display metadata for a proposal's pair, when the caller knows it. */
  tokens?: (p: Proposal) => { base: TokenDisplay; quote: TokenDisplay } | undefined;
  filter?: (p: Proposal) => boolean;
  /** Called once a proposal is linked to its new strategy. */
  onExecuted?: () => void;
}) {
  const { signedIn } = useSession();
  const { address } = useConnection();
  const proposals = useQuery({ queryKey: proposalsKey(safe), queryFn: () => api.proposalsForSafe(safe), enabled: signedIn, refetchInterval: 15_000 });

  if (!address) return <p className="text-sm text-muted-foreground">Connect a Safe owner's wallet to see proposals.</p>;
  if (!signedIn) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        Proposals are private to the Safe's owners and the market maker. <SignInButton />
      </div>
    );
  }
  if (proposals.isPending) return <p className="text-sm text-muted-foreground">Loading proposals…</p>;
  if (proposals.isError) return <p className="text-sm text-blocked">{proposals.error.message}</p>;
  const rows = proposals.data.data.filter(filter ?? (() => true));
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No proposals yet.</p>;
  return (
    <ul className="space-y-3">
      {rows.map((p) => (
        <ProposalRow key={p.id} safe={safe} proposal={p} tokens={tokens?.(p)} {...(onExecuted ? { onExecuted } : {})} />
      ))}
    </ul>
  );
}

function ProposalRow({
  safe,
  proposal: p,
  tokens,
  onExecuted,
}: {
  safe: Address;
  proposal: Proposal;
  tokens: { base: TokenDisplay; quote: TokenDisplay } | undefined;
  onExecuted?: () => void;
}) {
  const client = useQueryClient();
  const publicClient = usePublicClient({ chainId: demoChain.id }) as PublicClient | undefined;
  const profiles = useMmProfiles();
  const scores = useMmScores();
  const name = profiles.data?.data.find((x) => x.address === p.mm)?.displayName;
  const score = scores.data?.data.scores.find((s) => s.mm === p.mm);
  const refresh = () => client.invalidateQueries({ queryKey: proposalsKey(safe) });
  const act = useMutation({ mutationFn: (action: "send" | "withdraw") => api.proposalAction(p.id, action), onSettled: refresh });

  // The strategy is added under the Safe's live policy for the pair.
  const policyId = useReadContract({
    address: deployment.module,
    abi: mandateModuleAbi,
    functionName: "activePolicyOf",
    args: [safe, p.base as Address],
    chainId: demoChain.id,
  }).data as Hash | undefined;
  const hasPolicy = policyId !== undefined && !/^0x0{64}$/.test(policyId);

  // After the Safe executes addStrategy, link the new strategy. The API accepts only a strategy whose Safe, market
  // maker, pair, kind and bounds match the accepted terms, so trying the policy's newest strategies first is safe.
  const link = useMutation({
    mutationFn: async () => {
      if (!publicClient) throw new Error("No chain connection");
      if (!hasPolicy) throw new Error("This Safe has no live policy for the pair yet");
      const ids = await publicClient.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "strategiesOf", args: [policyId] });
      let lastError: unknown = new Error("No strategy found under this policy yet");
      for (const id of [...ids].reverse().slice(0, 5)) {
        try {
          return await api.markExecuted(p.id, id);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    },
    onSuccess: () => onExecuted?.(),
    onSettled: refresh,
  });

  // Before offering to execute, check whether the Safe already added this strategy (e.g. linking failed last time):
  // executing again would add a second strategy from the same terms.
  const [checkedExisting, setCheckedExisting] = useState(false);
  /** Set once the owners executed here; only then is a failed link worth showing (the pre-check fails by design). */
  const [executedHere, setExecutedHere] = useState(false);
  const { mutate: relink } = link;
  useEffect(() => {
    if (p.status !== "accepted" || !hasPolicy) return;
    setCheckedExisting(false);
    relink(undefined, { onSettled: () => setCheckedExisting(true) });
  }, [p.id, p.status, relink, hasPolicy]);

  const t = p.terms;
  const b = tokens?.base ?? { symbol: "base", decimals: 18 };
  const q = tokens?.quote ?? { symbol: "quote", decimals: 18 };
  const expired = p.expiresAt * 1000 < Date.now();

  return (
    <li className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link to={`/market-makers/${p.mm}`} className="font-medium underline-offset-4 hover:underline">
          {name ?? <Hex value={p.mm} />}
        </Link>
        <ScoreBadge score={score} />
        <Badge variant="outline" className={STATUS[p.status].tone}>
          {STATUS[p.status].label}
        </Badge>
        <span className="ml-auto text-xs text-muted-foreground">
          {["draft", "sent", "accepted"].includes(p.status) && !expired ? `expires ${new Date(p.expiresAt * 1000).toLocaleDateString("en")}` : ""}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        {t.kind === "1" ? `Buyback up to ${formatPrice(t.bounds.maxBuyPriceX36, b.decimals, q.decimals, 6)} ${q.symbol}` : "Market making"} · spread{" "}
        {formatBps(t.params.spreadBps)} ({formatBps(t.bounds.spreadBpsMin)}–{formatBps(t.bounds.spreadBpsMax)}) · ships{" "}
        {formatUnits(t.params.shippedBase, b.decimals, 0)} {b.symbol} and {formatUnits(t.params.shippedQuote, q.decimals, 0)} {q.symbol} · MM fee
        share {formatBps(t.bounds.mmFeeShareBps)}
      </p>
      {p.note && <p className="text-sm whitespace-pre-line">“{p.note}”</p>}

      <div className="flex flex-wrap gap-2">
        {p.status === "draft" && (
          <Button size="sm" disabled={act.isPending} onClick={() => act.mutate("send")}>
            Send to market maker
          </Button>
        )}
        {(p.status === "draft" || p.status === "sent" || p.status === "accepted") && (
          <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => act.mutate("withdraw")}>
            Withdraw
          </Button>
        )}
        {p.status === "executed" && p.strategyId && (
          <Button asChild size="sm" variant="outline">
            <Link to={`/strategies/${p.strategyId}`}>Open strategy</Link>
          </Button>
        )}
      </div>
      {act.error && <p className="text-sm text-blocked">{act.error.message}</p>}

      {p.status === "accepted" && !hasPolicy && (
        <p className="text-sm text-warning">
          The market maker signed. Create the treasury policy for this pair first; the strategy runs under it.
        </p>
      )}
      {p.status === "accepted" && hasPolicy && !checkedExisting && <p className="text-sm text-muted-foreground">Checking the policy for this strategy…</p>}
      {p.status === "accepted" && hasPolicy && checkedExisting && (
        <div className="space-y-2">
          <p className="text-sm">
            The market maker signed these exact terms. The Safe's owners now approve and add the strategy.
          </p>
          <SafeActionPanel
            safe={safe}
            call={addCall(policyId, t)}
            label="Add the accepted strategy"
            {...(tokens ? { context: tokens } : {})}
            onDone={() => {
              setExecutedHere(true);
              link.mutate();
            }}
          />
          {link.isPending && <p className="text-sm text-muted-foreground">Linking the new strategy…</p>}
          {link.error && executedHere && (
            <p className="text-sm text-blocked">
              {link.error.message}{" "}
              <Button size="sm" variant="link" onClick={() => link.mutate()}>
                Retry
              </Button>
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/** addStrategy for accepted terms under `policyId`; exactly the terms the market maker signed. */
function addCall(policyId: Hash, json: Proposal["terms"]) {
  const terms = termsFromJson(json);
  return buildAddStrategyCall(deployment, { policyId, marketMaker: terms.marketMaker, kind: terms.kind, bounds: terms.bounds, params: terms.params });
}
