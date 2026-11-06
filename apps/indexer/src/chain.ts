import { getDeployment, type LocalForkDeployment } from "@mandate/chains";
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
  readonly deployment: LocalForkDeployment;
  readonly client: PublicClient;
  readonly sdk: MandateClient;
  /** First block to index (the block the deployment forked from / was deployed after). */
  readonly startBlock: { readonly number: bigint; readonly hash: Hash };
  /** Demo evidence: the ScenarioActor acting as the mandates' market maker, and its act -> mandate map. */
  readonly actor: Address;
  readonly actMandates: ReadonlyMap<bigint, Hash>;
  /** Actor targets that are not mandate actions (v4 market moves, token approvals). */
  readonly nonMandateTargets: ReadonlySet<string>;
  tokenDisplay(token: Address): Promise<TokenDisplay>;
}

export async function createChainContext(config: Config): Promise<ChainContext> {
  const deployment = getDeployment(config.INDEXER_CHAIN_ID);
  // cacheTime 0: viem otherwise caches the block number for 4s, and reorg checks must never use a stale head.
  const client = createPublicClient({
    transport: http(config.INDEXER_RPC_URL, { retryCount: 3 }),
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

  return {
    chainId: deployment.chainId,
    deployment,
    client,
    sdk,
    startBlock: { number: BigInt(deployment.forkBlock), hash: deployment.forkBlockHash },
    actor: getAddress(deployment.mm),
    actMandates: new Map([
      [1n, deployment.mandates.act1],
      [2n, deployment.mandates.act2],
      [3n, deployment.mandates.act3],
    ]),
    nonMandateTargets: new Set([deployment.swapRouter, deployment.base, deployment.quote].map((a) => a.toLowerCase())),
    tokenDisplay,
  };
}
