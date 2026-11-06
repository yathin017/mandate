import { encodeFunctionData, getAddress, isAddress, toHex, type Address, type Hash, type PublicClient } from "viem";

import { tokenFactoryAbi } from "./abis.ts";
import type { PreparedCall } from "./transactions.ts";

/**
 * Token launches through `TokenFactory`: a fixed-supply 18-decimal ERC-20 (with permit) whose whole supply goes to
 * one recipient, normally the issuer Safe. Validation mirrors the contract so forms can explain a refusal before
 * the wallet is opened.
 */
export const LAUNCH_DECIMALS = 18;
/** One quadrillion whole tokens, in base units (TokenFactory.MAX_SUPPLY). */
export const MAX_LAUNCH_SUPPLY = 10n ** 33n;

export interface TokenLaunch {
  readonly name: string;
  readonly symbol: string;
  /** Base units (18 decimals). */
  readonly supply: bigint;
  readonly recipient: Address;
  /** Creator-chosen; the factory mixes in the caller, so a prediction cannot be squatted. */
  readonly salt: Hash;
}

/** The first problem with a launch, as a sentence, or null when the factory would accept it. */
export function launchProblem(input: Omit<TokenLaunch, "salt">): string | null {
  const name = input.name;
  if (name.length === 0 || name.length > 64) return "Name: 1 to 64 characters";
  if (!/^[\x20-\x7e]+$/.test(name)) return "Name: plain letters, digits, spaces and punctuation only";
  if (name.startsWith(" ") || name.endsWith(" ")) return "Name: no leading or trailing spaces";
  if (!/^[A-Za-z0-9]{1,11}$/.test(input.symbol)) return "Symbol: 1 to 11 letters or digits";
  if (input.supply <= 0n || input.supply > MAX_LAUNCH_SUPPLY) return "Supply: more than 0 and at most 1,000,000,000,000,000 tokens";
  if (!isAddress(input.recipient) || BigInt(input.recipient) === 0n) return "Recipient: not a valid address";
  return null;
}

/** A fresh random salt (Web Crypto, available in browsers and Node). */
export function randomLaunchSalt(): Hash {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export function buildLaunchTokenCall(chainId: number, factory: Address, input: TokenLaunch): PreparedCall {
  const problem = launchProblem(input);
  if (problem) throw new Error(problem);
  return {
    chainId,
    to: factory,
    data: encodeFunctionData({
      abi: tokenFactoryAbi,
      functionName: "launch",
      args: [input.name, input.symbol, input.supply, getAddress(input.recipient), input.salt],
    }),
    value: 0n,
    operation: 0,
    role: "anyone",
  };
}

/** Where `creator`'s launch with these arguments will deploy the token. */
export async function predictLaunchedToken(client: PublicClient, factory: Address, creator: Address, input: TokenLaunch): Promise<Address> {
  return client.readContract({
    address: factory,
    abi: tokenFactoryAbi,
    functionName: "predict",
    args: [creator, input.name, input.symbol, input.supply, getAddress(input.recipient), input.salt],
  });
}

/** True when `token` was deployed by this factory (not a look-alike with the same name). */
export async function isFactoryToken(client: PublicClient, factory: Address, token: Address): Promise<boolean> {
  return client.readContract({ address: factory, abi: tokenFactoryAbi, functionName: "isLaunched", args: [token] });
}
