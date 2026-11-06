import { CheckCircle2, ChevronDown, FlaskConical } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { BlockedStamp, Hex, SyntheticTag } from "@/components/status";
import { formatChainTime, formatPrice, formatUnits } from "@/lib/format";
import { useActivity } from "@/lib/hooks";
import type { ActivityItem, TokenDisplay } from "@/lib/types";

/** Plain-language clause names for the stamp (spec 10.2); the full sentence comes from the indexer. */
const CLAUSE: Record<string, string> = {
  EpochCapReached: "Daily sell limit",
  ReleaseExceeded: "Release schedule",
  BelowFloor: "Price floor",
  AnchorDeviation: "Uniswap anchor",
  SpotTwapDivergence: "Manipulation guard",
  MandatePaused: "Mandate paused",
  MandateRevoked: "Mandate revoked",
  ParamsOutOfBounds: "Issuer bounds",
  NotIssuer: "Issuer only",
  NotMarketMaker: "MM only",
  SafeBalancesForTokenNotInActiveStrategy: "Strategy docked",
};

export function ActivityFeed({ mandateId, base, quote }: { mandateId: string; base: TokenDisplay; quote: TokenDisplay }) {
  const activity = useActivity(mandateId);
  if (activity.isPending) return <Skeleton className="h-64 w-full" />;
  if (activity.isError) return <p className="text-sm text-blocked">Could not load activity: {activity.error.message}</p>;

  const items = activity.data.pages.flatMap((page) => page.data.items);
  if (!items.length) return <p className="text-sm text-muted-foreground">No fills or blocked attempts yet.</p>;

  return (
    <div className="space-y-2">
      <ul className="divide-y rounded-lg border">
        {groupRuns(items).map((group) =>
          group.length === 1 ? (
            <ActivityRow key={group[0]!.key} item={group[0]!} base={base} quote={quote} />
          ) : (
            <BlockedRun key={group[0]!.key} items={group} base={base} quote={quote} />
          ),
        )}
      </ul>
      {activity.hasNextPage && (
        <Button variant="outline" className="w-full" onClick={() => void activity.fetchNextPage()} disabled={activity.isFetchingNextPage}>
          {activity.isFetchingNextPage ? "Loading…" : "Load older activity"}
        </Button>
      )}
    </div>
  );
}

/** Consecutive blocked attempts refused for the same reason collapse into one run. */
function groupRuns(items: ActivityItem[]): ActivityItem[][] {
  const groups: ActivityItem[][] = [];
  for (const item of items) {
    const last = groups.at(-1);
    const head = last?.[0];
    const sameRun =
      head && item.kind === "attempt" && item.outcome === "blocked" && head.kind === "attempt" &&
      head.outcome === "blocked" && head.source === item.source && head.error_name === item.error_name;
    if (sameRun) last!.push(item);
    else groups.push([item]);
  }
  return groups;
}

function BlockedRun({ items, base, quote }: { items: ActivityItem[]; base: TokenDisplay; quote: TokenDisplay }) {
  const [open, setOpen] = useState(false);
  const newest = items[0]!;
  const oldest = items.at(-1)!;
  return (
    <>
      <ActivityRow item={newest} base={base} quote={quote} />
      <li>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex w-full items-center gap-2 bg-blocked/5 px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
          {items.length - 1} more attempts refused for the same reason · blocks {oldest.block_number}–{items[1]!.block_number}
        </button>
      </li>
      {open && items.slice(1).map((item) => <ActivityRow key={item.key} item={item} base={base} quote={quote} />)}
    </>
  );
}

function ActivityRow({ item, base, quote }: { item: ActivityItem; base: TokenDisplay; quote: TokenDisplay }) {
  const meta = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      <span className="tabular font-mono">block {item.block_number}</span>
      <span>{formatChainTime(item.timestamp)}</span>
      {item.tx_hash && <Hex value={item.tx_hash} />}
      {item.source === "simulated" && <SyntheticTag label="SIMULATED" />}
    </div>
  );

  if (item.kind === "fill") {
    const sell = item.is_sell!;
    const baseAmount = sell ? item.amount_out! : item.amount_in!;
    const quoteAmount = sell ? item.amount_in! : item.amount_out!;
    return (
      <li className="flex items-start gap-3 p-3">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-filled" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm">
            <span className="font-medium">{sell ? "Treasury sold" : "Treasury bought back"}</span>{" "}
            <span className="tabular font-mono">{formatUnits(baseAmount, base.decimals)} {base.symbol}</span> for{" "}
            <span className="tabular font-mono">{formatUnits(quoteAmount, quote.decimals)} {quote.symbol}</span>
            <span className="text-muted-foreground"> at {formatPrice(item.price_x36!, base.decimals, quote.decimals)}</span>
          </p>
          {meta}
        </div>
      </li>
    );
  }

  if (item.outcome === "allowed") {
    return (
      <li className="flex items-start gap-3 p-3">
        <FlaskConical className="mt-0.5 size-4 shrink-0 text-filled" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm">
            Simulated trade would fill:{" "}
            <span className="tabular font-mono">{item.amount_in}</span> in →{" "}
            <span className="tabular font-mono">{item.amount_out}</span> out (raw units)
          </p>
          {meta}
        </div>
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-2 bg-blocked/5 p-3 sm:flex-row sm:items-start sm:gap-4">
      <BlockedStamp clause={CLAUSE[item.error_name ?? ""] ?? item.error_name} className="shrink-0 self-start" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm">{item.explanation ?? "Refused by the contract."}</p>
        {meta}
      </div>
    </li>
  );
}
