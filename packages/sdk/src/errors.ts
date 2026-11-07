import { decodeErrorResult, formatUnits, isHex, type Abi, type Hex } from "viem";
import { mandateModuleAbi, mandateQuoterAbi, uniswapV4MarketOracleAbi, mandateOracleHookAbi,
  aquaAbi, aquaSwapVmRouterAbi, erc20Abi, erc20ErrorsAbi } from "./abis.ts";
import { RISK_REASONS } from "./transactions.ts";
import { formatPriceX36, formatTokenAmount, type TokenDisplay } from "./units.ts";

export interface ErrorContext {
  readonly base?: TokenDisplay;
  readonly quote?: TokenDisplay;
  /** End of the policy's current period (from policyCounters), to say when caps reset. */
  readonly periodEndsAt?: bigint;
  readonly now?: bigint;
}
export interface ExplainedError {
  readonly errorName: string;
  readonly message: string;
  readonly args: readonly unknown[];
  readonly data: Hex | null;
  readonly selector: Hex | null;
  readonly cause?: ExplainedError;
}

type OwnErrorName = Extract<(typeof mandateModuleAbi | typeof mandateQuoterAbi
  | typeof uniswapV4MarketOracleAbi | typeof mandateOracleHookAbi)[number], { type: "error" }>["name"];
type Renderer = (args: readonly unknown[], context: ErrorContext) => string;
const n = (args: readonly unknown[], i: number) => BigInt(String(args[i]));
const token = (args: readonly unknown[], i: number, context: ErrorContext) => formatTokenAmount(n(args, i), context.base);
const price = (args: readonly unknown[], i: number, context: ErrorContext) => context.base && context.quote
  ? `${formatPriceX36(n(args, i), context.base.decimals, context.quote.decimals)} ${context.quote.symbol}/${context.base.symbol}`
  : `${n(args, i)} X36 units`;
const percent = (args: readonly unknown[], i: number) => `${formatUnits(n(args, i), 2)}%`;
const blocked = (text: string) => `Blocked by Mandate · ${text}`;

const FIELDS: Record<string, string> = {
  allotment: "token allotment", releaseDuration: "release duration", periodLength: "period length",
  grossSellCap: "gross sell limit", netSellCap: "net sell limit", maxQuoteDeviationBps: "quote tolerance",
  maxImpactBps: "price impact allowance", oracle: "market oracle", twapWindow: "TWAP window",
  shortWindow: "short TWAP window", depthBandBps: "depth band", defensiveMoveBps: "defensive move threshold",
  defensiveVolatilityBps: "defensive volatility threshold", defensiveDepth: "defensive depth threshold",
  "normal.maxFillBase": "normal-mode fill limit", "normal.maxFillDepthBps": "normal-mode share of depth",
  "normal.minSpreadBps": "normal-mode minimum spread", "defensive.maxFillBase": "defensive-mode fill limit",
  "defensive.maxFillDepthBps": "defensive-mode share of depth", "defensive.minSpreadBps": "defensive-mode minimum spread",
  "defensive.buybacksAllowed": "defensive-mode buybacks", spreadBps: "spread", maxShipped: "maximum shipped inventory",
  mmFeeShareBps: "MM fee share", maxBuyPriceX36: "maximum buyback price",
  shippedBase: "shipped token inventory", shippedQuote: "shipped quote inventory",
};
const field = (value: unknown) => FIELDS[String(value)] ?? "requested setting";
const reset = (c: ErrorContext) => c.periodEndsAt !== undefined && c.now !== undefined
  ? ` Resets in ${c.periodEndsAt > c.now ? c.periodEndsAt - c.now : 0n} seconds.` : "";
const REASONS: Record<string, string> = {
  None: "the market is calm",
  Unpriced: "the oracle has no price yet (not enough pool history)",
  PoolTooYoung: "the anchor pool is younger than the issuer's minimum age",
  DepthBelowMinimum: "the pool's trusted liquidity is below the issuer's minimum",
  MoveBeyondPause: "the live price has moved past the issuer's pause threshold",
  VolatilityBeyondPause: "short-term volatility is past the issuer's pause threshold",
  MoveDefensive: "the live price has moved past the issuer's defensive threshold",
  VolatilityDefensive: "short-term volatility is past the issuer's defensive threshold",
  DepthDefensive: "the pool's trusted liquidity is below the issuer's defensive threshold",
};
/** Plain-language reason for a risk mode, from its onchain index. */
export const riskReasonText = (index: number | bigint) => REASONS[RISK_REASONS[Number(index)] ?? ""] ?? "an unknown reason";
const MODES = ["Normal", "Defensive", "Paused"];

/** Every custom error in our production contract ABIs is required here at compile time. */
export const ERROR_MESSAGES = {
  NotIssuer: () => "Only the issuer Safe can authorize this action. Its owners must sign a Safe transaction.",
  NotMarketMaker: () => "Only this strategy's market maker can perform this action.",
  NotIssuerOrMarketMaker: () => "Only the issuer Safe or the strategy's market maker can pause it.",
  ModuleNotEnabled: () => "Enable the Mandate module on the issuer Safe before creating a policy.",
  InvalidParties: () => "Choose a valid market maker and two distinct token addresses.",
  PolicyAlreadyActive: () => "This Safe already has a live policy for this token. Update it, or revoke it first.",
  InvalidPolicy: (a) => `The policy's ${field(a[0])} is invalid. Review the policy settings.`,
  InvalidStrategy: (a) => `The strategy's ${field(a[0])} is invalid for its kind. Review the strategy bounds.`,
  ParamsOutOfBounds: (a) => blocked(`The ${field(a[0])} is outside the issuer's bounds.`),
  FeeShareIsFixed: () => "The MM fee share was fixed when the strategy was added and cannot be changed.",
  TooManyStrategies: (a) => `At most ${n(a, 0)} strategies are allowed here. Revoke one first.`,
  InsufficientBacking: (a) => blocked(`The Safe's strategies would promise ${n(a, 1)} of a token it holds only ${n(a, 2)} of (raw units). Ship less.`),
  PolicyNotActive: () => "Strategies can only be added to an active policy.",
  IsRevoked: () => blocked("This has been permanently revoked."),
  NotActive: () => "Only an active policy or strategy can be paused.",
  NotPaused: () => "Only a paused policy or strategy can be resumed; revocation is permanent.",
  NothingToClaim: () => "No earned MM fees are currently available to claim.",
  SafeCallFailed: () => "The Safe could not execute the requested action.",
  ReentrancyGuardReentrantCall: () => "The contract blocked a nested call to an action already in progress.",
  NotRouter: () => "This call must come through the 1inch Aqua router.",
  InvalidArgs: () => "The order has invalid strategy data. Use the strategy's active order from the module.",
  StrategyNotFound: () => "No strategy exists with this id on the selected network.",
  WrongMaker: () => "The order's maker must be the policy's issuer Safe.",
  InactiveStrategy: () => "This order is no longer active. Refresh the order after a reship.",
  WrongPair: () => "These tokens do not match the policy's trading pair.",
  AmountAlreadyComputed: () => "This order already computed an amount before reaching the quoter.",
  PolicyRevoked: () => blocked("The treasury policy has been permanently revoked."),
  PolicyPaused: () => blocked("The treasury policy is paused. Only the issuer Safe can resume it."),
  StrategyRevoked: () => blocked("This strategy has been permanently revoked."),
  StrategyPaused: () => blocked("This strategy is paused. Only the issuer Safe can resume it."),
  RiskPaused: (a) => blocked(`The treasury is paused because ${riskReasonText(n(a, 0))}. Trading resumes when the market recovers.`),
  QuoteOffMarket: (a, c) => blocked(`The strategy's price ${price(a, 0, c)} is ${percent(a, 2)} away from the Uniswap average ${price(a, 1, c)} (limit ${percent(a, 3)}). The order needs repricing.`),
  PriceImpactTooHigh: (a) => blocked(`This trade would move the price ${percent(a, 2)} (limit ${percent(a, 3)}). Trade a smaller amount.`),
  FillTooLarge: (a, c) => blocked(`This trade asks for ${token(a, 0, c)}; the current limit per trade is ${token(a, 1, c)}.`),
  SellsNotAllowed: () => blocked("This is a buyback strategy: it only buys tokens back."),
  BelowFloor: (a, c) => blocked(`Price ${price(a, 0, c)} is below the ${price(a, 1, c)} floor.`),
  GrossSellCapReached: (a, c) => blocked(`The gross sell limit would be exceeded (${token(a, 0, c)} / ${token(a, 2, c)} sold this period). This trade asks for ${token(a, 1, c)}.${reset(c)}`),
  NetSellCapReached: (a, c) => blocked(`The net sell limit would be exceeded (${token(a, 0, c)} / ${token(a, 2, c)} net sold this period). This trade asks for ${token(a, 1, c)}.${reset(c)}`),
  ReleaseExceeded: (a, c) => blocked(`Only ${token(a, 2, c)} has unlocked so far; ${token(a, 0, c)} is already net sold and this trade asks for ${token(a, 1, c)}.`),
  BuybacksNotAllowed: (a) => blocked(`Buybacks are not allowed in ${MODES[Number(n(a, 0))] ?? "the current"} mode.`),
  AboveMaxBuyPrice: (a, c) => blocked(`The buyback price ${price(a, 0, c)} is above the strategy's ${price(a, 1, c)} limit.`),
  QuoteSpendCapReached: (a, c) => {
    const q = (i: number) => formatTokenAmount(n(a, i), c.quote);
    return blocked(`The buyback budget would be exceeded (${q(0)} / ${q(2)} spent this period). This trade needs ${q(1)}.${reset(c)}`);
  },
  ZeroAddress: () => "The contract configuration contains a missing address.",
  ZeroAmount: () => "Enter a non-zero trade amount and use a valid reference price.",
  ZeroBalance: () => "The strategy needs inventory in both tokens before it can quote.",
  InsufficientLiquidity: () => "The requested output would exhaust this strategy's virtual inventory. Reduce the trade size.",
  InvalidSpread: () => "The spread must be less than 100% and stay within the issuer's bounds.",
  InvalidEpochLength: () => "The period length must be greater than zero.",
  InstructionArgsTooLong: () => "The strategy instruction is too large for this router version.",
  SafeCastOverflowedUintDowncast: () => "This value exceeds the contract's supported numeric range.",
  MakerTraitsMissingHasPostTransferInFlag: () => "The strategy's incoming-token hook configuration is inconsistent.",
  MakerTraitsMissingHasPostTransferOutFlag: () => "The strategy's outgoing-token hook configuration is inconsistent.",
  MakerTraitsMissingHasPreTransferInFlag: () => "The strategy's incoming-token hook configuration is inconsistent.",
  MakerTraitsMissingHasPreTransferOutFlag: () => "The strategy's outgoing-token hook configuration is inconsistent.",
  ZeroHook: () => "This pool needs an oracle hook before it can anchor a policy.",
  PairNotInPool: () => "The selected pool does not contain the policy's two tokens.",
  HookNotImplemented: () => "This operation is not supported by the pool's oracle hook.",
  NotPoolManager: () => "Only the configured Uniswap PoolManager can call this hook.",
  PoolNotInitialized: () => "Initialize the Uniswap pool before requesting its price.",
  TargetPredatesOldestObservation: () => "The oracle does not yet have enough history for this TWAP window.",
} satisfies Record<OwnErrorName, Renderer>;

const errorAbi: Abi = [mandateModuleAbi, mandateQuoterAbi, uniswapV4MarketOracleAbi, mandateOracleHookAbi,
  aquaAbi, aquaSwapVmRouterAbi, erc20Abi, erc20ErrorsAbi].flatMap((abi) => abi.filter((item) => item.type === "error"));
const TOKEN_MESSAGES: Record<string, string> = {
  ERC20InsufficientBalance: "The token balance is too low to complete this action.",
  ERC20InsufficientAllowance: "The token allowance is too low. Approve enough input tokens for the correct spender.",
  ERC20InvalidSender: "The token transfer has an invalid sender.",
  ERC20InvalidReceiver: "The token transfer has an invalid recipient.",
  ERC20InvalidApprover: "The token approval has an invalid owner.",
  ERC20InvalidSpender: "The token approval has an invalid spender.",
};
const VENUE_MESSAGES: Record<string, string> = {
  SafeBalancesForTokenNotInActiveStrategy: "This strategy is docked or does not include the requested token. Refresh the strategy's status and active order.",
  StrategiesMustBeImmutable: "This strategy hash was already shipped. Reship through the module to use a fresh nonce.",
  TakerTraitsDeadlineExpired: "This swap request has expired. Request a fresh quote.",
  TakerTraitsExceedingMaxInputAmount: "This fill would cost more than your maximum input amount.",
  TakerTraitsInsufficientMinOutputAmount: "This fill would return less than your minimum output amount.",
  TakerTraitsAmountOutMustBeGreaterThanZero: "This amount is too small to produce a non-zero output.",
  SafeTransferFailed: "The token transfer failed. Check the sender's balance and the token's transfer restrictions.",
  SafeTransferFromFailed: "The input-token transfer failed. Check the balance and router allowance.",
  TxOriginTokenBalanceIsZero: "This strategy requires a credential token held by the transaction origin.",
};
const SAFE_MESSAGES: Record<string, string> = {
  GS001: "The Safe has not been initialized with an approval threshold.",
  GS013: "The signed Safe transaction could not execute its inner action. Simulate the module call for its detailed reason.",
  GS020: "More owner signatures are required to meet the Safe's approval threshold.",
  GS026: "The Safe signatures are invalid, out of order, or were signed for a different nonce.",
  GS031: "This setting must be changed through a signed Safe transaction.",
  GS104: "The caller is not an enabled Safe module. The MM cannot transfer Safe tokens directly.",
};

/** Inspect known provider error fields only; transaction calldata and arbitrary text are never treated as reverts. */
function revertData(input: unknown, visited = new Set<object>(), depth = 0): Hex | null {
  if (typeof input === "string") return isHex(input) && input.length % 2 === 0 ? input : null;
  if (!input || typeof input !== "object" || depth > 8 || visited.has(input)) return null;
  visited.add(input);
  const value = input as Record<string, unknown>;
  for (const key of ["raw", "data", "cause", "error", "originalError"]) {
    const found = revertData(value[key], visited, depth + 1);
    if (found && found.length >= 10) return found;
  }
  return null;
}

export function explainError(input: unknown, context: ErrorContext = {}, depth = 0): ExplainedError {
  const data = revertData(input);
  const unknown = (message = "The action failed without a recognized contract reason. Refresh the state and try again."): ExplainedError => ({
    errorName: "UnknownError", message, args: [], data, selector: data && data.length >= 10 ? data.slice(0, 10) as Hex : null,
  });
  if (!data || data.length < 10 || depth > 4) return unknown();
  try {
    const decoded = decodeErrorResult({ abi: errorAbi, data });
    const args = decoded.args ?? [];
    let message: string;
    if (decoded.errorName === "Error") message = SAFE_MESSAGES[String(args[0])] ?? "The contract refused this action. Check its configuration and permissions.";
    else if (decoded.errorName === "Panic") message = "The contract encountered an internal arithmetic or state error. This action cannot proceed.";
    else {
      const render = (ERROR_MESSAGES as Record<string, Renderer>)[decoded.errorName];
      message = render ? render(args, context) : TOKEN_MESSAGES[decoded.errorName]
        ?? VENUE_MESSAGES[decoded.errorName]
        ?? "The liquidity venue refused this action. Check balances, allowances and trade limits.";
    }
    const result: ExplainedError = { errorName: decoded.errorName, message, args, data, selector: data.slice(0, 10) as Hex };
    if (decoded.errorName === "SafeCallFailed" && args[1]) {
      const cause = explainError(args[1], context, depth + 1);
      return { ...result, message: `${message} ${cause.message}`, cause };
    }
    return result;
  } catch { return unknown(); }
}
