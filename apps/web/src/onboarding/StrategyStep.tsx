import { useState } from "react";
import { Link } from "react-router";
import type { Address } from "viem";

import { Hex } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProposalList } from "@/issuer/ProposalList";
import { MarketMakerPicker, SendProposal } from "@/issuer/ProposeTerms";
import { StrategyForm } from "@/issuer/StrategyForm";
import { decodeTerms, encodeTerms, type Holdings, type TokenRef } from "@/issuer/terms";
import { useBacking } from "@/issuer/useBacking";

import type { SafePolicy } from "./useSafePolicy";

/**
 * Step 6: a strategy under the policy, run by a market maker: proposed (the market maker signs the exact terms, then
 * the owners add it) or added directly. Terms start from suggestions the issuer edits; nothing is signed before review. Reviewed direct terms are
 * kept in the URL so co-owners approve the same Safe transaction.
 */
export function StrategyStep({
  safe,
  threshold,
  base,
  quote,
  policy,
  anchorPriceX36,
  termsParam,
  onTerms,
  onCreated,
  mode,
  onMode,
  mm,
  onMm,
}: {
  safe: Address;
  threshold: number;
  base: TokenRef;
  quote: TokenRef;
  policy: SafePolicy;
  anchorPriceX36: bigint | undefined;
  termsParam: string | null;
  onTerms: (encoded: string | null) => void;
  onCreated: () => void;
  mode: "propose" | "direct";
  onMode: (mode: "propose" | "direct") => void;
  mm: string | null;
  onMm: (mm: string | null) => void;
}) {
  const [shared] = useState(() => decodeTerms(termsParam));
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(0);
  const [another, setAnother] = useState(false);
  const backing = useBacking(safe, base.address, quote.address);
  const holdings: Holdings | undefined = backing.data ? { base: backing.data.base, quote: backing.data.quote } : undefined;
  const rules = { floorPriceX36: policy.config.price.floorPriceX36, maxQuoteDeviationBps: Number(policy.config.price.maxQuoteDeviationBps) };
  const live = policy.strategies.filter((s) => s.status !== 3);

  if (live.length > 0 && !another) {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-filled">This policy runs {live.length === 1 ? "a strategy" : `${live.length} strategies`}.</p>
        {live.map((s) => (
          <p key={s.id}>
            <Link to={`/strategies/${s.id}`} className="font-mono underline underline-offset-4">
              {s.id.slice(0, 10)}…
            </Link>{" "}
            · {s.kind === 1 ? "buyback" : "market making"} · market maker <Hex value={s.mm} />{" "}
            {s.status === 2 && <span className="text-muted-foreground">(paused)</span>}
          </p>
        ))}
        <p className="text-muted-foreground">
          Market makers run them from the <Link to="/desk" className="underline underline-offset-4">desk</Link>; the owners
          manage them from the <Link to={`/issuer?safe=${safe}`} className="underline underline-offset-4">issuer console</Link>.
          All of them share the policy's limits.
        </p>
        <Button size="sm" variant="outline" onClick={() => setAnother(true)}>
          Add another strategy
        </Button>
      </div>
    );
  }

  const limits = {
    normalMinSpreadBps: Number(policy.config.normal.minSpreadBps),
    grossSellCapBase: BigInt(policy.config.period.grossSellCap),
    periodSeconds: Number(policy.config.period.periodLength),
  };
  const common = { safe, base, quote, policyId: policy.id, policy: rules, limits, ...(holdings ? { holdings } : {}), ...(anchorPriceX36 !== undefined ? { anchorPriceX36 } : {}) };
  const direct = (
    <div className="space-y-4">
      {termsParam && threshold > 1 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm">
          <span>This Safe needs {threshold} approvals. Send this page's link to the other owners so they approve the same terms.</span>
          <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(window.location.href).then(() => setCopied(true), () => setCopied(false))}>
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
      )}
      <StrategyForm
        {...common}
        {...(shared ? { initial: shared, startInReview: true } : {})}
        onReview={(terms) => {
          setCopied(false);
          onTerms(terms ? encodeTerms(terms) : null);
        }}
        onDone={onCreated}
      />
    </div>
  );

  const samePair = (p: { base: string; quote: string }) => p.base === base.address.toLowerCase() && p.quote === quote.address.toLowerCase();
  const propose = (
    <div className="space-y-6">
      <MarketMakerPicker value={mm} onChange={onMm} />
      {mm && (
        <StrategyForm
          key={`${mm}:${sent}`}
          {...common}
          marketMaker={mm}
          renderReviewAction={(built) => <SendProposal safe={safe} base={base} quote={quote} built={built} onSent={() => setSent((n) => n + 1)} />}
        />
      )}
      <div className="space-y-2">
        <p className="font-medium">Proposals for {base.symbol}/{quote.symbol}</p>
        <ProposalList safe={safe} filter={samePair} tokens={() => ({ base, quote })} onExecuted={onCreated} />
      </div>
    </div>
  );

  return (
    <Tabs value={shared ? "direct" : mode} onValueChange={(v) => onMode(v as "propose" | "direct")}>
      <TabsList>
        <TabsTrigger value="propose">Propose to a market maker</TabsTrigger>
        <TabsTrigger value="direct">Add directly</TabsTrigger>
      </TabsList>
      <TabsContent value="propose" className="pt-4">
        {propose}
      </TabsContent>
      <TabsContent value="direct" className="space-y-2 pt-4">
        <p className="text-sm text-muted-foreground">For terms already agreed elsewhere: the owners add the strategy without a signed acceptance.</p>
        {direct}
      </TabsContent>
    </Tabs>
  );
}
