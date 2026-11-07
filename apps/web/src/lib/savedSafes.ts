import { getAddress, isAddress, type Address } from "viem";

import { CHAIN_ID } from "./api";

/**
 * Safes this browser created or was told about, per chain, so the issuer directory can list a Safe before it holds a
 * token or a policy (the only ways the indexer learns about it). A per-viewer convenience: storage may be missing or
 * blocked, and every read and write tolerates that.
 */
const KEY = `mandate:saved-safes:${CHAIN_ID}`;

export function savedSafes(): Address[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string" && isAddress(v)).map((v) => getAddress(v)) : [];
  } catch {
    return [];
  }
}

export function saveSafe(safe: string): void {
  if (!isAddress(safe)) return;
  try {
    const next = [...new Set([getAddress(safe), ...savedSafes()])].slice(0, 50);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: the Safe is still found once it holds a token or a policy.
  }
}
