import { getAddress, hashTypedData, isAddress, type Address, type Hash, type TypedDataDefinition } from "viem";

import type { MandateDeployment } from "@mandate/chains";

import { STRATEGY_KIND, type StrategyBounds, type StrategyParams } from "./transactions.ts";

/**
 * Proposals: the exact strategy an issuer offers a market maker, the EIP-712 message the market maker signs to
 * accept it, and a JSON form for storage and transport. The same terms feed `buildAddStrategyCall`, so what the
 * market maker accepted is byte-for-byte what the owners execute.
 *
 * The treasury policy (caps, price and oracle rules, risk modes) is the issuer's own and is not part of the signed
 * terms: it applies to every strategy of the Safe and the issuer may tighten it at any time. Proposals show the
 * policy as context; the market maker accepts the strategy.
 */

/** Everything `addStrategy` takes except the policy id, which the Safe's live policy for `base` supplies. */
export interface StrategyTerms {
  readonly marketMaker: Address;
  readonly base: Address;
  readonly quote: Address;
  /** STRATEGY_KIND: 0 market making, 1 buyback. */
  readonly kind: number;
  readonly bounds: StrategyBounds;
  readonly params: StrategyParams;
}

/** JSON form: addresses lowercase, every integer a decimal string. Field order is fixed. */
export interface StrategyTermsJson {
  marketMaker: string;
  base: string;
  quote: string;
  kind: string;
  bounds: {
    spreadBpsMin: string; spreadBpsMax: string; maxShippedBase: string; maxShippedQuote: string;
    mmFeeShareBps: string; maxBuyPriceX36: string;
  };
  params: { spreadBps: string; shippedBase: string; shippedQuote: string };
}

const lower = (a: Address) => a.toLowerCase();

export function termsToJson(t: StrategyTerms): StrategyTermsJson {
  const b = t.bounds;
  const p = t.params;
  return {
    marketMaker: lower(t.marketMaker),
    base: lower(t.base),
    quote: lower(t.quote),
    kind: t.kind.toString(),
    bounds: {
      spreadBpsMin: b.spreadBpsMin.toString(), spreadBpsMax: b.spreadBpsMax.toString(),
      maxShippedBase: b.maxShippedBase.toString(), maxShippedQuote: b.maxShippedQuote.toString(),
      mmFeeShareBps: b.mmFeeShareBps.toString(), maxBuyPriceX36: b.maxBuyPriceX36.toString(),
    },
    params: { spreadBps: p.spreadBps.toString(), shippedBase: p.shippedBase.toString(), shippedQuote: p.shippedQuote.toString() },
  };
}

/** Parses and range-checks stored or received terms. Throws on anything that would not fit the contract types. */
export function termsFromJson(j: StrategyTermsJson): StrategyTerms {
  const address = (v: string, name: string): Address => {
    if (!isAddress(v, { strict: false })) throw new Error(`${name}: not an address`);
    return getAddress(v);
  };
  const uint = (v: string, bits: number, name: string): bigint => {
    if (typeof v !== "string" || !/^\d{1,78}$/.test(v)) throw new Error(`${name}: not an unsigned integer`);
    const n = BigInt(v);
    if (n >= 1n << BigInt(bits)) throw new Error(`${name}: exceeds uint${bits}`);
    return n;
  };
  const small = (v: string, bits: number, name: string) => Number(uint(v, bits, name));
  const kind = small(j.kind, 8, "kind");
  if (kind !== STRATEGY_KIND.marketMaking && kind !== STRATEGY_KIND.buyback) throw new Error("kind: unknown strategy kind");
  const b = j.bounds;
  const p = j.params;
  return {
    marketMaker: address(j.marketMaker, "marketMaker"),
    base: address(j.base, "base"),
    quote: address(j.quote, "quote"),
    kind,
    bounds: {
      spreadBpsMin: small(b.spreadBpsMin, 16, "spreadBpsMin"),
      spreadBpsMax: small(b.spreadBpsMax, 16, "spreadBpsMax"),
      maxShippedBase: uint(b.maxShippedBase, 256, "maxShippedBase"),
      maxShippedQuote: uint(b.maxShippedQuote, 256, "maxShippedQuote"),
      mmFeeShareBps: small(b.mmFeeShareBps, 16, "mmFeeShareBps"),
      maxBuyPriceX36: uint(b.maxBuyPriceX36, 256, "maxBuyPriceX36"),
    },
    params: {
      spreadBps: small(p.spreadBps, 16, "spreadBps"),
      shippedBase: uint(p.shippedBase, 256, "shippedBase"),
      shippedQuote: uint(p.shippedQuote, 256, "shippedQuote"),
    },
  };
}

export const STRATEGY_TERMS_TYPES = {
  StrategyTerms: [
    { name: "proposal", type: "string" },
    { name: "safe", type: "address" },
    { name: "marketMaker", type: "address" },
    { name: "base", type: "address" },
    { name: "quote", type: "address" },
    { name: "kind", type: "uint8" },
    { name: "bounds", type: "Bounds" },
    { name: "params", type: "Params" },
    { name: "expiresAt", type: "uint64" },
  ],
  Bounds: [
    { name: "spreadBpsMin", type: "uint16" },
    { name: "spreadBpsMax", type: "uint16" },
    { name: "maxShippedBase", type: "uint256" },
    { name: "maxShippedQuote", type: "uint256" },
    { name: "mmFeeShareBps", type: "uint16" },
    { name: "maxBuyPriceX36", type: "uint256" },
  ],
  Params: [
    { name: "spreadBps", type: "uint16" },
    { name: "shippedBase", type: "uint256" },
    { name: "shippedQuote", type: "uint256" },
  ],
} as const;

export interface ProposalSigningInput {
  /** The proposal's id as the API issued it. */
  readonly proposalId: string;
  readonly safe: Address;
  readonly terms: StrategyTerms;
  /** Unix seconds after which the acceptance is void. */
  readonly expiresAt: bigint;
}

/**
 * The message a market maker signs to accept a proposal. The domain binds it to one chain and one Mandate module
 * (version "2": v1 mandate acceptances cannot be replayed as strategy acceptances).
 */
export function strategyTermsTypedData(
  deployment: Pick<MandateDeployment, "chainId" | "module">,
  input: ProposalSigningInput,
): TypedDataDefinition<typeof STRATEGY_TERMS_TYPES, "StrategyTerms"> {
  const { terms } = input;
  return {
    domain: { name: "Mandate", version: "2", chainId: deployment.chainId, verifyingContract: deployment.module },
    types: STRATEGY_TERMS_TYPES,
    primaryType: "StrategyTerms",
    message: {
      proposal: input.proposalId,
      safe: input.safe,
      marketMaker: terms.marketMaker,
      base: terms.base,
      quote: terms.quote,
      kind: terms.kind,
      bounds: terms.bounds,
      params: terms.params,
      expiresAt: input.expiresAt,
    },
  };
}

/** EIP-712 digest of the acceptance message; stored with the proposal as its terms hash. */
export function hashStrategyTerms(deployment: Pick<MandateDeployment, "chainId" | "module">, input: ProposalSigningInput): Hash {
  return hashTypedData(strategyTermsTypedData(deployment, input));
}
