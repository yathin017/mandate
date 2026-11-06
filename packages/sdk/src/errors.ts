import { decodeErrorResult, formatUnits, isHex, type Abi, type Hex } from "viem";
import { mandateModuleAbi, mandateQuoterAbi, uniswapV4TwapAnchorAbi, mandateOracleHookAbi,
  aquaAbi, aquaSwapVmRouterAbi, erc20Abi, erc20ErrorsAbi } from "./abis.ts";
import { formatPriceX36, formatTokenAmount, type TokenDisplay } from "./units.ts";

export interface ErrorContext {
  readonly base?: TokenDisplay;
  readonly quote?: TokenDisplay;
  readonly epochResetsAt?: bigint;
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
  | typeof uniswapV4TwapAnchorAbi | typeof mandateOracleHookAbi)[number], { type: "error" }>["name"];
type Renderer = (args: readonly unknown[], context: ErrorContext) => string;
const n = (args: readonly unknown[], i: number) => BigInt(String(args[i]));
const token = (args: readonly unknown[], i: number, context: ErrorContext) => formatTokenAmount(n(args, i), context.base);
const price = (args: readonly unknown[], i: number, context: ErrorContext) => context.base && context.quote
  ? `${formatPriceX36(n(args, i), context.base.decimals, context.quote.decimals)} ${context.quote.symbol}/${context.base.symbol}`
  : `${n(args, i)} X36 units`;
const percent = (args: readonly unknown[], i: number) => `${formatUnits(n(args, i), 2)}%`;
const blocked = (text: string) => `Blocked by Mandate · ${text}`;

const FIELDS: Record<string, string> = {
  allotment: "token allocation", releaseStart: "release start", releaseDuration: "release duration",
  epochLength: "epoch length", maxEpochCap: "maximum epoch sell limit", maxShippedQuote: "buyback inventory limit",
  floorPriceX36: "price floor", maxAnchorDeviationBps: "anchor tolerance", twapWindow: "TWAP window",
  spreadBpsMin: "minimum spread", spreadBpsMax: "maximum spread", mmFeeShareBps: "MM fee share",
  anchor: "price anchor", quoter: "quoter", spreadBps: "spread", epochCap: "epoch sell limit",
  shippedBase: "shipped token inventory", shippedQuote: "shipped buyback inventory",
};
const field = (value: unknown) => FIELDS[String(value)] ?? "requested setting";

/** Every custom error in our production contract ABIs is required here at compile time. */
export const ERROR_MESSAGES = {
  NotIssuer: () => "Only the issuer Safe can authorize this action. Its owners must sign a Safe transaction.",
  NotMarketMaker: () => "Only this mandate's market maker can perform this action.",
  NotIssuerOrMarketMaker: () => "Only the issuer Safe or its market maker can pause this mandate.",
  ModuleNotEnabled: () => "Enable the Mandate module on the issuer Safe before creating a mandate.",
  InvalidParties: () => "Choose a valid market maker and two distinct token addresses.",
  InvalidBounds: (a) => `The issuer's ${field(a[0])} is invalid. Review the mandate terms.`,
  ParamsOutOfBounds: (a) => blocked(`The ${field(a[0])} is outside the issuer's bounds.`),
  FeeShareIsFixed: () => "The MM fee share was fixed at creation and cannot be changed.",
  MandateIsRevoked: () => blocked("This mandate has been permanently revoked."),
  MandateRevoked: () => blocked("This mandate has been permanently revoked."),
  MandateNotActive: () => "Only an active mandate can be paused.",
  MandateNotPaused: () => "Only a paused mandate can be resumed; revocation is permanent.",
  NothingToClaim: () => "No earned MM fees are currently available to claim.",
  SafeCallFailed: () => "The Safe could not execute the requested action.",
  ReentrancyGuardReentrantCall: () => "The contract blocked a nested call to an action already in progress.",
  NotRouter: () => "This call must come through the 1inch Aqua router.",
  InvalidArgs: () => "The strategy has invalid mandate data. Use its active order from the module.",
  MandateNotFound: () => "No mandate exists with this id on the selected network.",
  WrongMaker: () => "The strategy's maker must be the mandate's issuer Safe.",
  InactiveStrategy: () => "This strategy is no longer active. Refresh the order after a reship.",
  WrongPair: () => "These tokens do not match the mandate's trading pair.",
  AmountAlreadyComputed: () => "This strategy already computed an amount before reaching the quoter.",
  MandatePaused: () => blocked("This mandate is paused. Only the issuer Safe can resume it."),
  AnchorDeviation: (a, c) => blocked(`The execution price is ${percent(a, 2)} away from the Uniswap average (limit ${percent(a, 3)}). Possible manipulation or a stale treasury quote.`),
  BelowFloor: (a, c) => blocked(`Price ${price(a, 0, c)} is below the ${price(a, 1, c)} floor.`),
  EpochCapReached: (a, c) => {
    const reset = c.epochResetsAt !== undefined && c.now !== undefined
      ? ` Resets in ${c.epochResetsAt > c.now ? c.epochResetsAt - c.now : 0n} seconds.` : "";
    return blocked(`The epoch sell limit would be exceeded (${token(a, 0, c)} / ${token(a, 2, c)} used). This trade asks for ${token(a, 1, c)}.${reset}`);
  },
  ReleaseExceeded: (a, c) => blocked(`Only ${token(a, 2, c)} has unlocked so far; ${token(a, 0, c)} is already net sold and this trade asks for ${token(a, 1, c)}.`),
  ZeroAddress: () => "The contract configuration contains a missing address.",
  ZeroAmount: () => "Enter a non-zero trade amount and use a valid reference price.",
  ZeroBalance: () => "The strategy needs inventory in both tokens before it can quote.",
  InsufficientLiquidity: () => "The requested output would exhaust this strategy's virtual inventory. Reduce the trade size.",
  InvalidSpread: () => "The spread must be less than 100% and stay within the issuer's bounds.",
  InvalidEpochLength: () => "The epoch length must be greater than zero.",
  InstructionArgsTooLong: () => "The strategy instruction is too large for this router version.",
  SafeCastOverflowedUintDowncast: () => "This value exceeds the contract's supported numeric range.",
  MakerTraitsMissingHasPostTransferInFlag: () => "The strategy's incoming-token hook configuration is inconsistent.",
  MakerTraitsMissingHasPostTransferOutFlag: () => "The strategy's outgoing-token hook configuration is inconsistent.",
  MakerTraitsMissingHasPreTransferInFlag: () => "The strategy's incoming-token hook configuration is inconsistent.",
  MakerTraitsMissingHasPreTransferOutFlag: () => "The strategy's outgoing-token hook configuration is inconsistent.",
  ZeroHook: () => "This pool needs an oracle hook before it can anchor a mandate.",
  PairNotInPool: () => "The selected pool does not contain the mandate's two tokens.",
  ZeroWindow: () => "Choose a TWAP window greater than zero.",
  PriceOutOfRange: () => blocked("The anchor price is too small to represent safely. Trading is unavailable."),
  ZeroDeviationLimit: () => "The live-price circuit breaker needs a non-zero tolerance.",
  SpotTwapDivergence: (a) => blocked(`The live Uniswap price is ${percent(a, 2)} away from its average (limit ${percent(a, 3)}). Possible manipulation.`),
  HookNotImplemented: () => "This operation is not supported by the pool's oracle hook.",
  NotPoolManager: () => "Only the configured Uniswap PoolManager can call this hook.",
  PoolNotInitialized: () => "Initialize the Uniswap pool before requesting its price.",
  TargetPredatesOldestObservation: () => blocked("The oracle does not yet have enough history for this TWAP window. Trading waits for sufficient observations."),
} satisfies Record<OwnErrorName, Renderer>;

const errorAbi: Abi = [mandateModuleAbi, mandateQuoterAbi, uniswapV4TwapAnchorAbi, mandateOracleHookAbi,
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
  SafeBalancesForTokenNotInActiveStrategy: "This strategy is docked or does not include the requested token. Refresh the mandate's status and active order.",
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
