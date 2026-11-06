import { buildCreateMandateCall } from "@mandate/sdk";
import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { useBlock } from "wagmi";

import { Hex } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatBps, formatPrice, formatUnits, parseUnits } from "@/lib/format";
import { demoChain, deployment } from "@/wallet/config";
import { SafeActionPanel } from "@/wallet/SafeActionPanel";
import { useSafeInfo } from "@/wallet/useSafe";

import { buildTerms, utcDate, type BuiltTerms, type Holdings, type Terms, type TokenRef } from "./terms";

const FIELDS: { key: keyof Terms; label: string; hint: string; unit?: "base" | "quote" | "price" | "%" | "days" | "date" }[] = [
  { key: "mm", label: "Market maker address", hint: "The only address that can reship, pause and claim fees." },
  { key: "allotment", label: "Allotment", hint: "Most the strategy may ever sell, net of buybacks.", unit: "base" },
  { key: "releaseStart", label: "Release start", hint: "Inventory unlocks linearly from this day (UTC).", unit: "date" },
  { key: "releaseDays", label: "Release duration", hint: "Days until the whole allotment is unlocked.", unit: "days" },
  { key: "dailyCap", label: "Daily sell limit", hint: "Ceiling on net sales per day.", unit: "base" },
  { key: "floor", label: "Price floor", hint: "Never sell below this price.", unit: "price" },
  { key: "anchorPct", label: "Anchor tolerance", hint: "Max distance from the Uniswap 30-min average.", unit: "%" },
  { key: "spreadMinPct", label: "Minimum spread", hint: "Lowest spread the MM may choose.", unit: "%" },
  { key: "spreadMaxPct", label: "Maximum spread", hint: "Must stay below the anchor tolerance.", unit: "%" },
  { key: "feeSharePct", label: "MM fee share", hint: "Fixed at signing; claimable by the MM.", unit: "%" },
  { key: "spreadPct", label: "Initial spread", hint: "Starting value; the MM tunes it later.", unit: "%" },
  { key: "shippedBase", label: "Initial inventory", hint: "Tokens the first strategy may sell; at most the Safe's balance.", unit: "base" },
  { key: "shippedQuote", label: "Buyback inventory", hint: "Quote tokens committed to buybacks (also its cap).", unit: "quote" },
];

const EMPTY: Terms = {
  mm: "", allotment: "", releaseStart: "", releaseDays: "", dailyCap: "", floor: "", anchorPct: "",
  spreadMinPct: "", spreadMaxPct: "", spreadPct: "", feeSharePct: "", shippedBase: "", shippedQuote: "",
};

/**
 * Create Mandate (spec 10.3 B): terms → review → owners approve and execute through the Safe. Used by the Issuer
 * Console (deployment's demo pair) and the onboarding wizard (any pair with a launched anchor).
 *
 * Every owner must build byte-identical calldata to approve the same Safe transaction, so terms are absolute (the
 * release start is a date, not "days ago") and `onReview` lets the page put them in a shareable link. The module
 * re-validates every bound onchain; the pre-check in the panel shows its refusal before anyone approves.
 */
export function CreateMandateForm({
  safe,
  base,
  quote,
  anchor,
  holdings,
  anchorPriceX36,
  initial,
  releaseOffsetDays = 0,
  startInReview = false,
  onReview,
  onDone,
  marketMaker,
  renderReviewAction,
}: {
  safe: Address;
  base: TokenRef;
  quote: TokenRef;
  /** The pair's price anchor; the quoter consults it for every fill. */
  anchor: Address;
  /** Safe balances; shipped inventory above them is refused. */
  holdings?: Holdings;
  /** The anchor pool's current price; the starting price (shipped ratio) is checked against it. */
  anchorPriceX36?: bigint;
  initial?: Partial<Terms>;
  /** Default release start, in days before today (chain time), when `initial` has none. */
  releaseOffsetDays?: number;
  startInReview?: boolean;
  /** Called with the terms when they move to review, and with null when the owner goes back to edit. */
  onReview?: (terms: Terms | null) => void;
  onDone?: () => void;
  /** Fixes the market maker (chosen elsewhere, e.g. from the marketplace); its field is then hidden. */
  marketMaker?: string;
  /** Replaces the default "owners approve and execute" panel on the review screen (e.g. send as a proposal). */
  renderReviewAction?: (built: BuiltTerms) => React.ReactNode;
}) {
  const [terms, setTerms] = useState<Terms>({ ...EMPTY, ...initial });
  const [step, setStep] = useState<"terms" | "review">(startInReview ? "review" : "terms");
  const block = useBlock({ chainId: demoChain.id, query: { refetchInterval: false } });
  const now = block.data?.timestamp;
  const { owners } = useSafeInfo(safe);

  useEffect(() => {
    if (marketMaker !== undefined) setTerms((t) => (t.mm === marketMaker ? t : { ...t, mm: marketMaker }));
  }, [marketMaker]);

  // Fill the default release date from chain time once, so a forked chain's clock is respected.
  useEffect(() => {
    if (now !== undefined && !terms.releaseStart)
      setTerms((t) => ({ ...t, releaseStart: utcDate(now - BigInt(releaseOffsetDays) * 86_400n) }));
  }, [now, terms.releaseStart, releaseOffsetDays]);

  const built = useMemo(
    () => buildTerms(terms, { safe, owners, base, quote, anchor, holdings, anchorPriceX36 }),
    [terms, safe, owners, base, quote, anchor, holdings, anchorPriceX36],
  );
  const call = useMemo(
    () =>
      "bounds" in built
        ? buildCreateMandateCall(deployment, {
            marketMaker: built.marketMaker,
            base: base.address,
            quote: quote.address,
            bounds: built.bounds,
            params: built.params,
          })
        : undefined,
    [built, base.address, quote.address],
  );
  const unit = (u: (typeof FIELDS)[number]["unit"]) =>
    ({ base: base.symbol, quote: quote.symbol, price: `${quote.symbol} per ${base.symbol}`, date: "YYYY-MM-DD" })[u as string] ?? u ?? "";

  if (step === "review" && call && "bounds" in built) {
    return (
      <div className="space-y-4">
        <ReviewTerms built={built} base={base} quote={quote} anchor={anchor} now={now} />
        {built.warnings.map((w) => (
          <p key={w} className="text-sm text-amber-600 dark:text-amber-400">{w}</p>
        ))}
        {renderReviewAction ? (
          renderReviewAction(built)
        ) : (
          <SafeActionPanel safe={safe} call={call} label="Create mandate" context={{ base, quote }} onDone={onDone} />
        )}
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
        if (!call) return;
        setStep("review");
        onReview?.(terms);
      }}
    >
      {startInReview && "error" in built && (
        <p className="text-sm text-blocked">The shared terms are not valid here; correct them below.</p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {/* A market maker chosen elsewhere (marketplace picker) is not shown twice. */}
        {FIELDS.filter((f) => !(f.key === "mm" && marketMaker !== undefined)).map((f) => (
          <div key={f.key} className={f.key === "mm" ? "space-y-1.5 sm:col-span-2" : "space-y-1.5"}>
            <Label htmlFor={f.key}>
              {f.label} {f.unit && <span className="text-muted-foreground">({unit(f.unit)})</span>}
            </Label>
            <Input id={f.key} className="tabular font-mono" value={terms[f.key]} onChange={(e) => setTerms({ ...terms, [f.key]: e.target.value })} />
            <p className="text-[11px] text-muted-foreground">{f.hint}</p>
          </div>
        ))}
      </div>
      <StartingPrice terms={terms} base={base} quote={quote} anchorPriceX36={anchorPriceX36} />
      {"error" in built && <p className="text-sm text-blocked">{built.error}</p>}
      <Button type="submit" disabled={!call}>
        Review terms
      </Button>
    </form>
  );
}

/**
 * Read-back of the exact values that will be signed, decoded from the built call rather than the typed strings.
 * Terms may arrive in a link from someone else, so every party and amount is shown in full before approval.
 */
function ReviewTerms({ built, base, quote, anchor, now }: { built: BuiltTerms; base: TokenRef; quote: TokenRef; anchor: Address; now?: bigint }) {
  const b = built.bounds;
  const p = built.params;
  const amount = (raw: bigint, t: TokenRef) => `${formatUnits(raw, t.decimals, t.decimals)} ${t.symbol}`;
  const releaseEnd = b.releaseStart + b.releaseDuration;
  const unlocked =
    now === undefined || now <= b.releaseStart ? 0 : now >= releaseEnd ? 100 : Number(((now - b.releaseStart) * 100n) / b.releaseDuration);
  const rows: [string, React.ReactNode][] = [
    ["Market maker", <span className="break-all font-mono">{built.marketMaker}</span>],
    ["Pair", <span><b>{base.symbol}</b> <Hex value={base.address} /> sold for <b>{quote.symbol}</b> <Hex value={quote.address} /></span>],
    ["Price anchor", <Hex value={anchor} />],
    ["Allotment", amount(b.allotment, base)],
    ["Release", `${utcDate(b.releaseStart)} → ${utcDate(releaseEnd)} (UTC), about ${unlocked}% unlocked now`],
    ["Daily sell limit", amount(b.maxEpochCap, base)],
    ["Price floor", `${formatPrice(b.floorPriceX36, base.decimals, quote.decimals, 6)} ${quote.symbol} per ${base.symbol}`],
    ["Anchor tolerance", `${formatBps(b.maxAnchorDeviationBps)} of the 30-minute TWAP`],
    ["Spread", `${formatBps(p.spreadBps)} (MM may set ${formatBps(b.spreadBpsMin)} – ${formatBps(b.spreadBpsMax)})`],
    ["MM fee share", `${formatBps(b.mmFeeShareBps)}, fixed`],
    ["Starting price", `${formatPrice((p.shippedQuote * 10n ** 36n) / p.shippedBase, base.decimals, quote.decimals, 6)} ${quote.symbol} per ${base.symbol} (shipped ratio)`],
    ["Initial inventory", amount(p.shippedBase, base)],
    ["Buyback inventory", amount(p.shippedQuote, quote)],
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
 * price because a ratio far from it makes every fill fail the anchor check.
 */
function StartingPrice({ terms, base, quote, anchorPriceX36 }: { terms: Terms; base: TokenRef; quote: TokenRef; anchorPriceX36?: bigint }) {
  const shippedBase = parseUnits(terms.shippedBase, base.decimals);
  const shippedQuote = parseUnits(terms.shippedQuote, quote.decimals);
  if (!shippedBase || !shippedQuote) return null;
  const price = (x36: bigint) => `${formatPrice(x36, base.decimals, quote.decimals, 6)} ${quote.symbol} per ${base.symbol}`;
  return (
    <p className="text-sm text-muted-foreground">
      Starting price (shipped ratio): <b className="tabular">{price((shippedQuote * 10n ** 36n) / shippedBase)}</b>
      {anchorPriceX36 !== undefined && <> · pool price <span className="tabular">{price(anchorPriceX36)}</span></>}
    </p>
  );
}
