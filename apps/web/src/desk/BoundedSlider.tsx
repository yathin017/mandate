import { Lock } from "lucide-react";

import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Slider whose ends are the issuer's bounds (spec 10.2 rule 3): it physically cannot go past them, and a lock
 * explains why.
 */
export function BoundedSlider({
  label,
  caption,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  caption: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const rail = (side: "min" | "max", v: number) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex cursor-help items-center gap-1 text-[11px] text-muted-foreground">
          <Lock className="size-3" /> {format(v)}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs">
        Issuer bound ({side}). Only the issuer Safe can change it; the module rejects anything past it.
      </TooltipContent>
    </Tooltip>
  );
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <div>
          <p className="text-sm font-medium">{label}</p>
          <p className="text-[11px] text-muted-foreground">{caption}</p>
        </div>
        <span className="tabular font-mono text-lg font-semibold">{format(value)}</span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v ?? value)} aria-label={label} />
      <div className="flex justify-between">
        {rail("min", min)}
        {rail("max", max)}
      </div>
    </div>
  );
}
