import { mandateModuleAbi } from "@mandate/sdk";
import { useQuery } from "@tanstack/react-query";
import type { Address, Hash, PublicClient } from "viem";
import { usePublicClient } from "wagmi";

import { demoChain, deployment } from "@/wallet/config";

export interface SafeMandate {
  readonly id: Hash;
  readonly mm: Address;
  readonly base: Address;
  readonly quote: Address;
  /** MandateStatus: 1 Active, 2 Paused, 3 Revoked. */
  readonly status: number;
}

/**
 * Mandates the module records for a Safe, read from the chain (not the indexer) so the wizard works on a chain
 * without a running indexer and sees a new mandate as soon as its transaction is mined.
 */
export function useSafeMandates(safe: Address | null) {
  const publicClient = usePublicClient({ chainId: demoChain.id }) as PublicClient | undefined;
  return useQuery({
    queryKey: ["safe-mandates", demoChain.id, deployment.module, safe],
    enabled: Boolean(safe && publicClient),
    queryFn: async (): Promise<SafeMandate[]> => {
      const ids = await publicClient!.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "mandatesOf", args: [safe!] });
      const mandates = await Promise.all(
        ids.map((id) => publicClient!.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "getMandate", args: [id] })),
      );
      return mandates.map((m, i) => ({ id: ids[i]!, mm: m.mm, base: m.base, quote: m.quote, status: Number(m.status) }));
    },
  });
}
