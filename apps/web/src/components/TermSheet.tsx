import { formatBps, formatDuration, formatPrice, formatUnits } from "@/lib/format";
import type { PolicyConfig, Strategy, TokenDisplay } from "@/lib/types";

type Clause = { title: string; value: string; plain: string; enforcedBy: string };

/** The treasury policy as numbered clauses, each with the contract check that enforces it. */
export function PolicySheet({ config, base, quote }: { config: PolicyConfig; base: TokenDisplay; quote: TokenDisplay }) {
  const c = config;
  const amount = (raw: string, t: TokenDisplay) => `${formatUnits(raw, t.decimals, 0)} ${t.symbol}`;
  const mode = (m: PolicyConfig["normal"]) =>
    `fills ≤ ${amount(m.maxFillBase, base)} and ≤ ${formatBps(m.maxFillDepthBps)} of depth · spread ≥ ${formatBps(m.minSpreadBps)} · buybacks ${m.buybacksAllowed ? "on" : "off"}`;
  const clauses: Clause[] = [
    { title: "Allotment and release", value: `${amount(c.release.allotment, base)} over ${formatDuration(Number(c.release.releaseDuration))}`, plain: "Sellable inventory unlocks linearly; net sales never run ahead of the curve.", enforcedBy: "MandateQuoter · ReleaseExceeded" },
    { title: "Gross sell limit", value: `${amount(c.period.grossSellCap, base)} per ${formatDuration(Number(c.period.periodLength))}`, plain: "Every sale counts, even if bought back later: buy-sell round trips cannot reset it.", enforcedBy: "MandateQuoter · GrossSellCapReached" },
    { title: "Net sell limit", value: `${amount(c.period.netSellCap, base)} per ${formatDuration(Number(c.period.periodLength))}`, plain: "Sales minus buybacks per period, shared by every strategy of the treasury.", enforcedBy: "MandateQuoter · NetSellCapReached" },
    { title: "Buyback budget", value: `${amount(c.period.quoteSpendCap, quote)} per ${formatDuration(Number(c.period.periodLength))}`, plain: "Quote tokens the treasury may spend on buybacks per period.", enforcedBy: "MandateQuoter · QuoteSpendCapReached" },
    { title: "Price floor", value: BigInt(c.price.floorPriceX36) === 0n ? "none" : `${formatPrice(c.price.floorPriceX36, base.decimals, quote.decimals)} ${quote.symbol}`, plain: "The treasury never sells below this price.", enforcedBy: "MandateQuoter · BelowFloor" },
    { title: "Quote tolerance", value: `within ${formatBps(c.price.maxQuoteDeviationBps)} of the TWAP`, plain: "A strategy's price before the trade must be near the Uniswap average: no stale or off-market quotes.", enforcedBy: "MandateQuoter · QuoteOffMarket" },
    { title: "Price impact", value: `spread + ${formatBps(c.price.maxImpactBps)}`, plain: "One fill may not move the price further than this.", enforcedBy: "MandateQuoter · PriceImpactTooHigh" },
    { title: "Market pause", value: `move > ${formatBps(c.oracle.pauseMoveBps)} · volatility > ${formatBps(c.oracle.pauseVolatilityBps)} · depth < ${amount(c.oracle.minTrustedDepth, base)} · pool < ${formatDuration(Number(c.oracle.minPoolAge))}`, plain: "When the market looks manipulated, thin or too new, the treasury stops trading.", enforcedBy: "MandateQuoter · RiskPaused" },
    { title: "Defensive mode", value: `move > ${formatBps(c.oracle.defensiveMoveBps)} · volatility > ${formatBps(c.oracle.defensiveVolatilityBps)} · depth < ${amount(c.oracle.defensiveDepth, base)}`, plain: "Unsettled markets switch to tighter limits.", enforcedBy: "RiskModes.evaluate" },
    { title: "Normal limits", value: mode(c.normal), plain: "Per-fill size, share of trusted Uniswap depth, minimum spread and buybacks in a calm market.", enforcedBy: "MandateQuoter · FillTooLarge, BuybacksNotAllowed" },
    { title: "Defensive limits", value: mode(c.defensive), plain: "Never looser than the normal limits.", enforcedBy: "MandateModule._validatePolicy" },
  ];
  return <Clauses clauses={clauses} />;
}

/** A strategy's rails as numbered clauses. */
export function StrategySheet({ strategy, base, quote }: { strategy: Strategy; base: TokenDisplay; quote: TokenDisplay }) {
  const b = strategy.bounds;
  const clauses: Clause[] = [
    { title: "Kind", value: strategy.kind === 1 ? "Buyback" : "Market making", plain: strategy.kind === 1 ? "Only buys back, never sells." : "Sells and buys back around the market.", enforcedBy: "MandateQuoter · SellsNotAllowed" },
    { title: "Spread range", value: `${formatBps(b.spreadBpsMin)} – ${formatBps(b.spreadBpsMax)}`, plain: "The market maker tunes its spread only inside this range.", enforcedBy: "MandateModule.reship · ParamsOutOfBounds" },
    { title: "Inventory", value: `up to ${formatUnits(b.maxShippedBase, base.decimals, 0)} ${base.symbol} and ${formatUnits(b.maxShippedQuote, quote.decimals, 0)} ${quote.symbol}`, plain: "The most this strategy may ship, and never more than the Safe actually holds.", enforcedBy: "MandateModule · ParamsOutOfBounds, InsufficientBacking" },
    ...(strategy.kind === 1
      ? [{ title: "Highest buyback price", value: `${formatPrice(b.maxBuyPriceX36, base.decimals, quote.decimals)} ${quote.symbol}`, plain: "The treasury never pays more than this.", enforcedBy: "MandateQuoter · AboveMaxBuyPrice" }]
      : []),
    { title: "Market maker pay", value: `${formatBps(b.mmFeeShareBps)} of fees on fills`, plain: "Fixed when the strategy is added. Paid for providing liquidity, not for selling; earned fees survive a revoke.", enforcedBy: "MandateModule.claimFees · FeeShareIsFixed" },
  ];
  return <Clauses clauses={clauses} />;
}

function Clauses({ clauses }: { clauses: Clause[] }) {
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
