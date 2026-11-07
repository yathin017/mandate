import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createSiweMessage } from "viem/siwe";
import { useConnection, useSignMessage } from "wagmi";

import { api, ApiError } from "@/lib/api";
import { qk } from "@/lib/hooks";
import type { Session } from "@/lib/types";

/**
 * Wallet sign-in (EIP-4361) for the platform's off-chain features: market-maker profiles and proposals.
 * Connecting a wallet is enough to read and to send transactions; signing in proves the address to the API.
 * The session lives in an HttpOnly cookie, so the app only ever learns *whether* it is signed in, and as whom.
 */
export function useSession() {
  const { address } = useConnection();
  const query = useQuery({
    queryKey: qk.session,
    queryFn: async (): Promise<Session | null> => {
      try {
        return (await api.session()).data;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 60_000,
  });
  const session = query.data ?? null;
  // A session for another wallet does not count: the connected wallet is the one acting.
  const signedIn = Boolean(session && address && session.address.toLowerCase() === address.toLowerCase());
  return { session, signedIn, isLoading: query.isLoading, error: query.error };
}

export function useSignIn() {
  const { address } = useConnection();
  const { signMessageAsync } = useSignMessage();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!address) throw new Error("Connect a wallet first");
      const { nonce, chainId, statement } = await api.nonce();
      // Domain and URI name this site, so the API refuses the signature anywhere else.
      const message = createSiweMessage({
        address,
        chainId,
        domain: window.location.host,
        uri: window.location.origin,
        nonce,
        statement,
        version: "1",
        issuedAt: new Date(),
      });
      const signature = await signMessageAsync({ message });
      return (await api.verify(message, signature)).data;
    },
    onSuccess: (session) => client.setQueryData(qk.session, session),
  });
}

export function useSignOut() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.logout(),
    onSettled: () => client.setQueryData(qk.session, null),
  });
}
