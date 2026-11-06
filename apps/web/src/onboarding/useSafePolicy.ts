import { mandateModuleAbi, type PolicyConfig, type StrategyBounds, type StrategyParams } from "@mandate/sdk";
import { useQuery } from "@tanstack/react-query";
import type { Address, Hash, PublicClient } from "viem";
import { usePublicClient } from "wagmi";

import { demoChain, deployment } from "@/wallet/config";

export interface SafeStrategy {
  readonly id: Hash;
  readonly mm: Address;
  /** 0 market making, 1 buyback. */
  readonly kind: number;
  /** 1 Active, 2 Paused, 3 Revoked. */
  readonly status: number;
  readonly bounds: StrategyBounds;
  readonly params: StrategyParams;
}

export interface SafePolicy {
  readonly id: Hash;
  readonly quote: Address;
  /** 1 Active, 2 Paused. */
  readonly status: number;
  readonly config: PolicyConfig;
  readonly strategies: readonly SafeStrategy[];
}

/**
 * The Safe's live treasury policy for `base` and its strategies, read from the chain (not the indexer) so the wizard
 * works on a chain without a running indexer and sees a new policy or strategy as soon as its transaction is mined.
 * Null when the Safe has no live policy for the token.
 */
export function useSafePolicy(safe: Address | null, base: Address | null) {
  const publicClient = usePublicClient({ chainId: demoChain.id }) as PublicClient | undefined;
  return useQuery({
    queryKey: ["safe-policy", demoChain.id, deployment.module, safe, base],
    enabled: Boolean(safe && base && publicClient),
    queryFn: async (): Promise<SafePolicy | null> => {
      const client = publicClient!;
      const id = await client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "activePolicyOf", args: [safe!, base!] });
      if (/^0x0{64}$/.test(id)) return null;
      const [policy, ids] = await Promise.all([
        client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "getPolicy", args: [id] }),
        client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "strategiesOf", args: [id] }),
      ]);
      const strategies = await Promise.all(
        ids.map((sid) => client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "getStrategy", args: [sid] })),
      );
      return {
        id,
        quote: policy.quote,
        status: Number(policy.status),
        config: policy.config,
        strategies: strategies.map((s, i) => ({ id: ids[i]!, mm: s.mm, kind: Number(s.kind), status: Number(s.status), bounds: s.bounds, params: s.params })),
      };
    },
  });
}
