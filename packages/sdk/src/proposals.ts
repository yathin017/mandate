import { getAddress, hashTypedData, isAddress, type Address, type Hash, type TypedDataDefinition } from "viem";

import type { MandateDeployment } from "@mandate/chains";

import type { IssuerBounds, MandateParams } from "./transactions.ts";

/**
 * Mandate proposals: the exact terms an issuer offers a market maker, the EIP-712 message the market maker signs to
 * accept them, and a JSON form for storage and transport. The same terms feed `buildCreateMandateCall`, so what
 * the market maker accepted is byte-for-byte what the owners execute.
 */

/** Everything `createMandate` takes except the quoter (fixed by the module). */
export interface MandateTerms {
  readonly marketMaker: Address;
  readonly base: Address;
  readonly quote: Address;
  readonly bounds: IssuerBounds;
  readonly params: MandateParams;
}

/** JSON form: addresses lowercase, every integer a decimal string. Field order is fixed. */
export interface MandateTermsJson {
  marketMaker: string;
  base: string;
  quote: string;
  bounds: {
    allotment: string; releaseStart: string; releaseDuration: string; epochLength: string; maxEpochCap: string;
    maxShippedQuote: string; floorPriceX36: string; maxAnchorDeviationBps: string; twapWindow: string;
    spreadBpsMin: string; spreadBpsMax: string; mmFeeShareBps: string; anchor: string;
  };
  params: { spreadBps: string; epochCap: string; shippedBase: string; shippedQuote: string };
}

const lower = (a: Address) => a.toLowerCase();

export function termsToJson(t: MandateTerms): MandateTermsJson {
  const b = t.bounds;
  const p = t.params;
  return {
    marketMaker: lower(t.marketMaker),
    base: lower(t.base),
    quote: lower(t.quote),
    bounds: {
      allotment: b.allotment.toString(), releaseStart: b.releaseStart.toString(), releaseDuration: b.releaseDuration.toString(),
      epochLength: b.epochLength.toString(), maxEpochCap: b.maxEpochCap.toString(), maxShippedQuote: b.maxShippedQuote.toString(),
      floorPriceX36: b.floorPriceX36.toString(), maxAnchorDeviationBps: b.maxAnchorDeviationBps.toString(),
      twapWindow: b.twapWindow.toString(), spreadBpsMin: b.spreadBpsMin.toString(), spreadBpsMax: b.spreadBpsMax.toString(),
      mmFeeShareBps: b.mmFeeShareBps.toString(), anchor: lower(b.anchor),
    },
    params: { spreadBps: p.spreadBps.toString(), epochCap: p.epochCap.toString(), shippedBase: p.shippedBase.toString(), shippedQuote: p.shippedQuote.toString() },
  };
}

/** Parses and range-checks stored or received terms. Throws on anything that would not fit the contract types. */
export function termsFromJson(j: MandateTermsJson): MandateTerms {
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
  const b = j.bounds;
  const p = j.params;
  return {
    marketMaker: address(j.marketMaker, "marketMaker"),
    base: address(j.base, "base"),
    quote: address(j.quote, "quote"),
    bounds: {
      allotment: uint(b.allotment, 256, "allotment"),
      releaseStart: uint(b.releaseStart, 64, "releaseStart"),
      releaseDuration: uint(b.releaseDuration, 64, "releaseDuration"),
      epochLength: uint(b.epochLength, 64, "epochLength"),
      maxEpochCap: uint(b.maxEpochCap, 256, "maxEpochCap"),
      maxShippedQuote: uint(b.maxShippedQuote, 256, "maxShippedQuote"),
      floorPriceX36: uint(b.floorPriceX36, 256, "floorPriceX36"),
      maxAnchorDeviationBps: small(b.maxAnchorDeviationBps, 16, "maxAnchorDeviationBps"),
      twapWindow: small(b.twapWindow, 32, "twapWindow"),
      spreadBpsMin: small(b.spreadBpsMin, 16, "spreadBpsMin"),
      spreadBpsMax: small(b.spreadBpsMax, 16, "spreadBpsMax"),
      mmFeeShareBps: small(b.mmFeeShareBps, 16, "mmFeeShareBps"),
      anchor: address(b.anchor, "anchor"),
    },
    params: {
      spreadBps: small(p.spreadBps, 16, "spreadBps"),
      epochCap: uint(p.epochCap, 256, "epochCap"),
      shippedBase: uint(p.shippedBase, 256, "shippedBase"),
      shippedQuote: uint(p.shippedQuote, 256, "shippedQuote"),
    },
  };
}

export const MANDATE_TERMS_TYPES = {
  MandateTerms: [
    { name: "proposal", type: "string" },
    { name: "safe", type: "address" },
    { name: "marketMaker", type: "address" },
    { name: "base", type: "address" },
    { name: "quote", type: "address" },
    { name: "bounds", type: "Bounds" },
    { name: "params", type: "Params" },
    { name: "expiresAt", type: "uint64" },
  ],
  Bounds: [
    { name: "allotment", type: "uint256" },
    { name: "releaseStart", type: "uint64" },
    { name: "releaseDuration", type: "uint64" },
    { name: "epochLength", type: "uint64" },
    { name: "maxEpochCap", type: "uint256" },
    { name: "maxShippedQuote", type: "uint256" },
    { name: "floorPriceX36", type: "uint256" },
    { name: "maxAnchorDeviationBps", type: "uint16" },
    { name: "twapWindow", type: "uint32" },
    { name: "spreadBpsMin", type: "uint16" },
    { name: "spreadBpsMax", type: "uint16" },
    { name: "mmFeeShareBps", type: "uint16" },
    { name: "anchor", type: "address" },
  ],
  Params: [
    { name: "spreadBps", type: "uint16" },
    { name: "epochCap", type: "uint256" },
    { name: "shippedBase", type: "uint256" },
    { name: "shippedQuote", type: "uint256" },
  ],
} as const;

export interface ProposalSigningInput {
  /** The proposal's id as the API issued it. */
  readonly proposalId: string;
  readonly safe: Address;
  readonly terms: MandateTerms;
  /** Unix seconds after which the acceptance is void. */
  readonly expiresAt: bigint;
}

/**
 * The message a market maker signs to accept a proposal. The domain binds it to one chain and one Mandate module,
 * so an acceptance cannot be replayed on another deployment.
 */
export function mandateTermsTypedData(
  deployment: Pick<MandateDeployment, "chainId" | "module">,
  input: ProposalSigningInput,
): TypedDataDefinition<typeof MANDATE_TERMS_TYPES, "MandateTerms"> {
  const { terms } = input;
  return {
    domain: { name: "Mandate", version: "1", chainId: deployment.chainId, verifyingContract: deployment.module },
    types: MANDATE_TERMS_TYPES,
    primaryType: "MandateTerms",
    message: {
      proposal: input.proposalId,
      safe: input.safe,
      marketMaker: terms.marketMaker,
      base: terms.base,
      quote: terms.quote,
      bounds: terms.bounds,
      params: terms.params,
      expiresAt: input.expiresAt,
    },
  };
}

/** EIP-712 digest of the acceptance message; stored with the proposal as its terms hash. */
export function hashMandateTerms(deployment: Pick<MandateDeployment, "chainId" | "module">, input: ProposalSigningInput): Hash {
  return hashTypedData(mandateTermsTypedData(deployment, input));
}
