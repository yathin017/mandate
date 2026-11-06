import { concatHex, encodeAbiParameters, encodeFunctionData, getAbiItem, keccak256, toHex,
  type Address, type ContractFunctionReturnType, type Hash, type Hex } from "viem";
import { getChainConfig, type MandateDeployment } from "@mandate/chains";
import { erc20Abi, mandateModuleAbi, swapVmAbi } from "./abis.ts";

export type Mandate = ContractFunctionReturnType<typeof mandateModuleAbi, "view", "getMandate">;
export type MandateBounds = Mandate["bounds"];
export type MandateParams = Mandate["params"];
export type IssuerBounds = Omit<MandateBounds, "quoter">;
export type SwapOrder = ContractFunctionReturnType<typeof mandateModuleAbi, "view", "activeOrder">;
export interface PreparedCall {
  readonly chainId: number;
  readonly to: Address;
  readonly data: Hex;
  readonly value: 0n;
  readonly operation: 0;
  readonly role: "issuer-safe" | "market-maker" | "either" | "taker";
}

function call(deployment: MandateDeployment, data: Hex, role: PreparedCall["role"], to = deployment.module): PreparedCall {
  return { chainId: deployment.chainId, to, data, value: 0n, operation: 0, role };
}

/** Issuer payloads must be executed by the Safe. These builders never sign or submit transactions. */
export function buildCreateMandateCall(deployment: MandateDeployment, input: {
  marketMaker: Address; base: Address; quote: Address; bounds: IssuerBounds; params: MandateParams;
}): PreparedCall {
  return call(deployment, encodeFunctionData({ abi: mandateModuleAbi, functionName: "createMandate",
    args: [input.marketMaker, input.base, input.quote, { ...input.bounds, quoter: deployment.quoter }, input.params] }), "issuer-safe");
}
export function buildUpdateBoundsCall(deployment: MandateDeployment, id: Hash, bounds: IssuerBounds): PreparedCall {
  return call(deployment, encodeFunctionData({ abi: mandateModuleAbi, functionName: "updateBounds",
    args: [id, { ...bounds, quoter: deployment.quoter }] }), "issuer-safe");
}
export function buildReshipCall(deployment: MandateDeployment, id: Hash, params: MandateParams): PreparedCall {
  return call(deployment, encodeFunctionData({ abi: mandateModuleAbi, functionName: "reship", args: [id, params] }), "market-maker");
}
export function buildPauseCall(deployment: MandateDeployment, id: Hash): PreparedCall {
  return call(deployment, encodeFunctionData({ abi: mandateModuleAbi, functionName: "pause", args: [id] }), "either");
}
export function buildUnpauseCall(deployment: MandateDeployment, id: Hash): PreparedCall {
  return call(deployment, encodeFunctionData({ abi: mandateModuleAbi, functionName: "unpause", args: [id] }), "issuer-safe");
}
export function buildRevokeCall(deployment: MandateDeployment, id: Hash): PreparedCall {
  return call(deployment, encodeFunctionData({ abi: mandateModuleAbi, functionName: "revoke", args: [id] }), "issuer-safe");
}
export function buildClaimFeesCall(deployment: MandateDeployment, id: Hash): PreparedCall {
  return call(deployment, encodeFunctionData({ abi: mandateModuleAbi, functionName: "claimFees", args: [id] }), "market-maker");
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
