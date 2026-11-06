/**
 * Market-maker score: 0-100 from onchain evidence only, over a trailing 30-day window of chain time.
 *
 * | Component      | Weight | Measure                                                                         |
 * |----------------|--------|---------------------------------------------------------------------------------|
 * | availability   | 35%    | probe rounds that would fill ÷ rounds that would fill or failed for the MM's reason |
 * | priceQuality   | 20%    | 1 − volume-weighted (|fill price − TWAP| ÷ the mandate's anchor tolerance)       |
 * | volume         | 20%    | log-scaled quote volume relative to the busiest market maker on the chain        |
 * | reliability    | 15%    | share of mandates not revoked × min(1, days under management ÷ 30)               |
 * | responsiveness | 10%    | 1 − min(1, median minutes to recover from a fault or reship after a bounds change ÷ 120) |
 *
 * A component without evidence is reported as such and the remaining weights are rescaled; a market maker with fewer
 * than `MIN_PROBE_ROUNDS` probe rounds and no fills is "new" and gets no score (never zero).
 */
export const WEIGHTS = { availability: 0.35, priceQuality: 0.2, volume: 0.2, reliability: 0.15, responsiveness: 0.1 } as const;
export type Component = keyof typeof WEIGHTS;
export const WINDOW_SECONDS = 30 * 86_400;
export const MIN_PROBE_ROUNDS = 6;
const RESPONSE_TARGET_MINUTES = 120;
const TENURE_DAYS = 30;

export interface MmEvidence {
  readonly mm: string;
  /** Probe rounds (one per mandate per probe time) that would fill on every probed side. */
  readonly okRounds: number;
  /** Probe rounds with at least one refusal the market maker controls. */
  readonly faultRounds: number;
  /** Minutes from a fault (or an issuer bounds change) until the market maker's fix; open ones run to now. */
  readonly responseMinutes: readonly number[];
  readonly fills: number;
  /** Σ quote volume (whole tokens) and Σ volume × (deviation ÷ tolerance), for the weighted price quality. */
  readonly quoteVolume: number;
  readonly weightedDeviation: number;
  readonly mandates: number;
  readonly revoked: number;
  readonly managedDays: number;
}

export interface ComponentScore {
  /** 0-1, or null without evidence. */
  readonly value: number | null;
  readonly weight: number;
  /** Plain description of the evidence behind the value. */
  readonly evidence: string;
}

export interface MmScore {
  readonly mm: string;
  readonly status: "scored" | "new";
  /** 0-100, null when new. */
  readonly score: number | null;
  readonly components: Record<Component, ComponentScore>;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const round = (x: number, digits = 3) => Math.round(x * 10 ** digits) / 10 ** digits;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Scores every market maker on one chain; volume is relative, so they are scored together. */
export function computeScores(evidence: readonly MmEvidence[]): MmScore[] {
  const maxVolume = Math.max(0, ...evidence.map((e) => e.quoteVolume));
  return evidence.map((e) => {
    const rounds = e.okRounds + e.faultRounds;
    const components: Record<Component, ComponentScore> = {
      availability: {
        weight: WEIGHTS.availability,
        value: rounds >= MIN_PROBE_ROUNDS ? round(e.okRounds / rounds) : null,
        evidence: `${e.okRounds} of ${rounds} probe rounds would fill (refusals by issuer rails or the anchor's breakers excluded)`,
      },
      priceQuality: {
        weight: WEIGHTS.priceQuality,
        value: e.fills > 0 && e.quoteVolume > 0 ? round(clamp01(1 - e.weightedDeviation / e.quoteVolume)) : null,
        evidence: `${e.fills} fills; volume-weighted distance from the Uniswap TWAP, as a share of the anchor tolerance`,
      },
      volume: {
        weight: WEIGHTS.volume,
        value: e.fills > 0 && maxVolume > 0 ? round(Math.log10(1 + e.quoteVolume) / Math.log10(1 + maxVolume)) : null,
        evidence: `${round(e.quoteVolume, 2)} quote tokens traded, log-scaled against the busiest market maker`,
      },
      reliability: {
        weight: WEIGHTS.reliability,
        value: e.mandates > 0 ? round((1 - e.revoked / e.mandates) * Math.min(1, e.managedDays / TENURE_DAYS)) : null,
        evidence: `${e.mandates - e.revoked} of ${e.mandates} mandates not revoked; ${round(e.managedDays, 1)} days under management`,
      },
      responsiveness: {
        weight: WEIGHTS.responsiveness,
        value:
          e.responseMinutes.length > 0
            ? round(1 - Math.min(1, median(e.responseMinutes) / RESPONSE_TARGET_MINUTES))
            : rounds >= MIN_PROBE_ROUNDS
              ? 1
              : null,
        evidence:
          e.responseMinutes.length > 0
            ? `median ${round(median(e.responseMinutes), 1)} min over ${e.responseMinutes.length} faults or bounds changes`
            : "no faults or bounds changes to respond to",
      },
    };
    const isNew = rounds < MIN_PROBE_ROUNDS && e.fills === 0;
    const scored = Object.values(components).filter((c) => c.value !== null);
    const weight = scored.reduce((sum, c) => sum + c.weight, 0);
    const score = isNew || weight === 0 ? null : Math.round((100 * scored.reduce((sum, c) => sum + c.weight * c.value!, 0)) / weight);
    return { mm: e.mm, status: score === null ? "new" : "scored", score, components };
  });
}
