import { safeAbi } from "@mandate/sdk";
import { isAddress, type Address } from "viem";
import { useReadContracts } from "wagmi";

import { demoChain, deployment } from "@/wallet/config";

export interface SafeCheck {
  /** null while loading or when no valid address was given. */
  readonly isSafe: boolean | null;
  readonly owners: readonly Address[];
  readonly threshold: number;
  readonly version: string | null;
  readonly moduleEnabled: boolean;
  readonly refetch: () => void;
}

/**
 * Reads what makes an address usable as an issuer Safe: owners, threshold, Safe version and whether the Mandate
 * module is enabled. Anything that does not answer like a Safe is reported as not a Safe.
 */
export function useSafeCheck(address: string | null): SafeCheck {
  const safe = address && isAddress(address) ? (address as Address) : undefined;
  const reads = useReadContracts({
    contracts: safe
      ? [
          { address: safe, abi: safeAbi, functionName: "getOwners", chainId: demoChain.id },
          { address: safe, abi: safeAbi, functionName: "getThreshold", chainId: demoChain.id },
          { address: safe, abi: safeAbi, functionName: "VERSION", chainId: demoChain.id },
          { address: safe, abi: safeAbi, functionName: "isModuleEnabled", args: [deployment.module], chainId: demoChain.id },
        ]
      : [],
    query: { enabled: Boolean(safe) },
  });
  const [owners, threshold, version, moduleEnabled] = reads.data ?? [];
  const isSafe =
    !safe || reads.isLoading ? null : owners?.status === "success" && threshold?.status === "success" && version?.status === "success";
  return {
    isSafe,
    owners: owners?.status === "success" ? (owners.result as readonly Address[]) : [],
    threshold: threshold?.status === "success" ? Number(threshold.result) : 0,
    version: version?.status === "success" ? String(version.result) : null,
    moduleEnabled: moduleEnabled?.status === "success" && moduleEnabled.result === true,
    refetch: () => void reads.refetch(),
  };
}
