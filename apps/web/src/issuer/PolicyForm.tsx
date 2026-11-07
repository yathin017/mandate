import { buildCreatePolicyCall, buildUpdatePolicyCall } from "@mandate/sdk";
import { useEffect, useMemo, useState } from "react";
import type { Address, Hash } from "viem";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PolicySheet } from "@/components/TermSheet";
import { deployment } from "@/wallet/config";
import { SafeActionPanel } from "@/wallet/SafeActionPanel";

import { buildPolicy, EMPTY_POLICY, type BuiltPolicy, type PolicyTerms } from "./policy";
import type { TokenRef } from "./terms";

type Unit = "base" | "quote" | "price" | "%" | "days" | "hours" | "minutes" | "date" | "yesno";
type Field = { key: keyof PolicyTerms; label: string; hint: string; unit: Unit };

/** The policy form, grouped as the issuer reasons about it. Every field starts empty. */
const SECTIONS: { title: string; description: string; fields: Field[] }[] = [
  {
    title: "Release",
    description: "How much of the token the treasury may ever sell, net of buybacks, and how fast it unlocks.",
    fields: [
      { key: "allotment", label: "Allotment", hint: "Most the treasury may ever net sell.", unit: "base" },
      { key: "releaseStart", label: "Release start", hint: "Inventory unlocks linearly from this day (UTC).", unit: "date" },
      { key: "releaseDays", label: "Release duration", hint: "Days until the whole allotment is unlocked.", unit: "days" },
    ],
  },
  {
    title: "Per-period limits",
    description: "Shared by every strategy of this treasury. Reships and new strategies never reset them.",
    fields: [
      { key: "periodHours", label: "Period length", hint: "Limits below reset at the end of each period.", unit: "hours" },
      { key: "grossCap", label: "Gross sell limit", hint: "Every sale counts, even if bought back later.", unit: "base" },
      { key: "netCap", label: "Net sell limit", hint: "Sales minus buybacks; at most the gross limit.", unit: "base" },
      { key: "quoteSpendCap", label: "Buyback budget", hint: "Quote tokens buybacks may spend per period.", unit: "quote" },
    ],
  },
  {
    title: "Price rules",
    description: "Checked on every fill against the Uniswap v4 average.",
    fields: [
      { key: "floor", label: "Price floor", hint: "Never sell below this price; 0 for none.", unit: "price" },
      { key: "quoteDeviationPct", label: "Quote tolerance", hint: "Most a strategy's price may differ from the TWAP before a trade.", unit: "%" },
      { key: "impactPct", label: "Price impact allowance", hint: "Most one fill may move the price, on top of the spread.", unit: "%" },
    ],
  },
  {
    title: "Market reading",
    description: "How the Uniswap oracle is read, and when the market is too new or too thin to trust.",
    fields: [
      { key: "twapMinutes", label: "TWAP window", hint: "The reference average price.", unit: "minutes" },
      { key: "shortTwapMinutes", label: "Short TWAP window", hint: "Compared with the TWAP to measure volatility.", unit: "minutes" },
      { key: "depthBandPct", label: "Depth band", hint: "Depth = tokens needed to move the price this much.", unit: "%" },
      { key: "minPoolAgeHours", label: "Minimum pool age", hint: "A younger pool pauses the treasury; 0 for none.", unit: "hours" },
      { key: "minDepth", label: "Minimum depth", hint: "Less trusted depth pauses the treasury.", unit: "base" },
      { key: "defensiveDepth", label: "Defensive depth", hint: "Less trusted depth switches to defensive limits.", unit: "base" },
    ],
  },
  {
    title: "Risk thresholds",
    description: "Moves and volatility beyond these switch to defensive limits, or pause the treasury.",
    fields: [
      { key: "defensiveMovePct", label: "Defensive: price move", hint: "Spot vs the TWAP.", unit: "%" },
      { key: "pauseMovePct", label: "Pause: price move", hint: "At least the defensive threshold.", unit: "%" },
      { key: "defensiveVolatilityPct", label: "Defensive: volatility", hint: "Short TWAP vs the TWAP.", unit: "%" },
      { key: "pauseVolatilityPct", label: "Pause: volatility", hint: "At least the defensive threshold.", unit: "%" },
    ],
  },
  {
    title: "Normal mode",
    description: "What each fill may do in a calm market.",
    fields: [
      { key: "normalMaxFill", label: "Largest fill", hint: "Most tokens in one fill.", unit: "base" },
      { key: "normalDepthSharePct", label: "Share of depth", hint: "Most of the trusted depth one fill may take.", unit: "%" },
      { key: "normalMinSpreadPct", label: "Minimum spread", hint: "Overrides a lower strategy spread.", unit: "%" },
      { key: "normalBuybacks", label: "Buybacks", hint: "May the treasury buy back?", unit: "yesno" },
    ],
  },
  {
    title: "Defensive mode",
    description: "Never looser than normal mode.",
    fields: [
      { key: "defensiveMaxFill", label: "Largest fill", hint: "At most normal mode's.", unit: "base" },
      { key: "defensiveDepthSharePct", label: "Share of depth", hint: "At most normal mode's.", unit: "%" },
      { key: "defensiveMinSpreadPct", label: "Minimum spread", hint: "At least normal mode's.", unit: "%" },
      { key: "defensiveBuybacks", label: "Buybacks", hint: "Only if normal mode allows them.", unit: "yesno" },
    ],
  },
];

/**
 * Treasury policy (create, or update an existing one): terms → review → owners approve and execute through the Safe.
 * The fields start empty; on update they start from the policy's current values. Every owner must build identical
 * calldata, so terms are absolute and `onReview` lets the page put them in a shareable link.
 */
export function PolicyForm({
  safe,
  base,
  quote,
  oracle,
  holdings,
  policyId,
  initial,
  startInReview = false,
  onReview,
  onDone,
}: {
  safe: Address;
  base: TokenRef;
  quote: TokenRef;
  /** The pair's market oracle (from the anchor launcher). */
  oracle: Address;
  holdings?: { base?: bigint };
  /** Set to update this policy instead of creating one. */
  policyId?: Hash;
  initial?: Partial<PolicyTerms>;
  startInReview?: boolean;
  onReview?: (terms: PolicyTerms | null) => void;
  onDone?: () => void;
}) {
  const [terms, setTerms] = useState<PolicyTerms>({ ...EMPTY_POLICY, ...initial });
  const [step, setStep] = useState<"terms" | "review">(startInReview ? "review" : "terms");
  useEffect(() => {
    if (initial) setTerms((t) => ({ ...t, ...initial }));
    // Only a new source of values (another policy) resets the form; edits in progress are kept otherwise.
  }, [policyId]);

  const built = useMemo(() => buildPolicy(terms, { base, quote, oracle, ...(holdings ? { holdings } : {}) }), [terms, base, quote, oracle, holdings]);
  const call = useMemo(() => {
    if (!("config" in built)) return undefined;
    return policyId
      ? buildUpdatePolicyCall(deployment, policyId, built.config)
      : buildCreatePolicyCall(deployment, { base: base.address, quote: quote.address, config: built.config });
  }, [built, policyId, base.address, quote.address]);
  const unit = (u: Unit) =>
    ({ base: base.symbol, quote: quote.symbol, price: `${quote.symbol} per ${base.symbol}`, date: "YYYY-MM-DD", yesno: "" })[u as string] ?? u;

  if (step === "review" && call && "config" in built) {
    return (
      <div className="space-y-4">
        <ReviewPolicy built={built} base={base} quote={quote} />
        {built.warnings.map((w) => (
          <p key={w} className="text-sm text-amber-600 dark:text-amber-400">{w}</p>
        ))}
        <SafeActionPanel safe={safe} call={call} label={policyId ? "Update the treasury policy" : "Create the treasury policy"} context={{ base, quote }} {...(onDone ? { onDone } : {})} />
        <Button
          variant="ghost"
          onClick={() => {
            setStep("terms");
            onReview?.(null);
          }}
        >
          Edit policy
        </Button>
      </div>
    );
  }

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (!call) return;
        setStep("review");
        onReview?.(terms);
      }}
    >
      {startInReview && "error" in built && <p className="text-sm text-blocked">The shared policy is not valid here; correct it below.</p>}
      {SECTIONS.map((section) => (
        <fieldset key={section.title} className="space-y-3 rounded-lg border p-4">
          <legend className="px-1 font-medium">{section.title}</legend>
          <p className="text-sm text-muted-foreground">{section.description}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            {section.fields.map((f) => (
              <div key={f.key} className="space-y-1.5">
                <Label htmlFor={`policy-${f.key}`}>
                  {f.label} {unit(f.unit) && <span className="text-muted-foreground">({unit(f.unit)})</span>}
                </Label>
                {f.unit === "yesno" ? (
                  <Select value={terms[f.key]} onValueChange={(v) => setTerms({ ...terms, [f.key]: v })}>
                    <SelectTrigger id={`policy-${f.key}`} className="w-full">
                      <SelectValue placeholder="Choose…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="yes">Allowed</SelectItem>
                      <SelectItem value="no">Not allowed</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <Input id={`policy-${f.key}`} className="tabular font-mono" value={terms[f.key]} onChange={(e) => setTerms({ ...terms, [f.key]: e.target.value })} />
                )}
                <p className="text-[11px] text-muted-foreground">{f.hint}</p>
              </div>
            ))}
          </div>
        </fieldset>
      ))}
      {"error" in built && <p className="text-sm text-blocked">{built.error}</p>}
      <Button type="submit" disabled={!call}>
        Review policy
      </Button>
    </form>
  );
}

/** Read-back of the exact values that will be signed, decoded from the built config rather than the typed strings. */
export function ReviewPolicy({ built, base, quote }: { built: BuiltPolicy; base: TokenRef; quote: TokenRef }) {
  const asStrings = JSON.parse(JSON.stringify(built.config, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  return (
    <div className="rounded-lg border p-4">
      <PolicySheet config={asStrings} base={base} quote={quote} />
    </div>
  );
}
