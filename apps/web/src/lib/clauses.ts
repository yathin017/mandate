/** Short clause names for the BLOCKED stamp (spec 10.2); full sentences come from the SDK/indexer explanation. */
export const CLAUSE: Record<string, string> = {
  EpochCapReached: "Daily sell limit",
  ReleaseExceeded: "Release schedule",
  BelowFloor: "Price floor",
  AnchorDeviation: "Uniswap anchor",
  SpotTwapDivergence: "Manipulation guard",
  MandatePaused: "Mandate paused",
  MandateRevoked: "Mandate revoked",
  MandateIsRevoked: "Mandate revoked",
  MandateNotActive: "Not active",
  MandateNotPaused: "Not paused",
  ParamsOutOfBounds: "Issuer bounds",
  InvalidBounds: "Invalid terms",
  FeeShareIsFixed: "Fee share fixed",
  NothingToClaim: "Nothing to claim",
  NotIssuer: "Issuer only",
  NotMarketMaker: "MM only",
  NotIssuerOrMarketMaker: "Parties only",
  NotModule: "Safe permissions",
  SafeCallFailed: "Safe permissions",
  SafeBalancesForTokenNotInActiveStrategy: "Strategy docked",
};

export const clauseOf = (errorName: string | null | undefined): string | undefined =>
  errorName ? (CLAUSE[errorName] ?? errorName) : undefined;
