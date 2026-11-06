import { getChainConfig } from "@mandate/chains";
import { aquaAbi, erc20Abi, mandateModuleAbi } from "@mandate/sdk";
import { useQuery } from "@tanstack/react-query";
import type { Address, Hash, PublicClient } from "viem";
import { usePublicClient } from "wagmi";

import { demoChain, deployment } from "@/wallet/config";

import type { Holdings } from "./terms";

/**
 * What the Safe can still back for a new strategy (or a reship of `except`): its balances minus the Aqua balances its
 * other live strategies hold, per token. Mirrors MandateModule._requireBacking, read from the chain so it is current.
 */
export function useBacking(safe: Address | null, base: Address | null, quote: Address | null, except?: Hash) {
  const publicClient = usePublicClient({ chainId: demoChain.id }) as PublicClient | undefined;
  return useQuery({
    queryKey: ["backing", demoChain.id, deployment.module, safe, base, quote, except ?? null],
    enabled: Boolean(publicClient && safe && base && quote),
    refetchInterval: 15_000,
    queryFn: async (): Promise<Holdings & { committedBase: bigint; committedQuote: bigint }> => {
      const client = publicClient!;
      const { aqua, swapVmRouter } = getChainConfig(deployment.sourceChainId).aqua;
      const live = await client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "liveStrategiesOf", args: [safe!] });
      const others = live.filter((id) => id.toLowerCase() !== except?.toLowerCase());
      const hashes = await Promise.all(
        others.map(async (id) => (await client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "getStrategy", args: [id] })).activeStrategyHash),
      );
      const committed = async (token: Address) => {
        const balances = await Promise.all(
          hashes.map((hash) => client.readContract({ address: aqua, abi: aquaAbi, functionName: "rawBalances", args: [safe!, swapVmRouter, hash, token] })),
        );
        return balances.reduce((sum, [balance]) => sum + BigInt(balance), 0n);
      };
      const [heldBase, heldQuote, committedBase, committedQuote] = await Promise.all([
        client.readContract({ address: base!, abi: erc20Abi, functionName: "balanceOf", args: [safe!] }),
        client.readContract({ address: quote!, abi: erc20Abi, functionName: "balanceOf", args: [safe!] }),
        committed(base!),
        committed(quote!),
      ]);
      const free = (held: bigint, used: bigint) => (held > used ? held - used : 0n);
      return { base: free(heldBase, committedBase), quote: free(heldQuote, committedQuote), committedBase, committedQuote };
    },
  });
}
