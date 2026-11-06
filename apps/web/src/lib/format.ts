/**
 * Formatting for raw onchain values. Everything stays bigint until the final string: no floating-point
 * rounding of token amounts or prices.
 */
const PRICE_SCALE = 10n ** 36n;

function group(integer: string): string {
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Fixed-point decimal string of `value / 10^decimals`, with at most `maxFraction` digits (truncated). */
export function formatUnits(raw: string | bigint, decimals: number, maxFraction = 2): string {
  const value = BigInt(raw);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  let fraction = (abs % scale).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  if (maxFraction === 0) fraction = "";
  return `${negative ? "-" : ""}${group(whole.toString())}${fraction ? `.${fraction}` : ""}`;
}

/** Compact amount: 1.25M, 340K. Exact values belong in tooltips. */
export function formatCompact(raw: string | bigint, decimals: number): string {
  const whole = Number(BigInt(raw) / 10n ** BigInt(Math.max(decimals - 2, 0))) / (decimals >= 2 ? 100 : 1);
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(whole);
}

/** Human price of base in quote from an X36 value, e.g. "0.4013". */
export function formatPrice(x36: string | bigint, baseDecimals: number, quoteDecimals: number, digits = 4): string {
  const scaled = (BigInt(x36) * 10n ** BigInt(baseDecimals) * 10n ** BigInt(digits)) / (PRICE_SCALE * 10n ** BigInt(quoteDecimals));
  return formatUnits(scaled, digits, digits);
}

export function formatBps(bps: string | number | bigint): string {
  return `${formatUnits(BigInt(bps), 2, 2)}%`;
}

/** Share of `part` in `whole` as 0..1 (clamped), for gauges. */
export function ratio(part: string | bigint, whole: string | bigint): number {
  const w = BigInt(whole);
  if (w === 0n) return 0;
  const r = Number((BigInt(part) * 10_000n) / w) / 10_000;
  return Math.min(Math.max(r, 0), 1);
}

export function shortHex(value: string, chars = 4): string {
  return value.length <= 2 + chars * 2 ? value : `${value.slice(0, 2 + chars)}…${value.slice(-chars)}`;
}

/** "4h 12m" between two unix-second timestamps (chain time, not wall clock). */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "now";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${seconds % 60}s`;
}

export function formatChainTime(seconds: string | number): string {
  return new Date(Number(seconds) * 1000).toLocaleString("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
