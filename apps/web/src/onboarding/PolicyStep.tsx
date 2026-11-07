import { useState } from "react";
import { Link } from "react-router";
import type { Address } from "viem";

import { Button } from "@/components/ui/button";
import type { MarketSnapshot } from "@/issuer/explain";
import { PolicyForm } from "@/issuer/PolicyForm";
import { decodePolicy, encodePolicy } from "@/issuer/policy";
import type { TokenRef } from "@/issuer/terms";

import type { SafePolicy } from "./useSafePolicy";

/**
 * Step 5: the owners set the treasury policy for the token: its release, per-period limits, price rules and market
 * risk thresholds. The form starts from suggested values the owner edits. Reviewed values are kept in the URL so
 * co-owners open the same link and approve the same Safe transaction.
 */
export function PolicyStep({
  safe,
  threshold,
  base,
  quote,
  oracle,
  holdings,
  market,
  policy,
  policyParam,
  onPolicy,
  onCreated,
}: {
  safe: Address;
  threshold: number;
  base: TokenRef;
  quote: TokenRef;
  oracle: Address;
  holdings: { base?: bigint; quote?: bigint };
  /** The pair's pool as last read: the form sizes its suggestions and explanations from it. */
  market?: MarketSnapshot;
  /** The Safe's live policy for the token, if any. */
  policy: SafePolicy | null;
  policyParam: string | null;
  onPolicy: (encoded: string | null) => void;
  onCreated: () => void;
}) {
  // Decoded once: later URL updates come from this form itself and must not reset what the owner is typing.
  const [shared] = useState(() => decodePolicy(policyParam));
  const [copied, setCopied] = useState(false);

  if (policy) {
    const otherQuote = policy.quote.toLowerCase() !== quote.address.toLowerCase();
    return (
      <div className="space-y-2 text-sm">
        <p className="text-filled">This Safe has a {policy.status === 2 ? "paused " : ""}treasury policy for {base.symbol}.</p>
        {otherQuote && (
          <p className="text-warning">
            Its policy uses another quote token: one Safe has one policy per token. Revoke it in the issuer console to
            start over with {quote.symbol}.
          </p>
        )}
        <p className="text-muted-foreground">
          Review or change it from the <Link to={`/issuer?safe=${safe}`} className="underline underline-offset-4">issuer console</Link>.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {policyParam && threshold > 1 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm">
          <span>This Safe needs {threshold} approvals. Send this page's link to the other owners so they approve the same policy.</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void navigator.clipboard.writeText(window.location.href).then(() => setCopied(true), () => setCopied(false))}
          >
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
      )}
      <PolicyForm
        safe={safe}
        base={base}
        quote={quote}
        oracle={oracle}
        holdings={holdings}
        {...(market ? { market } : {})}
        {...(shared ? { initial: shared, startInReview: true } : {})}
        onReview={(terms) => {
          setCopied(false);
          onPolicy(terms ? encodePolicy(terms) : null);
        }}
        onDone={onCreated}
      />
    </div>
  );
}
