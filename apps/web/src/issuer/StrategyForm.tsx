import { buildAddStrategyCall } from "@mandate/sdk";
import { useEffect, useMemo, useState } from "react";
import type { Address, Hash } from "viem";

import { Hex } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatBps, formatPrice, formatUnits, parseUnits } from "@/lib/format";
import { deployment } from "@/wallet/config";
import { SafeActionPanel } from "@/wallet/SafeActionPanel";
import { useSafeInfo } from "@/wallet/useSafe";

import { explainTerms, suggestTerms, type PolicyLimits } from "./explain";
import { Explained, Summary } from "./Explained";
import { buildTerms, EMPTY_TERMS, type BuiltTerms, type Holdings, type PolicyRules, type Terms, type TokenRef } from "./terms";

type Unit = "base" | "quote" | "price" | "%";
const FIELDS: { key: keyof Terms; label: string; hint: string; unit?: Unit; buybackOnly?: boolean }[] = [
  { key: "mm", label: "Market maker address", hint: "The only address that can reship, pause and claim fees." },
  { key: "spreadMinPct", label: "Minimum spread", hint: "Lowest spread the market maker may choose.", unit: "%" },
  { key: "spreadMaxPct", label: "Maximum spread", hint: "Highest spread the market maker may choose.", unit: "%" },
  { key: "feeSharePct", label: "MM fee share", hint: "Share of the spread fees the market maker earns; fixed once added.", unit: "%" },
  { key: "maxShippedBase", label: "Most token inventory", hint: "Most tokens the market maker may ever ship.", unit: "base" },
  { key: "maxShippedQuote", label: "Most quote inventory", hint: "Most quote tokens the market maker may ever ship.", unit: "quote" },
  { key: "maxBuyPrice", label: "Highest buyback price", hint: "The treasury never pays more.", unit: "price", buybackOnly: true },
  { key: "spreadPct", label: "Initial spread", hint: "Starting value; the market maker tunes it later.", unit: "%" },
  { key: "shippedBase", label: "Initial token inventory", hint: "Tokens the first order holds; the Safe must back them.", unit: "base" },
  { key: "shippedQuote", label: "Initial quote inventory", hint: "Quote tokens the first order holds; the Safe must back them.", unit: "quote" },
];

/**
 * Add a strategy under the Safe's policy: terms → review → owners approve and execute (or, with `renderReviewAction`,
 * send it to the market maker as a proposal). A new strategy starts from suggested values (`suggestTerms`: inventory
 * the Safe can back, matched at the pool price) until the issuer edits a field; a shared link starts from its own.
 * Every field and a summary say in plain words what the values will do (`explainTerms`).
 */
export function StrategyForm({
  safe,
  base,
  quote,
  policyId,
  policy,
  holdings,
  anchorPriceX36,
  limits,
  initial,
  startInReview = false,
  onReview,
  onDone,
  marketMaker,
  renderReviewAction,
}: {
  safe: Address;
  base: TokenRef;
  quote: TokenRef;
  /** The Safe's live policy for the pair; required to add directly, optional for proposals. */
  policyId?: Hash;
  /** The policy's price rules, to check the starting price before anyone signs. */
  policy?: PolicyRules;
  /** What the Safe can still back (balances minus other live strategies). */
  holdings?: Holdings;
  anchorPriceX36?: bigint;
  /** The policy's limits, to explain how they bound this strategy. */
  limits?: PolicyLimits;
  initial?: Partial<Terms>;
  startInReview?: boolean;
  onReview?: (terms: Terms | null) => void;
  onDone?: () => void;
  /** Fixes the market maker (chosen elsewhere, e.g. from the marketplace); its field is then hidden. */
  marketMaker?: string;
  renderReviewAction?: (built: BuiltTerms) => React.ReactNode;
}) {
  const suggest = (mm: string) =>
    suggestTerms({ base, quote, mm, ...(anchorPriceX36 !== undefined ? { anchorPriceX36 } : {}), ...(holdings ? { holdings } : {}) });
  const [terms, setTerms] = useState<Terms>(() => (initial ? { ...EMPTY_TERMS, ...initial } : suggest(marketMaker ?? "")));
  // Suggestions follow the pool price and the Safe's backing as they load, until the issuer types anything.
  const [touched, setTouched] = useState(Boolean(initial));
  const edit = (next: Terms) => {
    setTouched(true);
    setTerms(next);
  };
  const [step, setStep] = useState<"terms" | "review">(startInReview ? "review" : "terms");
  const { owners } = useSafeInfo(safe);
  useEffect(() => {
    if (!touched) setTerms((t) => suggest(marketMaker ?? t.mm));
  }, [touched, anchorPriceX36, holdings?.base, holdings?.quote]);
  const explained = useMemo(
    () => explainTerms(terms, { base, quote, ...(anchorPriceX36 !== undefined ? { anchorPriceX36 } : {}), ...(holdings ? { holdings } : {}), ...(limits ? { limits } : {}) }),
    [terms, base, quote, anchorPriceX36, holdings, limits],
  );

  useEffect(() => {
    if (marketMaker !== undefined) setTerms((t) => (t.mm === marketMaker ? t : { ...t, mm: marketMaker }));
  }, [marketMaker]);

  const built = useMemo(
    () => buildTerms(terms, { safe, ...(owners ? { owners } : {}), base, quote, ...(holdings ? { holdings } : {}), ...(anchorPriceX36 !== undefined ? { anchorPriceX36 } : {}), ...(policy ? { policy } : {}) }),
    [terms, safe, owners, base, quote, holdings, anchorPriceX36, policy],
  );
  const call = useMemo(
    () =>
      "bounds" in built && policyId
        ? buildAddStrategyCall(deployment, { policyId, marketMaker: built.marketMaker, kind: built.kind, bounds: built.bounds, params: built.params })
        : undefined,
    [built, policyId],
  );
  const ready = "bounds" in built && (call !== undefined || renderReviewAction !== undefined);
  const unit = (u?: Unit) => (u ? ({ base: base.symbol, quote: quote.symbol, price: `${quote.symbol} per ${base.symbol}`, "%": "%" } as const)[u] : "");

  if (step === "review" && "bounds" in built) {
    return (
      <div className="space-y-4">
        <ReviewStrategy built={built} base={base} quote={quote} />
        {built.warnings.map((w) => (
          <p key={w} className="text-sm text-amber-600 dark:text-amber-400">{w}</p>
        ))}
        {renderReviewAction
          ? renderReviewAction(built)
          : call && <SafeActionPanel safe={safe} call={call} label="Add the strategy" context={{ base, quote }} {...(onDone ? { onDone } : {})} />}
        <Button
          variant="ghost"
          onClick={() => {
            setStep("terms");
            onReview?.(null);
          }}
        >
          Edit terms
        </Button>
      </div>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setStep("review");
        onReview?.(terms);
      }}
    >
      {startInReview && "error" in built && <p className="text-sm text-blocked">The shared terms are not valid here; correct them below.</p>}
      {!touched && <p className="text-sm text-muted-foreground">Suggested values, matched to the pool price and what the Safe can back. Change anything: every field says what it will do.</p>}
      <Summary title="What this strategy does" lines={explained.summary} />
      <div className="space-y-1.5">
        <Label htmlFor="strategy-kind">Strategy kind</Label>
        <Select value={terms.kind} onValueChange={(v) => edit({ ...terms, kind: v })}>
          <SelectTrigger id="strategy-kind" className="w-full sm:w-96">
            <SelectValue placeholder="Choose…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="marketMaking">Market making: sells and buys back around the market</SelectItem>
            <SelectItem value="buyback">Buyback: only buys, at or below a price you set</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {FIELDS.filter((f) => !(f.key === "mm" && marketMaker !== undefined) && !(f.buybackOnly && terms.kind !== "buyback")).map((f) => (
          <div key={f.key} className={f.key === "mm" ? "space-y-1.5 sm:col-span-2" : "space-y-1.5"}>
            <Label htmlFor={`strategy-${f.key}`}>
              {f.label} {f.unit && <span className="text-muted-foreground">({unit(f.unit)})</span>}
            </Label>
            <Input id={`strategy-${f.key}`} className="tabular font-mono" value={terms[f.key]} onChange={(e) => edit({ ...terms, [f.key]: e.target.value })} />
            <p className="text-[11px] text-muted-foreground">{f.hint}</p>
            <Explained text={explained.fields[f.key]} />
          </div>
        ))}
      </div>
      <StartingPrice terms={terms} base={base} quote={quote} {...(anchorPriceX36 !== undefined ? { anchorPriceX36 } : {})} holdings={holdings} />
      {!policyId && !renderReviewAction && <p className="text-sm text-muted-foreground">Create the treasury policy first: strategies run under it.</p>}
      {"error" in built && <p className="text-sm text-blocked">{built.error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!ready}>
          Review strategy
        </Button>
        {!initial && (
          <Button type="button" variant="outline" onClick={() => setTouched(false)}>
            Reset to suggested values
          </Button>
        )}
      </div>
    </form>
  );
}

/**
 * Read-back of the exact values that will be signed, decoded from the built call rather than the typed strings.
 * Terms may arrive in a link or a proposal from someone else, so every party and amount is shown in full.
 */
export function ReviewStrategy({ built, base, quote }: { built: Pick<BuiltTerms, "marketMaker" | "kind" | "bounds" | "params">; base: TokenRef; quote: TokenRef }) {
  const b = built.bounds;
  const p = built.params;
  const amount = (raw: bigint, t: TokenRef) => `${formatUnits(raw, t.decimals, t.decimals)} ${t.symbol}`;
  const rows: [string, React.ReactNode][] = [
    ["Market maker", <span className="break-all font-mono">{built.marketMaker}</span>],
    ["Pair", <span><b>{base.symbol}</b> <Hex value={base.address} /> against <b>{quote.symbol}</b> <Hex value={quote.address} /></span>],
    ["Kind", built.kind === 1 ? "Buyback (never sells)" : "Market making"],
    ["Spread", `${formatBps(p.spreadBps)} (market maker may set ${formatBps(b.spreadBpsMin)} – ${formatBps(b.spreadBpsMax)})`],
    ["MM fee share", `${formatBps(b.mmFeeShareBps)}, fixed`],
    ["Most inventory", `${amount(b.maxShippedBase, base)} and ${amount(b.maxShippedQuote, quote)}`],
    ...(built.kind === 1 ? [["Highest buyback price", `${formatPrice(b.maxBuyPriceX36, base.decimals, quote.decimals, 6)} ${quote.symbol} per ${base.symbol}`] as [string, React.ReactNode]] : []),
    ["Starting price", `${formatPrice((p.shippedQuote * 10n ** 36n) / p.shippedBase, base.decimals, quote.decimals, 6)} ${quote.symbol} per ${base.symbol} (shipped ratio)`],
    ["Initial inventory", `${amount(p.shippedBase, base)} and ${amount(p.shippedQuote, quote)}`],
  ];
  return (
    <dl className="grid gap-x-6 gap-y-2 rounded-lg border p-4 text-sm sm:grid-cols-[auto_1fr]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="tabular">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Fills are priced over the shipped balances, so their ratio is where trading starts. Shown live next to the pool
 * price and what the Safe can still back.
 */
function StartingPrice({ terms, base, quote, anchorPriceX36, holdings }: { terms: Terms; base: TokenRef; quote: TokenRef; anchorPriceX36?: bigint; holdings: Holdings | undefined }) {
  const shippedBase = parseUnits(terms.shippedBase, base.decimals);
  const shippedQuote = parseUnits(terms.shippedQuote, quote.decimals);
  const price = (x36: bigint) => `${formatPrice(x36, base.decimals, quote.decimals, 6)} ${quote.symbol} per ${base.symbol}`;
  return (
    <div className="space-y-1 text-sm text-muted-foreground">
      {shippedBase && shippedQuote ? (
        <p>
          Starting price (shipped ratio): <b className="tabular">{price((shippedQuote * 10n ** 36n) / shippedBase)}</b>
          {anchorPriceX36 !== undefined && <> · pool price <span className="tabular">{price(anchorPriceX36)}</span></>}
        </p>
      ) : (
        anchorPriceX36 !== undefined && <p>Pool price: <span className="tabular">{price(anchorPriceX36)}</span></p>
      )}
      {holdings?.base !== undefined && holdings.quote !== undefined && (
        <p>
          The Safe can still back {formatUnits(holdings.base, base.decimals, 2)} {base.symbol} and {formatUnits(holdings.quote, quote.decimals, 2)} {quote.symbol}.
        </p>
      )}
    </div>
  );
}
