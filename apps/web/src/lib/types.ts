/**
 * Response shapes of the indexer API (apps/indexer). All uint256 values are decimal strings in raw token units;
 * prices are `quoteRaw * 1e36 / baseRaw`. Keep in sync with apps/indexer/src/api.
 */
export interface Head {
  number: string;
  hash: string;
}

export interface Envelope<T> {
  head: Head;
  data: T;
}

export interface TokenDisplay {
  symbol: string;
  decimals: number;
}

export interface Tokens {
  base: TokenDisplay | null;
  quote: TokenDisplay | null;
}

/** MandateStatus: 1 Active, 2 Paused, 3 Revoked. */
export type MandateStatus = 1 | 2 | 3;

export interface MandateBounds {
  allotment: string;
  releaseStart: string;
  releaseDuration: string;
  epochLength: string;
  maxEpochCap: string;
  maxShippedQuote: string;
  floorPriceX36: string;
  maxAnchorDeviationBps: number | string;
  twapWindow: number | string;
  spreadBpsMin: number | string;
  spreadBpsMax: number | string;
  mmFeeShareBps: number | string;
  anchor: string;
  quoter: string;
}

export interface MandateParams {
  spreadBps: number | string;
  epochCap: string;
  shippedBase: string;
  shippedQuote: string;
}

export interface Mandate {
  chainId: number;
  mandateId: string;
  module: string;
  safe: string;
  mm: string;
  base: string;
  quote: string;
  status: MandateStatus;
  activeStrategyHash: string;
  bounds: MandateBounds;
  params: MandateParams;
  createdBlock: string;
  updatedBlock: string;
}

export type AnchorStatus = "within-spot-band" | "blocked" | "unavailable";

export interface Snapshot {
  chainId: number;
  mandateId: string;
  blockNumber: string;
  blockHash: string;
  timestamp: string;
  status: MandateStatus;
  spreadBps: number;
  epochCap: string;
  epochIndex: string;
  netSoldThisEpoch: string;
  totalNetSold: string;
  released: string;
  remainingThisEpoch: string;
  sellableNow: string;
  epochResetsAt: string;
  feesBase: string;
  feesQuote: string;
  claimedBase: string;
  claimedQuote: string;
  anchorStatus: AnchorStatus;
  anchorSpotX36: string | null;
  anchorTwapX36: string | null;
  anchorDeviationBps: string | null;
  anchorMaxDeviationBps: number | null;
}

export interface MandateDetail {
  mandate: Mandate;
  tokens: Tokens;
  snapshot: Snapshot | null;
  chain: { environment: string; sourceChainId: number } | null;
}

export type MandateListItem = Mandate & { tokens: Tokens };

export interface ActivityItem {
  kind: "fill" | "attempt";
  block_number: string;
  ord: number;
  key: string;
  timestamp: string;
  tx_hash: string | null;
  source: "onchain" | "onchain_actor" | "simulated";
  outcome: "filled" | "allowed" | "blocked";
  is_sell: boolean | null;
  amount_in: string | null;
  amount_out: string | null;
  price_x36: string | null;
  fee_token: string | null;
  fee_amount: string | null;
  error_name: string | null;
  error_args: unknown;
  explanation: string | null;
  request: Record<string, unknown> | null;
}

export interface ActivityPage {
  items: ActivityItem[];
  next: string | null;
}

export interface SimulationResult {
  simulated: true;
  outcome: "allowed" | "blocked";
  errorName: string | null;
  explanation: string | null;
  amountIn: string | null;
  amountOut: string | null;
  blockNumber: string;
  blockHash: string;
  requestHash: string;
}

export interface Health {
  ok: boolean;
  db: boolean;
  redis: boolean;
  chainId: number;
  head: Head | null;
}
