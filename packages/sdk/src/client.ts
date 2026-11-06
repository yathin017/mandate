import { getAddress, type Hash, type PublicClient, type Address } from "viem";
import { getChainConfig, type MandateDeployment } from "@mandate/chains";
import { mandateModuleAbi, mandateQuoterAbi, uniswapV4TwapAnchorAbi, swapVmAbi } from "./abis.ts";
import { encodeTakerData, hashAquaOrder } from "./transactions.ts";
import { explainError, type ErrorContext } from "./errors.ts";

/** No cache: callers choose block numbers and own invalidation policy (Segment 7). */
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
    async mandatesOf(safe: Address, blockNumber?: bigint) {
      const block = await blockAt(blockNumber);
      const ids = await client.readContract({ address: deployment.module, abi: mandateModuleAbi,
        functionName: "mandatesOf", args: [safe], blockNumber: block.blockNumber });
      await assertBlock(block);
      return { ids, source: { ...block, chainId: deployment.chainId, contract: deployment.module, method: "mandatesOf" } };
    },
    async readSnapshot(id: Hash, blockNumber?: bigint) {
      const block = await blockAt(blockNumber);
      const at = { blockNumber: block.blockNumber };
      const mandate = await client.readContract({ address: deployment.module, abi: mandateModuleAbi,
        functionName: "getMandate", args: [id], ...at });
      if (mandate.status === 0) throw new Error("Mandate not found on this deployment");
      const [epoch, released, remainingThisEpoch, sellableNow, epochResetsAt, feesAccrued, claimable, claimed, activeOrder] = await Promise.all([
        client.readContract({ address: deployment.quoter, abi: mandateQuoterAbi, functionName: "epochState", args: [id], ...at }),
        client.readContract({ address: deployment.quoter, abi: mandateQuoterAbi, functionName: "released", args: [id], ...at }),
        client.readContract({ address: deployment.quoter, abi: mandateQuoterAbi, functionName: "remainingThisEpoch", args: [id], ...at }),
        client.readContract({ address: deployment.quoter, abi: mandateQuoterAbi, functionName: "sellableNow", args: [id], ...at }),
        client.readContract({ address: deployment.quoter, abi: mandateQuoterAbi, functionName: "epochResetsAt", args: [id], ...at }),
        client.readContract({ address: deployment.quoter, abi: mandateQuoterAbi, functionName: "feesAccrued", args: [id], ...at }),
        client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "claimable", args: [id], ...at }),
        client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "claimed", args: [id], ...at }),
        client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "activeOrder", args: [id], ...at }),
      ]);
      // Reading the adapter's snapshot does not enforce its breaker. Its state can be displayed while fills halt.
      let anchor;
      try {
        const [prices, limit] = await Promise.all([
          client.readContract({ address: mandate.bounds.anchor, abi: uniswapV4TwapAnchorAbi,
            functionName: "snapshot", args: [mandate.bounds.twapWindow], ...at }),
          client.readContract({ address: mandate.bounds.anchor, abi: uniswapV4TwapAnchorAbi,
            functionName: "MAX_SPOT_DEVIATION_BPS", ...at }),
        ]);
        anchor = { status: prices[2] <= BigInt(limit) ? "within-spot-band" as const : "blocked" as const,
          spotPriceX36: prices[0], twapPriceX36: prices[1], deviationBps: prices[2], maxDeviationBps: limit };
      } catch (error) { anchor = { status: "unavailable" as const, error: explainError(error) }; }
      await assertBlock(block);
      return { mandate, epoch: { index: epoch[0], netSold: epoch[1], totalNetSold: epoch[2] },
        released, remainingThisEpoch, sellableNow, epochResetsAt, feesAccrued, claimable, claimed, activeOrder, anchor,
        source: { ...block, chainId: deployment.chainId, module: deployment.module, quoter: deployment.quoter,
          anchor: mandate.bounds.anchor } };
    },
    async quote(id: Hash, input: {
      taker: Address; tokenIn: Address; tokenOut: Address; amount: bigint; isExactIn: boolean;
      context?: ErrorContext; blockNumber?: bigint;
    }) {
      const block = await blockAt(input.blockNumber);
      const source = { ...block, chainId: deployment.chainId, contract: venue.swapVmRouter, method: "quote" };
      try {
        const order = await client.readContract({ address: deployment.module, abi: mandateModuleAbi,
          functionName: "activeOrder", args: [id], blockNumber: block.blockNumber });
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

export type MandateClient = Awaited<ReturnType<typeof createMandateClient>>;
export type MandateSnapshot = Awaited<ReturnType<MandateClient["readSnapshot"]>>;
