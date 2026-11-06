import { useState } from "react";
import { Link } from "react-router";
import type { Address } from "viem";

import { Hex } from "@/components/status";
import { Button } from "@/components/ui/button";
import { CreateMandateForm } from "@/issuer/CreateMandateForm";
import { decodeTerms, encodeTerms, STANDARD_RAILS, type Holdings, type TokenRef } from "@/issuer/terms";

import type { SafeMandate } from "./useSafeMandates";

/**
 * Step 5: the owners create the mandate for the chosen pair, priced against its launched anchor. Amounts, floor and
 * market maker start blank (they are the issuer's decisions); the risk rails start at the demo's standard values.
 * Reviewed terms are kept in the URL so co-owners open the same link and approve the same Safe transaction.
 */
export function MandateStep({
  safe,
  threshold,
  base,
  quote,
  anchor,
  anchorReady,
  anchorPriceX36,
  holdings,
  mandates,
  termsParam,
  onTerms,
  onCreated,
}: {
  safe: Address;
  threshold: number;
  base: TokenRef;
  quote: TokenRef;
  anchor: Address;
  anchorReady: boolean;
  /** Current price of the anchor's pool. */
  anchorPriceX36: bigint | undefined;
  holdings: Holdings;
  /** Live (not revoked) mandates of this Safe for this pair. */
  mandates: readonly SafeMandate[];
  termsParam: string | null;
  onTerms: (encoded: string | null) => void;
  onCreated: () => void;
}) {
  // Decoded once: later URL updates come from this form itself and must not reset what the owner is typing.
  const [shared] = useState(() => decodeTerms(termsParam));
  const [copied, setCopied] = useState(false);

  if (mandates.length > 0) {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-filled">This Safe has a mandate for {base.symbol}/{quote.symbol}.</p>
        {mandates.map((m) => (
          <p key={m.id}>
            <Link to={`/mandates/${m.id}`} className="font-mono underline underline-offset-4">
              {m.id.slice(0, 10)}…
            </Link>{" "}
            · market maker <Hex value={m.mm} /> {m.status === 2 && <span className="text-muted-foreground">(paused)</span>}
          </p>
        ))}
        <p className="text-muted-foreground">
          The market maker runs it from the <Link to="/desk" className="underline underline-offset-4">MM Desk</Link>; the owners manage it
          from the <Link to={`/issuer?safe=${safe}`} className="underline underline-offset-4">Issuer Console</Link>.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {!anchorReady && (
        <p className="text-sm text-muted-foreground">
          You can create the mandate now. Fills start once the anchor has its full price history.
        </p>
      )}
      {termsParam && threshold > 1 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm">
          <span>This Safe needs {threshold} approvals. Send this page's link to the other owners so they approve the same terms.</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void navigator.clipboard.writeText(window.location.href).then(() => setCopied(true), () => setCopied(false))}
          >
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
      )}
      <CreateMandateForm
        safe={safe}
        base={base}
        quote={quote}
        anchor={anchor}
        holdings={holdings}
        {...(anchorPriceX36 !== undefined ? { anchorPriceX36 } : {})}
        initial={shared ?? STANDARD_RAILS}
        startInReview={Boolean(shared)}
        onReview={(terms) => {
          setCopied(false);
          onTerms(terms ? encodeTerms(terms) : null);
        }}
        onDone={onCreated}
      />
    </div>
  );
}
