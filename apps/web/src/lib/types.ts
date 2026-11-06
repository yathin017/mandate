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

// ---------------------------------------------------------------- platform (sign-in, marketplace, launches)

/** Signed-in wallet session (`/v1/auth/session`). */
export interface Session {
  id: string;
  address: string;
  chainId: number;
  expiresAt: string;
}

export interface AuthNonce {
  nonce: string;
  chainId: number;
  statement: string;
  expiresInSeconds: number;
}

/** Public market-maker listing (`/v1/mms`). Never carries performance: see `MmScore`. */
export interface MmProfile {
  address: string;
  displayName: string;
  bio: string;
  website: string | null;
  contact: string | null;
  coverage: string[];
  minDealUsd: number | null;
  listed: boolean;
  updatedAt: string;
}

export type ScoreComponent = "availability" | "priceQuality" | "volume" | "reliability" | "responsiveness";

/** Onchain market-maker score (`/v1/chains/:id/mms/scores`). */
export interface MmScore {
  mm: string;
  status: "scored" | "new";
  score: number | null;
  components: Record<ScoreComponent, { value: number | null; weight: number; evidence: string }>;
  window: { from: string; to: string };
}

/** Token deployed through the chain's TokenFactory (`/v1/chains/:id/tokens/launched`). */
export interface LaunchedToken {
  chainId: number;
  token: string;
  factory: string;
  creator: string;
  recipient: string;
  name: string;
  symbol: string;
  supply: string;
  blockNumber: string;
  timestamp: string;
  txHash: string;
}
