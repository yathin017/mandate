import { getAddress, isHex, type Address, type Hash } from "viem";
import { chainData, deploymentData } from "./generated.ts";

export interface ChainConfig {
  readonly chainId: number;
  readonly name: string;
  readonly rpcEnv: string;
  readonly forkBlock: number;
  readonly explorer: string;
  readonly aqua: { readonly aqua: Address; readonly swapVmRouter: Address };
  /** PositionManager and Permit2 are the canonical periphery the Safe uses to add pool liquidity. */
  readonly uniswapV4: { readonly poolManager: Address; readonly stateView: Address; readonly positionManager: Address; readonly permit2: Address };
  /** MultiSendCallOnly is the only contract a Safe transaction built by this app may delegatecall (batches). */
  readonly safe: { readonly singletonL2: Address; readonly proxyFactory: Address; readonly multiSendCallOnly: Address };
  readonly tokens: { readonly weth: Address; readonly usdc: Address };
}

/** Contract context shared by readers/builders. This type does not imply that a deployment is registered. */
export interface MandateDeployment {
  readonly chainId: number;
  readonly sourceChainId: number;
  readonly module: Address;
  readonly quoter: Address;
  readonly anchor: Address;
}

export interface LocalForkDeployment extends MandateDeployment {
  readonly environment: "local-mainnet-fork";
  readonly chainId: 31337;
  readonly sourceChainId: number;
  readonly forkBlock: number;
  readonly forkBlockHash: Hash;
  readonly module: Address;
  readonly quoter: Address;
  readonly anchor: Address;
  readonly hook: Address;
  readonly base: Address;
  readonly quote: Address;
  readonly deployer: Address;
  readonly safe1: Address;
  readonly safe2: Address;
  readonly safe3: Address;
  readonly traditionalSafe: Address;
  readonly traditionalMm: Address;
  readonly traditionalAnchor: Address;
  readonly mm: Address;
  readonly taker: Address;
  readonly stateReader: Address;
  readonly swapRouter: Address;
  readonly liquidityRouter: Address;
  readonly mandates: Readonly<Record<"act1" | "act2" | "act3", Hash>>;
  readonly syntheticTokens: true;
  readonly syntheticOracleHistory: true;
  readonly lastBlock: number;
  readonly replay: string;
}

/**
 * A deployment on a real chain (e.g. Base mainnet). Tokens are still mocks (`syntheticTokens`), but blocks,
 * history and transaction hashes are real and have explorer links.
 */
export interface LiveDeployment extends MandateDeployment {
  readonly environment: "live";
  readonly chainId: number;
  /** Equal to chainId: a live deployment is its own source chain. */
  readonly sourceChainId: number;
  /** Block before the first deployment transaction; indexing starts here. */
  readonly deployBlock: number;
  readonly module: Address;
  readonly quoter: Address;
  readonly anchor: Address;
  readonly hook: Address;
  readonly base: Address;
  readonly quote: Address;
  readonly deployer: Address;
  readonly owner2: Address;
  readonly mm: Address;
  readonly safe: Address;
  readonly swapRouter: Address;
  readonly liquidityRouter: Address;
  readonly mandate: Hash;
  /** AnchorLauncher for self-serve anchors, when deployed on this chain. */
  readonly anchorLauncher?: Address;
  /** TokenFactory for self-serve token launches, once deployed on this chain. */
  readonly tokenFactory?: Address;
  readonly syntheticTokens: true;
}

export type Deployment = LocalForkDeployment | LiveDeployment;

export const isLiveDeployment = (deployment: Deployment): deployment is LiveDeployment =>
  deployment.environment === "live";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a config object");
  return value as Record<string, unknown>;
}
function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${field}`);
  return value;
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid ${field}`);
  return value;
}
function address(value: unknown, field: string): Address {
  const result = getAddress(text(value, field));
  if (/^0x0{40}$/i.test(result)) throw new Error(`Zero address: ${field}`);
  return result;
}
function hash(value: unknown, field: string): Hash {
  const result = text(value, field);
  if (!isHex(result) || result.length !== 66) throw new Error(`Invalid ${field}`);
  return result;
}
function addresses<T extends readonly string[]>(value: unknown, fields: T): { [K in T[number]]: Address } {
  const source = object(value);
  return Object.fromEntries(fields.map((field) => [field, address(source[field], field)])) as { [K in T[number]]: Address };
}

export function parseChainConfig(value: unknown): ChainConfig {
  const c = object(value);
  const explorer = new URL(text(c.explorer, "explorer"));
  if (explorer.protocol !== "https:" || explorer.username || explorer.password || explorer.search || explorer.hash) {
    throw new Error("Explorer must be a public HTTPS base URL");
  }
  const rpcEnv = text(c.rpcEnv, "rpcEnv");
  if (!/^[A-Z][A-Z0-9_]*$/.test(rpcEnv)) throw new Error("rpcEnv must name an environment variable, not contain an RPC URL");
  return Object.freeze({
    chainId: integer(c.chainId, "chainId"), name: text(c.name, "name"), rpcEnv,
    forkBlock: integer(c.forkBlock, "forkBlock"), explorer: explorer.href.replace(/\/$/, ""),
    aqua: Object.freeze(addresses(c.aqua, ["aqua", "swapVmRouter"] as const)),
    uniswapV4: Object.freeze(addresses(c.uniswapV4, ["poolManager", "stateView", "positionManager", "permit2"] as const)),
    safe: Object.freeze(addresses(c.safe, ["singletonL2", "proxyFactory", "multiSendCallOnly"] as const)),
    tokens: Object.freeze(addresses(c.tokens, ["weth", "usdc"] as const)),
  });
}

export function parseLocalForkDeployment(value: unknown): LocalForkDeployment {
  const d = object(value);
  if (d.environment !== "local-mainnet-fork" || d.chainId !== 31337 || d.sourceChainId === d.chainId) {
    throw new Error("Expected a local mainnet fork with runtime chain id 31337 and a separate source chain");
  }
  if (d.syntheticTokens !== true || d.syntheticOracleHistory !== true) throw new Error("Fork demo must retain synthetic labels");
  const sourceChainId = integer(d.sourceChainId, "sourceChainId");
  if (sourceChainId !== 1) throw new Error("Only the mainnet fork is currently supported");
  const mandates = object(d.mandates);
  return Object.freeze({
    environment: "local-mainnet-fork", chainId: 31337, sourceChainId,
    forkBlock: integer(d.forkBlock, "forkBlock"), forkBlockHash: hash(d.forkBlockHash, "forkBlockHash"),
    ...addresses(d, ["module", "quoter", "anchor", "hook", "base", "quote", "deployer", "safe1", "safe2", "safe3",
      "traditionalSafe", "traditionalMm", "traditionalAnchor", "mm", "taker", "stateReader", "swapRouter", "liquidityRouter"] as const),
    mandates: Object.freeze({ act1: hash(mandates.act1, "act1"), act2: hash(mandates.act2, "act2"), act3: hash(mandates.act3, "act3") }),
    syntheticTokens: true, syntheticOracleHistory: true, lastBlock: integer(d.lastBlock, "lastBlock"), replay: text(d.replay, "replay"),
  });
}

export function parseLiveDeployment(value: unknown): LiveDeployment {
  const d = object(value);
  if (d.environment !== "live") throw new Error("Expected a live deployment");
  const chainId = integer(d.chainId, "chainId");
  if (d.sourceChainId !== chainId) throw new Error("A live deployment's source chain must be its own chain");
  if (chainId === 31337) throw new Error("Chain 31337 is reserved for the local fork");
  if (d.syntheticTokens !== true) throw new Error("Live demo must disclose its mock tokens");
  return Object.freeze({
    environment: "live", chainId, sourceChainId: chainId, deployBlock: integer(d.deployBlock, "deployBlock"),
    ...addresses(d, ["module", "quoter", "anchor", "hook", "base", "quote", "deployer", "owner2", "mm", "safe",
      "swapRouter", "liquidityRouter"] as const),
    mandate: hash(d.mandate, "mandate"),
    ...(d.anchorLauncher === undefined ? {} : { anchorLauncher: address(d.anchorLauncher, "anchorLauncher") }),
    ...(d.tokenFactory === undefined ? {} : { tokenFactory: address(d.tokenFactory, "tokenFactory") }),
    syntheticTokens: true,
  });
}

/** Dispatches on `environment`; unknown environments are rejected. */
export function parseDeployment(value: unknown): Deployment {
  const environment = object(value).environment;
  if (environment === "local-mainnet-fork") return parseLocalForkDeployment(value);
  if (environment === "live") return parseLiveDeployment(value);
  throw new Error(`Unknown deployment environment: ${String(environment)}`);
}

export const chains: readonly ChainConfig[] = Object.freeze(chainData.map(parseChainConfig));
export const deployments: readonly Deployment[] = Object.freeze(deploymentData.map(parseDeployment));
for (const deployment of deployments) {
  if (isLiveDeployment(deployment) && !chains.some((chain) => chain.chainId === deployment.chainId)) {
    throw new Error(`Live deployment on chain ${deployment.chainId} has no chain config`);
  }
}

export function getChainConfig(chainId: number): ChainConfig {
  const config = chains.find((chain) => chain.chainId === chainId);
  if (!config) throw new Error(`Unsupported source chain: ${chainId}`);
  return config;
}

/** Lookup uses the runtime chain id. A file named deployments/1.json does not register a mainnet deployment. */
export function getDeployment(chainId: number): Deployment {
  const deployment = deployments.find((item) => item.chainId === chainId);
  if (!deployment) throw new Error(`No Mandate deployment registered for runtime chain ${chainId}`);
  return deployment;
}

export function getLocalForkDeployment(sourceChainId = 1): LocalForkDeployment {
  const deployment = deployments.find(
    (item): item is LocalForkDeployment => item.environment === "local-mainnet-fork" && item.sourceChainId === sourceChainId,
  );
  if (!deployment) throw new Error(`No local fork deployment for source chain ${sourceChainId}`);
  return deployment;
}

/** Explorer link for an address on a real chain; none on a local fork. */
export function getAddressUrl(chainId: number, address: Address): string | undefined {
  if (deployments.some((item) => item.chainId === chainId && item.environment === "local-mainnet-fork")) return undefined;
  const config = chains.find((item) => item.chainId === chainId);
  return config ? `${config.explorer}/address/${getAddress(address)}` : undefined;
}

/** Explorer link for real chains; none for local-fork hashes (callers show their saved receipt instead). */
export function getTransactionUrl(chainId: number, transactionHash: Hash): string | undefined {
  hash(transactionHash, "transactionHash");
  if (deployments.some((item) => item.chainId === chainId && item.environment === "local-mainnet-fork")) return undefined;
  const config = chains.find((item) => item.chainId === chainId);
  return config ? `${config.explorer}/tx/${transactionHash}` : undefined;
}
