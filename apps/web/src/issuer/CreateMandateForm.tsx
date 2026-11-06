import { buildCreateMandateCall, type IssuerBounds, type MandateParams } from "@mandate/sdk";
import { useMemo, useState } from "react";
import { isAddress, type Address } from "viem";
import { useBlock } from "wagmi";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseUnits } from "@/lib/format";
import type { TokenDisplay } from "@/lib/types";
import { DEMO_ACCOUNTS, demoChain, deployment } from "@/wallet/config";
import { SafeActionPanel } from "@/wallet/SafeActionPanel";

interface Terms {
  mm: string;
  allotment: string;
  releaseDays: string;
  releaseBackdateDays: string;
  dailyCap: string;
  floor: string;
  anchorPct: string;
  spreadMinPct: string;
  spreadMaxPct: string;
  spreadPct: string;
  feeSharePct: string;
  shippedBase: string;
  shippedQuote: string;
}

/** Demo defaults mirror contracts/script/lib/DemoConfig.sol, scaled to fit the demo Safe's balance. */
const DEFAULTS: Terms = {
  mm: DEMO_ACCOUNTS.marketMaker,
  allotment: "1000000",
  releaseDays: "180",
  releaseBackdateDays: "20",
  dailyCap: "50000",
  floor: "0.30",
  anchorPct: "3",
  spreadMinPct: "0.1",
  spreadMaxPct: "2",
  spreadPct: "0.8",
  feeSharePct: "50",
  shippedBase: "1000000",
  shippedQuote: "400000",
};

const FIELDS: { key: keyof Terms; label: string; hint: string; unit?: "base" | "quote" | "%" | "days" }[] = [
  { key: "mm", label: "Market maker address", hint: "The only address that can reship, pause and claim fees." },
  { key: "allotment", label: "Allotment", hint: "Most the strategy may ever sell, net of buybacks.", unit: "base" },
  { key: "releaseDays", label: "Release duration", hint: "Sellable inventory unlocks linearly over this period.", unit: "days" },
  { key: "releaseBackdateDays", label: "Release began", hint: "Days ago (demo: so some inventory is already unlocked).", unit: "days" },
  { key: "dailyCap", label: "Daily sell limit", hint: "Ceiling on net sales per day.", unit: "base" },
  { key: "floor", label: "Price floor", hint: "Never sell below this price.", unit: "quote" },
  { key: "anchorPct", label: "Anchor tolerance", hint: "Max distance from the Uniswap 30-min average.", unit: "%" },
  { key: "spreadMinPct", label: "Minimum spread", hint: "Lowest spread the MM may choose.", unit: "%" },
  { key: "spreadMaxPct", label: "Maximum spread", hint: "Must stay below the anchor tolerance.", unit: "%" },
  { key: "feeSharePct", label: "MM fee share", hint: "Fixed at signing; claimable by the MM.", unit: "%" },
  { key: "spreadPct", label: "Initial spread", hint: "Starting value; the MM tunes it later.", unit: "%" },
  { key: "shippedBase", label: "Initial inventory", hint: "Tokens the first strategy may sell.", unit: "base" },
  { key: "shippedQuote", label: "Buyback inventory", hint: "Quote tokens committed to buybacks (also its cap).", unit: "quote" },
];

/** Builds the createMandate call from human inputs; returns an error string for the first invalid field. */
function build(terms: Terms, now: bigint, base: TokenDisplay, quote: TokenDisplay): { error: string } | { bounds: IssuerBounds; params: MandateParams } {
  const amount = (v: string, t: TokenDisplay, name: string) => {
    const raw = parseUnits(v, t.decimals);
    if (raw === null || raw === 0n) throw new Error(`${name}: enter a positive amount`);
    return raw;
  };
  const bps = (v: string, name: string) => {
    const raw = parseUnits(v, 2);
    if (raw === null || raw > 10_000n) throw new Error(`${name}: enter a percentage between 0 and 100`);
    return Number(raw);
  };
  const days = (v: string, name: string) => {
    if (!/^\d{1,4}$/.test(v.trim())) throw new Error(`${name}: whole days`);
    return BigInt(v.trim()) * 86_400n;
  };
  try {
    if (!isAddress(terms.mm)) throw new Error("Market maker address: not a valid address");
    const floor = parseUnits(terms.floor, 18);
    if (floor === null) throw new Error("Price floor: enter a price");
    // X36 = quoteRaw * 1e36 / baseRaw; a human price p is p * 10^quoteDec / 10^baseDec raw units.
    const floorPriceX36 = (floor * 10n ** 36n * 10n ** BigInt(quote.decimals)) / (10n ** 18n * 10n ** BigInt(base.decimals));
    const allotment = amount(terms.allotment, base, "Allotment");
    const dailyCap = amount(terms.dailyCap, base, "Daily sell limit");
    const shippedQuote = amount(terms.shippedQuote, quote, "Buyback inventory");
    return {
      bounds: {
        allotment,
        releaseStart: now - days(terms.releaseBackdateDays, "Release began"),
        releaseDuration: days(terms.releaseDays, "Release duration"),
        epochLength: 86_400n,
        maxEpochCap: dailyCap,
        maxShippedQuote: shippedQuote,
        floorPriceX36,
        maxAnchorDeviationBps: bps(terms.anchorPct, "Anchor tolerance"),
        twapWindow: 1800,
        spreadBpsMin: bps(terms.spreadMinPct, "Minimum spread"),
        spreadBpsMax: bps(terms.spreadMaxPct, "Maximum spread"),
        mmFeeShareBps: bps(terms.feeSharePct, "MM fee share"),
        anchor: deployment.anchor,
      },
      params: {
        spreadBps: bps(terms.spreadPct, "Initial spread"),
        epochCap: dailyCap,
        shippedBase: amount(terms.shippedBase, base, "Initial inventory"),
        shippedQuote,
      },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Create Mandate wizard (spec 10.3 B): terms → review → owners approve and execute through the Safe.
 * The module re-validates every bound onchain; the pre-check shows its refusal before anyone approves.
 */
export function CreateMandateForm({ safe, base, quote }: { safe: Address; base: TokenDisplay; quote: TokenDisplay }) {
  const [terms, setTerms] = useState<Terms>(DEFAULTS);
  const [step, setStep] = useState<"terms" | "review">("terms");
  const block = useBlock({ chainId: demoChain.id, query: { refetchInterval: false } });
  const now = block.data?.timestamp;

  const built = useMemo(() => (now === undefined ? { error: "Reading chain time…" } : build(terms, now, base, quote)), [terms, now, base, quote]);
  const call = useMemo(
    () =>
      "bounds" in built
        ? buildCreateMandateCall(deployment, { marketMaker: terms.mm as Address, base: deployment.base, quote: deployment.quote, ...built })
        : undefined,
    [built, terms.mm],
  );
  const unit = (u: (typeof FIELDS)[number]["unit"]) => (u === "base" ? base.symbol : u === "quote" ? quote.symbol : u ?? "");

  if (step === "review" && call && "bounds" in built) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          At most <b>{terms.dailyCap} {base.symbol}</b> can be sold per day, never below <b>{terms.floor} {quote.symbol}</b>, and
          never more than {terms.anchorPct}% from the Uniswap average. {Number(terms.releaseBackdateDays) > 0 && `About ${Math.min(100, Math.round((Number(terms.releaseBackdateDays) / Number(terms.releaseDays)) * 100))}% of the allotment is already unlocked.`}
        </p>
        <SafeActionPanel safe={safe} call={call} label="Create mandate" context={{ base, quote }} />
        <Button variant="ghost" onClick={() => setStep("terms")}>
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
        if (call) setStep("review");
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <div key={f.key} className={f.key === "mm" ? "space-y-1.5 sm:col-span-2" : "space-y-1.5"}>
            <Label htmlFor={f.key}>
              {f.label} {f.unit && <span className="text-muted-foreground">({unit(f.unit)})</span>}
            </Label>
            <Input id={f.key} className="tabular font-mono" value={terms[f.key]} onChange={(e) => setTerms({ ...terms, [f.key]: e.target.value })} />
            <p className="text-[11px] text-muted-foreground">{f.hint}</p>
          </div>
        ))}
      </div>
      {"error" in built && <p className="text-sm text-blocked">{built.error}</p>}
      <Button type="submit" disabled={!call}>
        Review terms
      </Button>
    </form>
  );
}
