import { getDeployment, isLiveDeployment, type Deployment } from "@mandate/chains";
import { createMandateClient, erc20MetadataAbi, type ErrorContext, type MandateClient } from "@mandate/sdk";
import { createPublicClient, getAddress, http, type Address, type Hash, type PublicClient } from "viem";

import type { Config } from "./config.ts";

type TokenDisplay = NonNullable<ErrorContext["base"]>;

/**
 * Everything chain-specific the indexer needs, resolved from the shared registry (`@mandate/chains`).
 * Adding a chain means registering its deployment there; nothing here is chain-specific.
 */
export interface ChainContext {
  readonly chainId: number;
  readonly deployment: Deployment;
  readonly client: PublicClient;
  readonly sdk: MandateClient;
  /**
   * First block to index: the fork block (hash pinned by the manifest) or, on a live chain, the block before
   * deployment (hash read from the chain at startup).
   */
  readonly startBlock: { readonly number: bigint; readonly hash?: Hash };
  /**
   * Local-fork demo evidence only: the ScenarioActor acting as the strategies' MM and its act -> strategy map.
   * Live deployments have wallet MMs, so blocked attempts come only from server simulations.
   */
  readonly actor?: Address;
  /** TokenFactory whose launches are indexed, if any. */
  readonly tokenFactory?: Address;
  readonly actStrategies: ReadonlyMap<bigint, Hash>;
  /** Actor targets that are not strategy actions (v4 market moves, token approvals). */
  readonly nonStrategyTargets: ReadonlySet<string>;
  tokenDisplay(token: Address): Promise<TokenDisplay>;
}

export async function createChainContext(config: Config): Promise<ChainContext> {
  const deployment = getDeployment(config.INDEXER_CHAIN_ID);
  // cacheTime 0: viem otherwise caches the block number for 4s, and reorg checks must never use a stale head.
  const client = createPublicClient({
    // Back off on rate limits (public RPCs return 429 on bursts): ~1s, 2s, 4s, 8s, 16s.
    transport: http(config.INDEXER_RPC_URL, { retryCount: 5, retryDelay: 1000 }),
    cacheTime: 0,
  }) as PublicClient;
  const sdk = await createMandateClient(client, deployment);

  const displays = new Map<string, Promise<TokenDisplay>>();
  const tokenDisplay = (token: Address) => {
    const key = token.toLowerCase();
    let display = displays.get(key);
    if (!display) {
      display = Promise.all([
        client.readContract({ address: token, abi: erc20MetadataAbi, functionName: "decimals" }),
        client.readContract({ address: token, abi: erc20MetadataAbi, functionName: "symbol" }),
      // Symbols are arbitrary token-controlled text: keep them short and printable.
      ]).then(([decimals, symbol]) => ({
        decimals: Number(decimals),
        symbol: symbol.replace(/[^\x20-\x7e]/g, "").slice(0, 32) || "TOKEN",
      }));
      displays.set(key, display);
    }
    return display;
  };

  if (isLiveDeployment(deployment)) {
    return {
      chainId: deployment.chainId,
      deployment,
      client,
      sdk,
      startBlock: { number: BigInt(deployment.deployBlock) },
      ...(deployment.tokenFactory ? { tokenFactory: deployment.tokenFactory } : {}),
      actStrategies: new Map(),
      nonStrategyTargets: new Set(),
      tokenDisplay,
    };
  }
  return {
    chainId: deployment.chainId,
    deployment,
    client,
    sdk,
    startBlock: { number: BigInt(deployment.forkBlock), hash: deployment.forkBlockHash },
    actor: getAddress(deployment.mm),
    ...(config.INDEXER_TOKEN_FACTORY ? { tokenFactory: getAddress(config.INDEXER_TOKEN_FACTORY) } : {}),
    actStrategies: new Map([
      [1n, deployment.strategies.act1],
      [2n, deployment.strategies.act2],
      [3n, deployment.strategies.act3],
    ]),
    nonStrategyTargets: new Set([deployment.swapRouter, deployment.base, deployment.quote].map((a) => a.toLowerCase())),
    tokenDisplay,
  };
}
