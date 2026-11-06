import { getDeployment } from "@mandate/chains";
import { defineChain } from "viem";
import { createConfig, http, injected } from "wagmi";

import { CHAIN_ID } from "@/lib/api";

/**
 * Wallet configuration. Dashboards read only the indexer API; this chain client is used exclusively inside
 * wallet flows (Safe nonce/owners/approvals, pre-send simulation, receipts).
 *
 * Contract addresses come from the build-time registry (`@mandate/chains`), never from API responses, so the
 * indexer can never redirect what a user signs.
 */
export const deployment = getDeployment(CHAIN_ID);

export const RPC_URL = import.meta.env.VITE_RPC_URL ?? "http://127.0.0.1:8547";

export const demoChain = defineChain({
  id: CHAIN_ID,
  name: "Mandate local fork",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  testnet: true,
});

export const wagmiConfig = createConfig({
  chains: [demoChain],
  connectors: [injected()],
  transports: { [demoChain.id]: http(RPC_URL) },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

/** Public Anvil development accounts used by the demo (never real keys). */
export const DEMO_ACCOUNTS = {
  safeOwner1: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  safeOwner2: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  marketMaker: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
} as const;
