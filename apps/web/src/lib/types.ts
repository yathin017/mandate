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

/** Status of a policy or a strategy: 1 Active, 2 Paused, 3 Revoked. */
export type Status = 1 | 2 | 3;
/** RiskMode the quoter applies: 0 Normal, 1 Defensive, 2 Paused. */
export type RiskMode = 0 | 1 | 2;
/** StrategyKind: 0 market making, 1 buyback. */
export type StrategyKind = 0 | 1;

/** Mirrors the DRAFT Solidity PolicyConfig; bigints as decimal strings. */
export interface PolicyConfig {
  release: { allotment: string; releaseStart: string; releaseDuration: string };
  period: { periodLength: string; grossSellCap: string; netSellCap: string; quoteSpendCap: string };
  price: { floorPriceX36: string; maxQuoteDeviationBps: number | string; maxImpactBps: number | string };
  oracle: {
    oracle: string; twapWindow: number | string; shortWindow: number | string; depthBandBps: number | string;
    minPoolAge: number | string; minTrustedDepth: string; defensiveMoveBps: number | string; pauseMoveBps: number | string;
    defensiveVolatilityBps: number | string; pauseVolatilityBps: number | string; defensiveDepth: string;
  };
  normal: ModeLimits;
  defensive: ModeLimits;
}

export interface ModeLimits {
  maxFillBase: string;
  maxFillDepthBps: number | string;
  minSpreadBps: number | string;
  buybacksAllowed: boolean;
}

export interface Policy {
  chainId: number;
  policyId: string;
  module: string;
  safe: string;
  base: string;
  quote: string;
  status: Status;
  config: PolicyConfig;
  createdBlock: string;
  updatedBlock: string;
}

export interface StrategyBounds {
  spreadBpsMin: number | string;
  spreadBpsMax: number | string;
  maxShippedBase: string;
  maxShippedQuote: string;
  mmFeeShareBps: number | string;
  maxBuyPriceX36: string;
}

export interface StrategyParams {
  spreadBps: number | string;
  shippedBase: string;
  shippedQuote: string;
}

export interface Strategy {
  chainId: number;
  strategyId: string;
  policyId: string;
  safe: string;
  mm: string;
  base: string;
  quote: string;
  kind: StrategyKind;
  status: Status;
  activeStrategyHash: string;
  bounds: StrategyBounds;
  params: StrategyParams;
  createdBlock: string;
  updatedBlock: string;
}

/** A policy's treasury-wide reading at one block: shared counters and the risk mode with the oracle readings. */
export interface PolicySnapshot {
  chainId: number;
  policyId: string;
  blockNumber: string;
  blockHash: string;
  timestamp: string;
  status: Status;
  periodIndex: string;
  grossSold: string;
  netSold: string;
  quoteSpent: string;
  totalNetSold: string;
  released: string;
  periodEndsAt: string;
  riskMode: RiskMode;
  /** RiskReason index (see the SDK's RISK_REASONS). */
  riskReason: number;
  priced: boolean;
  spotX36: string;
  twapX36: string;
  shortTwapX36: string;
  trustedDepthBase: string;
  poolAge: string;
}

/** A strategy's own reading at one block. */
export interface StrategySnapshot {
  chainId: number;
  strategyId: string;
  blockNumber: string;
  blockHash: string;
  timestamp: string;
  status: Status;
  spreadBps: number;
  shippedBase: string;
  shippedQuote: string;
  nonce: string;
  feesBase: string;
  feesQuote: string;
  claimedBase: string;
  claimedQuote: string;
}

export interface ChainInfo {
  environment: string;
  sourceChainId: number;
}

export interface PolicyDetail {
  policy: Policy;
  tokens: Tokens;
  snapshot: PolicySnapshot | null;
  strategies: Strategy[];
  chain: ChainInfo | null;
}

export interface StrategyDetail {
  strategy: Strategy;
  policy: Policy | null;
  tokens: Tokens;
  snapshot: StrategySnapshot | null;
  policySnapshot: PolicySnapshot | null;
  chain: ChainInfo | null;
}

export type PolicyListItem = Policy & { tokens: Tokens };
export type StrategyListItem = Strategy & { tokens: Tokens };

export interface ActivityItem {
  kind: "fill" | "attempt";
  strategy_id: string;
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
  /** Fills: the risk mode they ran in and their distance from the pre-fill market (bps, + favours the treasury). */
  risk_mode: number | null;
  quality_bps: number | null;
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

export type ProposalStatus = "draft" | "sent" | "accepted" | "declined" | "withdrawn" | "expired" | "executed";

/** A strategy an issuer Safe offers a market maker (`/v1/proposals`). `terms` is the SDK's StrategyTermsJson. */
export interface Proposal {
  id: string;
  chainId: number;
  safe: string;
  issuer: string;
  mm: string;
  base: string;
  quote: string;
  kind: StrategyKind;
  terms: import("@mandate/sdk").StrategyTermsJson;
  termsHash: string;
  status: ProposalStatus;
  /** Unix seconds. */
  expiresAt: number;
  mmSignature: string | null;
  strategyId: string | null;
  note: string;
  createdAt: string;
  sentAt: string | null;
  decidedAt: string | null;
}

/** One strategy's figures (`/safes/:safe/summary` per policy, `/mms/:address/summary`); amounts are raw units. */
export interface StrategySummary {
  strategyId: string;
  policyId: string;
  safe: string;
  status: Status;
  kind: StrategyKind;
  mm: string;
  base: string;
  quote: string;
  spreadBps: number | null;
  shippedBase: string;
  shippedQuote: string;
  feesBase: string;
  feesQuote: string;
  claimedBase: string;
  claimedQuote: string;
  /** The market maker's fixed share of the spread fees, and what that share comes to (raw units). */
  mmFeeShareBps: number;
  mmEarnedBase: string;
  mmEarnedQuote: string;
  fills: number;
  quoteVolume: string;
  /** Volume-weighted distance of fills from the pre-fill market, bps; + favours the treasury. */
  avgQualityBps: number | null;
  refused: number;
  policyStatus: Status | null;
  riskMode: RiskMode | null;
  riskReason: number | null;
  tokens: Tokens;
}

/** One policy in an issuer Safe's overview, with its latest reading and its strategies. */
export interface PolicySummary {
  policyId: string;
  status: Status;
  base: string;
  quote: string;
  config: PolicyConfig;
  grossSold: string;
  netSold: string;
  quoteSpent: string;
  totalNetSold: string;
  released: string;
  periodEndsAt: string | null;
  /** Chain time of the reading. */
  readAt: string | null;
  riskMode: RiskMode | null;
  riskReason: number | null;
  priced: boolean | null;
  spotX36: string | null;
  twapX36: string | null;
  trustedDepthBase: string | null;
  strategies: Omit<StrategySummary, "tokens">[];
  tokens: Tokens;
}
