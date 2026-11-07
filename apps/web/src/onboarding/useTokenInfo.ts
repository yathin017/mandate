import { erc20Abi, labelToken, readTokenInfo, type TokenInfo, type TokenLabel } from "@mandate/sdk";
import { useQuery } from "@tanstack/react-query";
import { isAddress, type Address, type PublicClient } from "viem";
import { usePublicClient, useReadContract } from "wagmi";

import { demoChain } from "@/wallet/config";

import { CONFIG_CHAIN_ID } from "./SafeStep";

export interface TokenCheck {
  readonly info: TokenInfo | undefined;
  readonly label: TokenLabel | null;
  /** Balance held by `holder`, when one is given and the token is valid. */
  readonly balance: bigint | undefined;
  readonly isLoading: boolean;
}

/** ERC20 metadata, canonical/look-alike label and the Safe's balance, read from the chain. */
export function useTokenInfo(token: string | null, holder: string | null): TokenCheck {
  const publicClient = usePublicClient({ chainId: demoChain.id }) as PublicClient | undefined;
  const address = token && isAddress(token) ? (token as Address) : undefined;
  const info = useQuery({
    queryKey: ["token-info", demoChain.id, address],
    queryFn: () => readTokenInfo(publicClient!, address!),
    enabled: Boolean(address && publicClient),
    staleTime: 60_000,
  });
  const ok = info.data?.ok === true;
  const balance = useReadContract({
    address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: holder && isAddress(holder) ? [holder as Address] : undefined,
    chainId: demoChain.id,
    query: { enabled: ok && Boolean(holder && isAddress(holder)) },
  });
  return {
    info: info.data,
    label: info.data?.ok ? labelToken(CONFIG_CHAIN_ID, info.data.address, info.data.symbol) : null,
    balance: balance.data as bigint | undefined,
    isLoading: info.isLoading,
  };
}
