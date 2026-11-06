import { buildCreateMandateCall, mandateModuleAbi, termsFromJson } from "@mandate/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { Address, PublicClient } from "viem";
import { useConnection, usePublicClient } from "wagmi";

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
 * exact terms) execute createMandate through the Safe and link the new mandate. Listing needs a signed-in owner.
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
  /** Called once a proposal is linked to its new mandate. */
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

  // After the Safe executes createMandate, link the new mandate. The API accepts only a mandate whose Safe, market
  // maker, pair and bounds match the accepted terms, so trying the Safe's newest mandates first is safe.
  const link = useMutation({
    mutationFn: async () => {
      if (!publicClient) throw new Error("No chain connection");
      const ids = await publicClient.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "mandatesOf", args: [safe] });
      let lastError: unknown = new Error("No mandate found for this Safe yet");
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

  // Before offering to execute, check whether the Safe already created this mandate (e.g. linking failed last time):
  // executing again would create a second mandate from the same terms.
  const [checkedExisting, setCheckedExisting] = useState(false);
  /** Set once the owners executed here; only then is a failed link worth showing (the pre-check fails by design). */
  const [executedHere, setExecutedHere] = useState(false);
  const { mutate: relink } = link;
  useEffect(() => {
    if (p.status !== "accepted") return;
    setCheckedExisting(false);
    relink(undefined, { onSettled: () => setCheckedExisting(true) });
  }, [p.id, p.status, relink]);

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
        {formatUnits(t.bounds.allotment, b.decimals, 0)} {b.symbol} over {Number(t.bounds.releaseDuration) / 86_400} days · daily cap{" "}
        {formatUnits(t.bounds.maxEpochCap, b.decimals, 0)} · floor {formatPrice(t.bounds.floorPriceX36, b.decimals, q.decimals, 6)} {q.symbol} ·
        spread {formatBps(t.params.spreadBps)} · MM fee share {formatBps(t.bounds.mmFeeShareBps)}
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
        {p.status === "executed" && p.mandateId && (
          <Button asChild size="sm" variant="outline">
            <Link to={`/mandates/${p.mandateId}`}>Open mandate</Link>
          </Button>
        )}
      </div>
      {act.error && <p className="text-sm text-blocked">{act.error.message}</p>}

      {p.status === "accepted" && !checkedExisting && <p className="text-sm text-muted-foreground">Checking the Safe for this mandate…</p>}
      {p.status === "accepted" && checkedExisting && (
        <div className="space-y-2">
          <p className="text-sm">
            The market maker signed these exact terms. The Safe's owners now approve and execute the mandate.
          </p>
          <SafeActionPanel
            safe={safe}
            call={buildCreateMandateCall(deployment, termsFromJson(t))}
            label="Create the accepted mandate"
            {...(tokens ? { context: tokens } : {})}
            onDone={() => {
              setExecutedHere(true);
              link.mutate();
            }}
          />
          {link.isPending && <p className="text-sm text-muted-foreground">Linking the new mandate…</p>}
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
