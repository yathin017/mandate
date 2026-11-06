import { concatHex, encodeAbiParameters, encodeFunctionData, getAbiItem, keccak256, toHex,
  type Address, type ContractFunctionReturnType, type Hash, type Hex } from "viem";
import { getChainConfig, type MandateDeployment } from "@mandate/chains";
import { erc20Abi, mandateModuleAbi, swapVmAbi } from "./abis.ts";

export type Policy = ContractFunctionReturnType<typeof mandateModuleAbi, "view", "getPolicy">;
export type PolicyConfig = Policy["config"];
export type Strategy = ContractFunctionReturnType<typeof mandateModuleAbi, "view", "getStrategy">;
export type StrategyBounds = Strategy["bounds"];
export type StrategyParams = Strategy["params"];
export type SwapOrder = ContractFunctionReturnType<typeof mandateModuleAbi, "view", "activeOrder">;

/** Onchain enums (MandateTypes.sol), in declaration order. */
export const STATUS = { none: 0, active: 1, paused: 2, revoked: 3 } as const;
export const STRATEGY_KIND = { marketMaking: 0, buyback: 1 } as const;
export const RISK_MODE = { normal: 0, defensive: 1, paused: 2 } as const;
export const RISK_REASONS = ["None", "Unpriced", "PoolTooYoung", "DepthBelowMinimum", "MoveBeyondPause",
  "VolatilityBeyondPause", "MoveDefensive", "VolatilityDefensive", "DepthDefensive"] as const;
export type RiskReason = (typeof RISK_REASONS)[number];

export interface PreparedCall {
  readonly chainId: number;
  readonly to: Address;
  readonly data: Hex;
  readonly value: 0n;
  /**
   * Safe operation: 0 = CALL. 1 = DELEGATECALL, produced only for issuer-Safe batches through the chain's canonical
   * MultiSendCallOnly (see liquidity.ts); wallet flows must refuse any other delegatecall target.
   */
  readonly operation: 0 | 1;
  /** Who must send it: the issuer Safe (via owners), the MM, either, a taker, anyone, or a mock token's owner. */
  readonly role: "issuer-safe" | "market-maker" | "either" | "taker" | "anyone" | "token-owner";
}

function call(deployment: MandateDeployment, data: Hex, role: PreparedCall["role"], to = deployment.module): PreparedCall {
  return { chainId: deployment.chainId, to, data, value: 0n, operation: 0, role };
}

// ---------------------------------------------------------------- issuer (executed by the Safe)

/** Issuer payloads must be executed by the Safe. These builders never sign or submit transactions. */
export function buildCreatePolicyCall(deployment: MandateDeployment, input: {
  base: Address; quote: Address; config: PolicyConfig;
}): PreparedCall {
  return call(deployment, encodeFunctionData({ abi: mandateModuleAbi, functionName: "createPolicy",
    args: [input.base, input.quote, input.config] }), "issuer-safe");
}
export function buildUpdatePolicyCall(deployment: MandateDeployment, policyId: Hash, config: PolicyConfig): PreparedCall {
  return call(deployment, encodeFunctionData({ abi: mandateModuleAbi, functionName: "updatePolicy",
    args: [policyId, config] }), "issuer-safe");
}
export function buildPausePolicyCall(deployment: MandateDeployment, policyId: Hash): PreparedCall {
  return call(deployment, encodeFunctionData({ abi: mandateModuleAbi, functionName: "pausePolicy", args: [policyId] }), "issuer-safe");
}
export function buildUnpausePolicyCall(deployment: MandateDeployment, policyId: Hash): PreparedCall {
  return call(deployment, encodeFunctionData({ abi: mandateModuleAbi, functionName: "unpausePolicy", args: [policyId] }), "issuer-safe");
}
/** Ends the policy and revokes every strategy under it. */
export function buildRevokePolicyCall(deployment: MandateDeployment, policyId: Hash): PreparedCall {
  return call(deployment, encodeFunctionData({ abi: mandateModuleAbi, functionName: "revokePolicy", args: [policyId] }), "issuer-safe");
}
export function buildAddStrategyCall(deployment: MandateDeployment, input: {
  policyId: Hash; marketMaker: Address; kind: number; bounds: StrategyBounds; params: StrategyParams;
}): PreparedCall {
  return call(deployment, encodeFunctionData({ abi: mandateModuleAbi, functionName: "addStrategy",
    args: [input.policyId, input.marketMaker, input.kind, input.bounds, input.params] }), "issuer-safe");
}
export function buildUpdateStrategyBoundsCall(deployment: MandateDeployment, strategyId: Hash, bounds: StrategyBounds): PreparedCall {
  return call(deployment, encodeFunctionData({ abi: mandateModuleAbi, functionName: "updateStrategyBounds",
    args: [strategyId, bounds] }), "issuer-safe");
}
export function buildUnpauseStrategyCall(deployment: MandateDeployment, strategyId: Hash): PreparedCall {
  return call(deployment, encodeFunctionData({ abi: mandateModuleAbi, functionName: "unpauseStrategy", args: [strategyId] }), "issuer-safe");
}
export function buildRevokeStrategyCall(deployment: MandateDeployment, strategyId: Hash): PreparedCall {
  return call(deployment, encodeFunctionData({ abi: mandateModuleAbi, functionName: "revokeStrategy", args: [strategyId] }), "issuer-safe");
}

// ---------------------------------------------------------------- market maker / either

export function buildReshipCall(deployment: MandateDeployment, strategyId: Hash, params: StrategyParams): PreparedCall {
  return call(deployment, encodeFunctionData({ abi: mandateModuleAbi, functionName: "reship", args: [strategyId, params] }), "market-maker");
}
export function buildClaimFeesCall(deployment: MandateDeployment, strategyId: Hash): PreparedCall {
  return call(deployment, encodeFunctionData({ abi: mandateModuleAbi, functionName: "claimFees", args: [strategyId] }), "market-maker");
}
/** The issuer Safe or the strategy's market maker may pause; only the issuer resumes. */
export function buildPauseStrategyCall(deployment: MandateDeployment, strategyId: Hash): PreparedCall {
  return call(deployment, encodeFunctionData({ abi: mandateModuleAbi, functionName: "pauseStrategy", args: [strategyId] }), "either");
}

function uint(value: bigint, bits: number, name: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value >= 1n << BigInt(bits)) throw new Error(`${name} must fit uint${bits}`);
  return value;
}

/** Router 1.0.2 TakerTraitsLib.build: ten uint16 slice indexes, flags, threshold and deadline.
 *  EOA settlement uses transferFrom + Aqua.push, with no callbacks, hooks or order signature.
 */
export function encodeTakerData(input: { isExactIn: boolean; threshold?: bigint; deadline?: bigint }): Hex {
  const thresholdLength = input.threshold === undefined ? 0n : 32n;
  const deadlineLength = input.deadline === undefined ? 0n : 5n;
  let indexes = 0n;
  for (let i = 0; i < 10; ++i) indexes |= (thresholdLength + (i >= 2 ? deadlineLength : 0n)) << BigInt(i * 16);
  return concatHex([
    toHex(indexes, { size: 20 }), toHex(0x60 | (input.isExactIn ? 1 : 0), { size: 2 }),
    input.threshold === undefined ? "0x" : toHex(uint(input.threshold, 256, "threshold"), { size: 32 }),
    input.deadline === undefined ? "0x" : toHex(uint(input.deadline, 40, "deadline"), { size: 5 }),
  ]);
}

/** Aqua order hashes are keccak256(abi.encode(order)), without an EIP-712 domain. */
export function hashAquaOrder(order: SwapOrder): Hash {
  const item = getAbiItem({ abi: swapVmAbi, name: "hash" });
  return keccak256(encodeAbiParameters(item.inputs, [order]));
}

/** Slippage threshold and expiry are required for a submit-ready swap payload. */
export function buildSwapCall(deployment: MandateDeployment, input: {
  order: SwapOrder; tokenIn: Address; tokenOut: Address; amount: bigint;
  isExactIn: boolean; threshold: bigint; deadline: bigint;
}): PreparedCall {
  if (input.amount <= 0n || input.threshold <= 0n || input.deadline <= 0n) throw new Error("Swap amount, slippage threshold and deadline must be positive");
  const router = getChainConfig(deployment.sourceChainId).aqua.swapVmRouter;
  return call(deployment, encodeFunctionData({ abi: swapVmAbi, functionName: "swap",
    args: [input.order, input.tokenIn, input.tokenOut, input.amount, encodeTakerData(input)] }), "taker", router);
}

/** EOA takers approve the router for this settlement mode; the issuer Safe approves Aqua through the module. */
export function buildApproveRouterCall(deployment: MandateDeployment, token: Address, amount: bigint): PreparedCall {
  const router = getChainConfig(deployment.sourceChainId).aqua.swapVmRouter;
  return call(deployment, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [router, amount] }), "taker", token);
}
