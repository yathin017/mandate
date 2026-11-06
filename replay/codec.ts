import { explainError } from "@mandate/sdk";

// Fixed replay snapshot/event decoding. Custom error decoding is shared with the SDK.
export function words(data: string): bigint[] {
  if (!/^0x(?:[0-9a-fA-F]{64})*$/.test(data)) throw new Error("Malformed ABI words");
  return data.slice(2).match(/.{64}/g)?.map((word) => BigInt(`0x${word}`)) ?? [];
}

function dynamicBytes(data: string, offset: bigint): string {
  const start = Number(offset) * 2;
  const payload = data.slice(2);
  if (!Number.isSafeInteger(start) || start < 0 || start + 64 > payload.length) throw new Error("Invalid ABI offset");
  const length = Number(BigInt(`0x${payload.slice(start, start + 64)}`));
  if (!Number.isSafeInteger(length) || start + 64 + length * 2 > payload.length) throw new Error("Truncated ABI bytes");
  return `0x${payload.slice(start + 64, start + 64 + length * 2)}`;
}

export function decodeAttempt(data: string) {
  const fields = words(data);
  if (fields.length < 4 || fields[0] >= 1n << 160n || fields[1] > 1n || fields[2] !== 96n) {
    throw new Error("Malformed Attempted event");
  }
  return {
    target: `0x${fields[0].toString(16).padStart(40, "0")}`,
    success: fields[1] === 1n,
    result: dynamicBytes(data, fields[2]),
  };
}

/** Field order of DemoState.snapshot (contracts/script/demo/DemoState.sol). */
export const SNAPSHOT_FIELDS = [
  "safeBase", "safeQuote", "grossSold", "netSold", "totalNetSold", "quoteSpent", "released",
  "traditionalBase", "traditionalQuote", "v4SpotX36", "twapX36", "shortTwapX36", "trustedDepthBase",
  "riskMode", "riskReason", "claimedBase", "claimedQuote", "spreadBps", "strategyNonce", "strategyStatus",
  "policyStatus", "traditionalSpotX36",
] as const;

export function decodeSnapshot(data: string): Record<string, string> {
  const values = words(data);
  if (values.length !== SNAPSHOT_FIELDS.length) throw new Error("Snapshot ABI does not match schema");
  return Object.fromEntries(SNAPSHOT_FIELDS.map((name, i) => [name, values[i].toString()]));
}

export const ERROR_SIGNATURES = {
  NetSellCapReached: "NetSellCapReached(uint256,uint256,uint256)",
  RiskPaused: "RiskPaused(uint8)",
  QuoteOffMarket: "QuoteOffMarket(uint256,uint256,uint256,uint256)",
  InsufficientBacking: "InsufficientBacking(address,uint256,uint256)",
  ParamsOutOfBounds: "ParamsOutOfBounds(string)",
  SafeError: "Error(string)",
  StrategyPaused: "StrategyPaused()",
  IsRevoked: "IsRevoked()",
} as const;

export function decodeFailure(data: string, selectors: Record<string, string>) {
  const selector = data.slice(0, 10).toLowerCase();
  const name = selectors[selector];
  if (!name) throw new Error(`Unmapped scenario error ${selector}`);
  const decoded = explainError(data, { base: { symbol: "LAUNCH", decimals: 18 }, quote: { symbol: "sUSDC", decimals: 6 } });
  if ((decoded.errorName === "Error" ? "SafeError" : decoded.errorName) !== name) throw new Error(`Scenario error ABI drift: ${selector}`);
  const args = decoded.args.map(String);
  if (name === "SafeError" && args[0] !== "GS104") throw new Error(`Unexpected Safe error ${args[0]}`);
  return { selector, name, args, message: decoded.message };
}

export function assertLocalRpc(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || !url.port || Number(url.port) < 1024 || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Replay requires a loopback HTTP RPC URL with an explicit unprivileged port");
  }
  return url;
}
