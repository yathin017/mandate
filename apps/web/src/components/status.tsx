import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { shortHex } from "@/lib/format";
import { riskReasonText } from "@mandate/sdk";

import type { RiskMode, Status } from "@/lib/types";

const STATUS: Record<Status, { label: string; className: string }> = {
  1: { label: "Active", className: "bg-filled text-filled-foreground" },
  2: { label: "Paused", className: "bg-warning text-warning-foreground" },
  3: { label: "Revoked", className: "bg-blocked text-blocked-foreground" },
};

/** Status of a policy or a strategy (set by its parties, unlike the risk mode). */
export function StatusPill({ status }: { status: Status }) {
  const s = STATUS[status];
  return <Badge className={cn("rounded-full", s.className)}>{s.label}</Badge>;
}

const MODE: Record<RiskMode, { label: string; className: string }> = {
  0: { label: "Normal", className: "border-filled text-filled" },
  1: { label: "Defensive", className: "border-warning text-warning" },
  2: { label: "Market pause", className: "border-blocked text-blocked" },
};

/**
 * The risk mode the quoter applies right now, from the oracle's readings against the issuer's thresholds. Hover for
 * the reason. Unknown (not yet indexed) shows nothing.
 */
export function RiskBadge({ mode, reason }: { mode: RiskMode | null | undefined; reason?: number | null | undefined }) {
  if (mode === null || mode === undefined) return null;
  const m = MODE[mode];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={cn("cursor-help rounded-full", m.className)}>{m.label}</Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs">
        {mode === 0 ? "Normal limits apply" : mode === 1 ? "Tighter limits apply" : "No fills"} because {riskReasonText(reason ?? 0)}.
      </TooltipContent>
    </Tooltip>
  );
}

/** The signature element: a rotated stamp naming the clause that refused the action. */
export function BlockedStamp({ clause, className }: { clause?: string | null; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex -rotate-3 flex-col items-center rounded-sm border-2 border-blocked px-2 py-0.5 text-blocked",
        "animate-in zoom-in-150 fade-in duration-300",
        className,
      )}
      aria-label={`Blocked by Mandate${clause ? `: ${clause}` : ""}`}
    >
      <span className="text-[10px] font-bold tracking-widest uppercase">Blocked by Mandate</span>
      {clause && <span className="font-mono text-[10px] leading-tight">{clause}</span>}
    </span>
  );
}

/** Labels data that is modeled or synthetic. Spec: every non-real number carries a visible tag. */
export function SyntheticTag({ label = "SYNTHETIC" }: { label?: string }) {
  return (
    <Badge variant="outline" className="border-warning font-mono text-[10px] tracking-wider text-warning">
      {label}
    </Badge>
  );
}

/** Hover a figure to see where it came from. */
export function Source({ children, block, detail }: { children: React.ReactNode; block?: string; detail: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-4">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs font-mono text-xs">
        {detail}
        {block ? ` · block ${block}` : ""}
      </TooltipContent>
    </Tooltip>
  );
}

export function Hex({ value, chars = 4 }: { value: string; chars?: number }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help font-mono">{shortHex(value, chars)}</span>
      </TooltipTrigger>
      <TooltipContent className="font-mono text-xs">{value}</TooltipContent>
    </Tooltip>
  );
}
