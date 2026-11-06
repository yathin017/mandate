import { mandateTermsTypedData, termsFromJson } from "@mandate/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { getAddress, type Address } from "viem";
import { useBlock, useConnection, useSignTypedData } from "wagmi";

import { Hex } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ReviewTerms } from "@/issuer/CreateMandateForm";
import { api } from "@/lib/api";
import { formatUnits } from "@/lib/format";
import type { Proposal } from "@/lib/types";
import { useTokenInfo } from "@/onboarding/useTokenInfo";
import { SignInButton } from "@/wallet/ConnectButton";
import { demoChain, deployment } from "@/wallet/config";
import { useSession } from "@/wallet/session";

const inboxKey = ["proposals", "inbox"] as const;

/**
 * Proposals addressed to the connected market maker. Accepting signs the exact terms (EIP-712, no gas); the issuer's
 * owners then create the mandate. Nothing is custodied or moved by accepting.
 */
export function Inbox() {
  const { signedIn } = useSession();
  const proposals = useQuery({ queryKey: inboxKey, queryFn: api.proposalsForMe, enabled: signedIn, refetchInterval: 15_000 });

  if (!signedIn) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        Proposals are private to you and the issuer. <SignInButton />
      </div>
    );
  }
  if (proposals.isPending) return <Skeleton className="h-40 w-full" />;
  if (proposals.isError) return <p className="text-sm text-blocked">{proposals.error.message}</p>;
  const rows = proposals.data.data;
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No proposals yet. Issuers find you through the marketplace: keep your <Link to="/desk?tab=profile" className="underline underline-offset-4">profile</Link> listed.
      </p>
    );
  }
  const open = rows.filter((p) => p.status === "sent");
  const rest = rows.filter((p) => p.status !== "sent");
  return (
    <div className="space-y-6">
      {open.length > 0 && <p className="text-sm font-medium">{open.length} waiting for your answer</p>}
      {[...open, ...rest].map((p) => (
        <ProposalCard key={p.id} proposal={p} />
      ))}
    </div>
  );
}

const STATUS_TEXT: Record<Proposal["status"], string> = {
  draft: "Draft",
  sent: "Waiting for you",
  accepted: "Accepted: waiting for the issuer's owners to execute",
  executed: "Live",
  declined: "Declined",
  withdrawn: "Withdrawn by the issuer",
  expired: "Expired",
};

function ProposalCard({ proposal: p }: { proposal: Proposal }) {
  const client = useQueryClient();
  const { address } = useConnection();
  const { signTypedDataAsync } = useSignTypedData();
  const block = useBlock({ chainId: demoChain.id, query: { refetchInterval: false } });
  const base = useTokenInfo(p.base, p.safe);
  const quote = useTokenInfo(p.quote, p.safe);
  const terms = termsFromJson(p.terms);
  const refresh = () => client.invalidateQueries({ queryKey: inboxKey });

  const accept = useMutation({
    mutationFn: async () => {
      // The wallet shows these exact fields; the API checks the signature against the stored terms.
      const typed = mandateTermsTypedData(deployment, { proposalId: p.id, safe: getAddress(p.safe), terms, expiresAt: BigInt(p.expiresAt) });
      const signature = await signTypedDataAsync(typed);
      return api.acceptProposal(p.id, signature);
    },
    onSettled: refresh,
  });
  const decline = useMutation({ mutationFn: () => api.proposalAction(p.id, "decline"), onSettled: refresh });

  const b = base.info?.ok ? { address: base.info.address, symbol: base.info.symbol, decimals: base.info.decimals } : null;
  const q = quote.info?.ok ? { address: quote.info.address, symbol: quote.info.symbol, decimals: quote.info.decimals } : null;
  const isMe = address?.toLowerCase() === p.mm;
  const shortOfInventory = b && base.balance !== undefined && base.balance < terms.params.shippedBase;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {b?.symbol ?? "…"} / {q?.symbol ?? "…"}
          <Badge variant="outline">{STATUS_TEXT[p.status]}</Badge>
        </CardTitle>
        <CardDescription>
          From Safe <Hex value={p.safe} /> · expires {new Date(p.expiresAt * 1000).toLocaleDateString("en")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {p.note && <p className="rounded-md bg-muted p-3 text-sm whitespace-pre-line">“{p.note}”</p>}
        {b && q ? (
          <ReviewTerms built={terms} base={b} quote={q} anchor={terms.bounds.anchor} now={block.data?.timestamp} />
        ) : (
          <Skeleton className="h-48 w-full" />
        )}
        {b && base.balance !== undefined && (
          <p className={shortOfInventory ? "text-sm text-warning" : "text-sm text-muted-foreground"}>
            The Safe holds {formatUnits(base.balance, b.decimals, 0)} {b.symbol}
            {shortOfInventory && ", less than the initial inventory: fills would fail until it is funded"}.
          </p>
        )}
        {p.status === "sent" && (
          <div className="flex flex-wrap gap-2">
            <Button disabled={!isMe || accept.isPending} onClick={() => accept.mutate()}>
              {accept.isPending ? "Waiting for signature…" : "Accept and sign"}
            </Button>
            <Button variant="ghost" disabled={decline.isPending} onClick={() => decline.mutate()}>
              Decline
            </Button>
            {!isMe && <p className="text-sm text-muted-foreground">Connect <Hex value={p.mm as Address} /> to answer.</p>}
          </div>
        )}
        {p.status === "executed" && p.mandateId && (
          <Button asChild variant="outline">
            <Link to={`/mandates/${p.mandateId}`}>Open the mandate</Link>
          </Button>
        )}
        {(accept.error ?? decline.error) && <p className="text-sm text-blocked">{(accept.error ?? decline.error)!.message}</p>}
      </CardContent>
    </Card>
  );
}
