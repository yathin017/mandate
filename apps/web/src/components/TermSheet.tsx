import { formatBps, formatDuration, formatPrice, formatUnits } from "@/lib/format";
import type { Mandate, TokenDisplay } from "@/lib/types";

/** The deal terms as numbered clauses, each with the contract check that enforces it. */
export function TermSheet({ mandate, base, quote }: { mandate: Mandate; base: TokenDisplay; quote: TokenDisplay }) {
  const b = mandate.bounds;
  const clauses: { title: string; value: string; plain: string; enforcedBy: string }[] = [
    {
      title: "Allotment",
      value: `${formatUnits(b.allotment, base.decimals, 0)} ${base.symbol}`,
      plain: "The most the strategy may ever sell, net of buybacks.",
      enforcedBy: "MandateModule._validateParams (shippedBase)",
    },
    {
      title: "Release schedule",
      value: `linear over ${formatDuration(Number(b.releaseDuration))}`,
      plain: "Sellable inventory unlocks gradually; sales can never run ahead of the curve.",
      enforcedBy: "MandateQuoter · ReleaseExceeded",
    },
    {
      title: "Daily sell limit",
      value: `${formatUnits(b.maxEpochCap, base.decimals, 0)} ${base.symbol} per ${formatDuration(Number(b.epochLength))}`,
      plain: "Net sales per epoch are capped; buybacks restore capacity.",
      enforcedBy: "MandateQuoter · EpochCapReached",
    },
    {
      title: "Price floor",
      value: `${formatPrice(b.floorPriceX36, base.decimals, quote.decimals)} ${quote.symbol}`,
      plain: "The treasury never sells below this price.",
      enforcedBy: "MandateQuoter · BelowFloor",
    },
    {
      title: "Uniswap anchor",
      value: `within ${formatBps(b.maxAnchorDeviationBps)} of the ${formatDuration(Number(b.twapWindow))} TWAP`,
      plain: "No fill at a price far from the Uniswap v4 average, in either direction.",
      enforcedBy: "MandateQuoter · AnchorDeviation, UniswapV4TwapAnchor · SpotTwapDivergence",
    },
    {
      title: "Spread range",
      value: `${formatBps(b.spreadBpsMin)} – ${formatBps(b.spreadBpsMax)}`,
      plain: "The market maker tunes its spread only inside this range.",
      enforcedBy: "MandateModule.reship · ParamsOutOfBounds",
    },
    {
      title: "Buyback inventory",
      value: `up to ${formatUnits(b.maxShippedQuote, quote.decimals, 0)} ${quote.symbol}`,
      plain: "Quote tokens the issuer commits to buying back.",
      enforcedBy: "MandateModule._validateParams (shippedQuote)",
    },
    {
      title: "Market maker pay",
      value: `${formatBps(b.mmFeeShareBps)} of fees on fills`,
      plain: "Fixed at signing. Paid for providing liquidity, not for selling; earned fees survive a revoke.",
      enforcedBy: "MandateModule.claimFees · FeeShareIsFixed",
    },
  ];

  return (
    <ol className="space-y-4">
      {clauses.map((clause, i) => (
        <li key={clause.title} className="grid gap-1 border-b pb-4 last:border-none sm:grid-cols-[2rem_1fr_auto] sm:gap-4">
          <span className="font-serif text-muted-foreground">§{i + 1}</span>
          <div>
            <p className="font-serif font-semibold">{clause.title}</p>
            <p className="text-sm text-muted-foreground">{clause.plain}</p>
            <p className="mt-1 font-mono text-[11px] text-muted-foreground/80">enforced by {clause.enforcedBy}</p>
          </div>
          <p className="tabular font-mono text-sm sm:text-right">{clause.value}</p>
        </li>
      ))}
    </ol>
  );
}
