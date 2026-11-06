import { cn } from "@/lib/utils";

/** Ring gauge for `value` in 0..1. Turns amber above 80% and vermilion at 100%. */
export function RingGauge({ value, label, sublabel }: { value: number; label: string; sublabel?: string }) {
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const tone = value >= 1 ? "text-blocked" : value >= 0.8 ? "text-warning" : "text-filled";
  return (
    <div className="relative mx-auto size-36">
      <svg viewBox="0 0 120 120" className="size-full -rotate-90" role="img" aria-label={`${label} ${Math.round(value * 100)}%`}>
        <circle cx="60" cy="60" r={radius} fill="none" strokeWidth="10" className="stroke-muted" />
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - value)}
          className={cn("stroke-current transition-[stroke-dashoffset] duration-700", tone)}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="tabular font-mono text-2xl font-semibold">{label}</span>
        {sublabel && <span className="text-xs text-muted-foreground">{sublabel}</span>}
      </div>
    </div>
  );
}

/** Labelled figure with an optional small "jargon" caption underneath (plain words first, spec 10.2). */
export function Stat({ label, value, caption }: { label: string; value: React.ReactNode; caption?: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="tabular font-mono text-lg font-semibold">{value}</div>
      {caption && <div className="text-[11px] text-muted-foreground/80">{caption}</div>}
    </div>
  );
}
