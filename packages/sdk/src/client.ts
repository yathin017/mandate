import { getAddress, type Hash, type PublicClient, type Address } from "viem";
import { getChainConfig, type MandateDeployment } from "@mandate/chains";
import { mandateModuleAbi, mandateQuoterAbi, swapVmAbi } from "./abis.ts";
import { encodeTakerData, hashAquaOrder, RISK_REASONS, type RiskReason } from "./transactions.ts";
import { explainError, type ErrorContext } from "./errors.ts";

/** No cache: callers choose block numbers and own invalidation policy. Every read is pinned to one block. */
export async function createMandateClient(client: PublicClient, deployment: MandateDeployment) {
  const venue = getChainConfig(deployment.sourceChainId).aqua;
  async function checkChain() {
    const actual = await client.getChainId();
    if (actual !== deployment.chainId) throw new Error(`RPC chain ${actual} does not match deployment chain ${deployment.chainId}`);
  }
  async function blockAt(blockNumber?: bigint) {
    await checkChain();
    const block = await client.getBlock(blockNumber === undefined ? { blockTag: "latest" } : { blockNumber });
    if (block.number === null || block.hash === null) throw new Error("A confirmed block is required");
    return { blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp };
  }
  async function assertBlock(source: { blockNumber: bigint; blockHash: Hash }) {
    const block = await client.getBlock({ blockNumber: source.blockNumber });
    if (block.hash !== source.blockHash) throw new Error("The source block changed during the read; retry against the new canonical block");
  }
  await checkChain();
  const code = await client.getCode({ address: deployment.module });
  if (!code || code === "0x") throw new Error("The module is not deployed at this address on the selected RPC");
  const [quoter, router, aqua] = await Promise.all([
    client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "QUOTER" }),
    client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "ROUTER" }),
    client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "AQUA" }),
  ]);
  if (getAddress(quoter) !== getAddress(deployment.quoter) || getAddress(router) !== getAddress(venue.swapVmRouter)
      || getAddress(aqua) !== getAddress(venue.aqua)) throw new Error("Deployment does not match the module's immutable venue and quoter");

  return {
    deployment,
    async policiesOf(safe: Address, blockNumber?: bigint) {
      const block = await blockAt(blockNumber);
      const ids = await client.readContract({ address: deployment.module, abi: mandateModuleAbi,
        functionName: "policiesOf", args: [safe], blockNumber: block.blockNumber });
      await assertBlock(block);
      return { ids, source: { ...block, chainId: deployment.chainId, contract: deployment.module, method: "policiesOf" } };
    },
    /** The Safe's live policy for `base`, or null. */
    async activePolicyOf(safe: Address, base: Address, blockNumber?: bigint) {
      const block = await blockAt(blockNumber);
      const id = await client.readContract({ address: deployment.module, abi: mandateModuleAbi,
        functionName: "activePolicyOf", args: [safe, base], blockNumber: block.blockNumber });
      await assertBlock(block);
      return { id: /^0x0{64}$/.test(id) ? null : id,
        source: { ...block, chainId: deployment.chainId, contract: deployment.module, method: "activePolicyOf" } };
    },
    /**
     * A policy at one block: its terms, shared counters, risk mode with the oracle readings behind it, and its
     * strategies' ids. The risk mode is what the quoter would apply to a fill in this block.
     */
    async readPolicy(policyId: Hash, blockNumber?: bigint) {
      const block = await blockAt(blockNumber);
      const at = { blockNumber: block.blockNumber };
      const policy = await client.readContract({ address: deployment.module, abi: mandateModuleAbi,
        functionName: "getPolicy", args: [policyId], ...at });
      if (policy.status === 0) throw new Error("Policy not found on this deployment");
      const [counters, risk, strategyIds] = await Promise.all([
        client.readContract({ address: deployment.quoter, abi: mandateQuoterAbi, functionName: "policyCounters", args: [policyId], ...at }),
        client.readContract({ address: deployment.quoter, abi: mandateQuoterAbi, functionName: "riskMode", args: [policyId], ...at }),
        client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "strategiesOf", args: [policyId], ...at }),
      ]);
      await assertBlock(block);
      const [mode, reason, health] = risk;
      return { policy, counters, risk: { mode, reason: riskReason(reason), health }, strategyIds,
        source: { ...block, chainId: deployment.chainId, module: deployment.module, quoter: deployment.quoter,
          oracle: policy.config.oracle.oracle } };
    },
    /** A strategy at one block: its terms, active order and fee accounting. Its policy is read with readPolicy. */
    async readStrategy(strategyId: Hash, blockNumber?: bigint) {
      const block = await blockAt(blockNumber);
      const at = { blockNumber: block.blockNumber };
      const strategy = await client.readContract({ address: deployment.module, abi: mandateModuleAbi,
        functionName: "getStrategy", args: [strategyId], ...at });
      if (strategy.status === 0) throw new Error("Strategy not found on this deployment");
      const [feesAccrued, claimable, claimed, activeOrder, nonce] = await Promise.all([
        client.readContract({ address: deployment.quoter, abi: mandateQuoterAbi, functionName: "feesAccrued", args: [strategyId], ...at }),
        client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "claimable", args: [strategyId], ...at }),
        client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "claimed", args: [strategyId], ...at }),
        client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "activeOrder", args: [strategyId], ...at }),
        client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "strategyNonce", args: [strategyId], ...at }),
      ]);
      await assertBlock(block);
      return { strategy, feesAccrued, claimable, claimed, activeOrder, nonce,
        source: { ...block, chainId: deployment.chainId, module: deployment.module, quoter: deployment.quoter } };
    },
    /** Quotes against a strategy's active order through the canonical router, exactly as a taker would. */
    async quote(strategyId: Hash, input: {
      taker: Address; tokenIn: Address; tokenOut: Address; amount: bigint; isExactIn: boolean;
      context?: ErrorContext; blockNumber?: bigint;
    }) {
      const block = await blockAt(input.blockNumber);
      const source = { ...block, chainId: deployment.chainId, contract: venue.swapVmRouter, method: "quote" };
      try {
        const order = await client.readContract({ address: deployment.module, abi: mandateModuleAbi,
          functionName: "activeOrder", args: [strategyId], blockNumber: block.blockNumber });
        const result = await client.readContract({ address: venue.swapVmRouter, abi: swapVmAbi,
          functionName: "quote", args: [order, input.tokenIn, input.tokenOut, input.amount, encodeTakerData(input)],
          account: input.taker, blockNumber: block.blockNumber });
        if (result[2] !== hashAquaOrder(order)) throw new Error("Router returned an unexpected order hash");
        await assertBlock(block);
        return { ok: true as const, amountIn: result[0], amountOut: result[1], orderHash: result[2], source };
      } catch (error) {
        await assertBlock(block);
        return { ok: false as const, error: explainError(error, input.context), source };
      }
    },
  };
}

/** Unknown reasons are reported as such rather than mapped to a neighbouring one. */
function riskReason(index: number): RiskReason | "Unknown" {
  return RISK_REASONS[index] ?? "Unknown";
}

export type MandateClient = Awaited<ReturnType<typeof createMandateClient>>;
export type PolicySnapshot = Awaited<ReturnType<MandateClient["readPolicy"]>>;
export type StrategySnapshot = Awaited<ReturnType<MandateClient["readStrategy"]>>;
