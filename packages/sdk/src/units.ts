import { formatUnits } from "viem";

export interface TokenDisplay { readonly decimals: number; readonly symbol: string }
export function decimals(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error("Token decimals must be an integer from 0 to 255");
  return value;
}

export function formatTokenAmount(amount: bigint, token?: TokenDisplay): string {
  return token ? `${formatUnits(amount, decimals(token.decimals))} ${token.symbol}` : `${amount} base units`;
}

/** Converts a human quote/base price into quoteRaw * 1e36 / baseRaw. Never uses floating-point arithmetic. */
export function parsePriceX36(value: string, baseDecimals: number, quoteDecimals: number): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || value.length > 256) throw new Error("Enter an unsigned decimal price");
  const [whole, fraction = ""] = value.split(".");
  const numerator = BigInt(whole! + fraction) * 10n ** BigInt(36 + decimals(quoteDecimals));
  const denominator = 10n ** BigInt(fraction.length + decimals(baseDecimals));
  if (numerator % denominator !== 0n) throw new Error("Price has more precision than X36 can represent");
  const price = numerator / denominator;
  if (price > (1n << 256n) - 1n) throw new Error("Price exceeds uint256");
  return price;
}

/** Floors display digits; a positive price smaller than the display unit is shown as '<…', never zero. */
export function formatPriceX36(price: bigint, baseDecimals: number, quoteDecimals: number, precision = 6): string {
  if (price < 0n) throw new Error("Price cannot be negative");
  if (!Number.isInteger(precision) || precision < 0 || precision > 36) throw new Error("Display precision must be 0–36");
  const scaled = price * 10n ** BigInt(decimals(baseDecimals) + precision)
    / (10n ** BigInt(36 + decimals(quoteDecimals)));
  if (scaled === 0n && price > 0n) return `<${formatUnits(1n, precision)}`;
  return formatUnits(scaled, precision);
}
