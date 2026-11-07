import { getAddressUrl, getDeployment, getTransactionUrl, isLiveDeployment } from "@mandate/chains";
import { defineChain, isAddress, type Address, type Hash } from "viem";
import { base } from "viem/chains";
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

export const isLive = isLiveDeployment(deployment);

export const RPC_URL = import.meta.env.VITE_RPC_URL ?? (isLive ? "https://mainnet.base.org" : "http://127.0.0.1:8547");

export const demoChain = isLive
  ? { ...base, rpcUrls: { default: { http: [RPC_URL] } } }
  : defineChain({
      id: CHAIN_ID,
      name: "Mandate local fork",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [RPC_URL] } },
      testnet: true,
    });


/**
 * AnchorLauncher for self-serve anchors: the manifest's address on live chains. The local fork's recorded
 * deployment has none, so a dev-only VITE_ANCHOR_LAUNCHER is accepted there (never on a live chain).
 */
export const ANCHOR_LAUNCHER: Address | undefined = isLiveDeployment(deployment)
  ? deployment.anchorLauncher
  : devAddress("VITE_ANCHOR_LAUNCHER", import.meta.env.VITE_ANCHOR_LAUNCHER);

/** TokenFactory for self-serve launches; same rule as the launcher (manifest on live chains, VITE_ on the fork). */
export const TOKEN_FACTORY: Address | undefined = isLiveDeployment(deployment)
  ? deployment.tokenFactory
  : devAddress("VITE_TOKEN_FACTORY", import.meta.env.VITE_TOKEN_FACTORY);

function devAddress(name: string, value: string | undefined): Address | undefined {
  if (!value) return undefined;
  if (!isAddress(value)) throw new Error(`${name} is not an address: ${value}`);
  return value;
}

/** Explorer link for live chains; undefined on the local fork. */
export const txUrl = (hash: string): string | undefined => getTransactionUrl(CHAIN_ID, hash as Hash);
/** Explorer link for an address on live chains; undefined on the local fork. */
export const addressUrl = (address: string): string | undefined => getAddressUrl(CHAIN_ID, address as Address);

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

/**
 * Testing wallets per role. Local fork: Anvil's public development accounts. Live (Base): the testing wallets
 * recorded in deployments/8453.json (addresses only; keys never reach the app).
 */
export const DEMO_ACCOUNTS: { safeOwner1: Address; safeOwner2: Address; marketMaker: Address } = isLiveDeployment(deployment)
  ? { safeOwner1: deployment.deployer, safeOwner2: deployment.owner2, marketMaker: deployment.mm }
  : {
      safeOwner1: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      safeOwner2: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      marketMaker: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    };

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

const envAddresses = (value: string | undefined): Address[] =>
  (value ?? "").split(",").map((v) => v.trim()).filter((v): v is Address => isAddress(v));

/**
 * Wallets a presenter uses for a live demo, from apps/web/.env.local (addresses only):
 * VITE_DEMO_SAFE_OWNERS="0xOwner1,0xOwner2" and VITE_DEMO_MARKET_MAKER="0xMM". Without them, the deployment's
 * testing wallets. They only prefill forms when the connected wallet is one of them (see `demoCoOwner`).
 */
export const DEMO_SAFE_OWNERS: readonly Address[] = (() => {
  const fromEnv = envAddresses(import.meta.env.VITE_DEMO_SAFE_OWNERS);
  return fromEnv.length >= 2 ? fromEnv : [DEMO_ACCOUNTS.safeOwner1, DEMO_ACCOUNTS.safeOwner2];
})();
export const DEMO_MARKET_MAKER: Address = envAddresses(import.meta.env.VITE_DEMO_MARKET_MAKER)[0] ?? DEMO_ACCOUNTS.marketMaker;

/**
 * The other demo owners when `connected` is itself a demo owner, else none: a co-owner is never suggested to anyone
 * else, so a real issuer cannot end up with a stranger on their Safe.
 */
export function demoCoOwners(connected: string | undefined): Address[] {
  if (!connected || !DEMO_SAFE_OWNERS.some((o) => o.toLowerCase() === connected.toLowerCase())) return [];
  return DEMO_SAFE_OWNERS.filter((o) => o.toLowerCase() !== connected.toLowerCase());
}

/** Role name for a known testing wallet, e.g. to label the connected account. */
// Presenter wallets first, so the deployment's own role names win where they are the same wallets.
const ROLE_LABELS = new Map<string, string>([
  ...DEMO_SAFE_OWNERS.map((o, i) => [o.toLowerCase(), `Demo Owner ${i + 1}`] as [string, string]),
  [DEMO_MARKET_MAKER.toLowerCase(), "Demo Market Maker"],
  [DEMO_ACCOUNTS.safeOwner1.toLowerCase(), "Safe Owner 1"],
  [DEMO_ACCOUNTS.safeOwner2.toLowerCase(), "Safe Owner 2"],
  [DEMO_ACCOUNTS.marketMaker.toLowerCase(), "Market Maker"],
]);
export const roleOf = (address: string | undefined): string | undefined =>
  address ? ROLE_LABELS.get(address.toLowerCase()) : undefined;

/** Issuer Safes offered in the console. */
export const DEMO_SAFES: readonly { address: Address; label: string }[] = isLiveDeployment(deployment)
  ? [{ address: deployment.safe, label: `Live demo Safe (${demoChain.name})` }]
  : [
      { address: deployment.safe1, label: "Demo Safe 1 (Act 1)" },
      { address: deployment.safe2, label: "Demo Safe 2 (Act 2)" },
      { address: deployment.safe3, label: "Demo Safe 3 (Act 3)" },
    ];

/** How to get the right wallet accounts for this deployment. */
export const ACCOUNT_HELP = isLive
  ? `Connect Safe Owner 1 (${short(DEMO_ACCOUNTS.safeOwner1)}) or Safe Owner 2 (${short(DEMO_ACCOUNTS.safeOwner2)}) on ${demoChain.name}. One owner approves; the other executes.`
  : `Import Anvil accounts #0 and #1 into your wallet (public development keys only), add network ${RPC_URL} (chain ${CHAIN_ID}), then connect. One owner approves; the other executes.`;
