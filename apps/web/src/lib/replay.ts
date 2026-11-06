/**
 * Shape of replay/data/acts.json as served by GET /v1/replay (schemaVersion 1). Only the fields the Replay
 * Theater reads are typed; see replay/README.md for the full format.
 */
export interface ReplayState {
  safeBase: string;
  safeQuote: string;
  epochNetSold: string;
  totalNetSold: string;
  traditionalBase: string;
  traditionalQuote: string;
  v4SpotX36: string;
  twapX36: string;
  released: string;
  remainingThisEpoch: string;
  traditionalSpotX36: string;
  spreadBps: string;
  epochCap: string;
  status: string;
  claimedBase: string;
  claimedQuote: string;
}

export interface ReplayStep {
  step: number;
  kind: string;
  label: string;
  target: string;
  outcome: "executed" | "blocked";
  error: { selector: string; name: string; args: unknown[]; message: string } | null;
  transactionHash: string;
  blockNumber: number;
  timestamp: number;
  state: ReplayState;
}

export interface ReplayAct {
  act: number;
  title: string;
  label: string;
  disclosure: string;
  allottedBase: string;
  epochCap: string;
  mandateId: string;
  initialState: ReplayState;
  steps: ReplayStep[];
}

export interface Replay {
  schemaVersion: 1;
  environment: string;
  chainId: number;
  sourceChainId: number;
  forkBlock: number;
  syntheticTokens: boolean;
  syntheticOracleHistory: boolean;
  blockedAttemptSemantics: string;
  tokens: {
    base: { address: string; symbol: string; decimals: number };
    quote: { address: string; symbol: string; decimals: number };
  };
  acts: ReplayAct[];
}
