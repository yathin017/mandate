import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { MmScore, ScoreComponent } from "@/lib/types";

/** Plain names for the score components, in display order. */
export const COMPONENT_LABELS: Record<ScoreComponent, string> = {
  availability: "Availability",
  priceQuality: "Price quality",
  volume: "Volume",
  reliability: "Reliability",
  responsiveness: "Responsiveness",
};

/** 0-100 badge, or "New" without enough onchain history (never a zero). */
export function ScoreBadge({ score, className }: { score: MmScore | undefined; className?: string }) {
  if (!score || score.score === null) return <Badge variant="outline" className={className}>New</Badge>;
  const tone = score.score >= 75 ? "bg-filled text-filled-foreground" : score.score >= 50 ? "bg-warning text-warning-foreground" : "bg-blocked text-blocked-foreground";
  return <Badge className={cn("tabular font-mono", tone, className)}>{score.score}</Badge>;
}

/** Every component with its weight, value and the evidence behind it. */
export function ScoreBreakdown({ score }: { score: MmScore }) {
  return (
    <ul className="space-y-3">
      {(Object.keys(COMPONENT_LABELS) as ScoreComponent[]).map((key) => {
        const c = score.components[key];
        return (
          <li key={key} className="space-y-1">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="font-medium">
                {COMPONENT_LABELS[key]} <span className="text-xs font-normal text-muted-foreground">{Math.round(c.weight * 100)}%</span>
              </span>
              <span className="tabular font-mono">{c.value === null ? "no data" : Math.round(c.value * 100)}</span>
            </div>
            <Progress value={c.value === null ? 0 : c.value * 100} className={c.value === null ? "opacity-40" : undefined} />
            <p className="text-xs text-muted-foreground">{c.evidence}</p>
          </li>
        );
      })}
    </ul>
  );
}
