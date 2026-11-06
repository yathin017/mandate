import type { StrategyTermsJson } from "@mandate/sdk";

import type {
  ActivityPage,
  AuthNonce,
  LaunchedToken,
  MmProfile,
  MmScore,
  PolicyDetail,
  PolicyListItem,
  PolicySnapshot,
  PolicySummary,
  Proposal,
  Session,
  Envelope,
  Health,
  SimulationResult,
  StrategyDetail,
  StrategyListItem,
  StrategySnapshot,
  StrategySummary,
} from "./types";

/** The indexer API is the app's only data source. Dev: /api proxy (vite.config.ts). Prod: VITE_API_URL. */
export const API_BASE = (import.meta.env.VITE_API_URL ?? "/api").replace(/\/$/, "");

/** Runtime chain the app shows: 31337 = local fork of Ethereum mainnet (default), 8453 = live Base deployment. */
export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 31337);

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}) },
    // The session cookie is HttpOnly and SameSite=Strict; the API must be on the same site as the app.
    credentials: "include",
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const fields = body && typeof body === "object" ? (body as { error?: unknown; reason?: unknown }) : {};
    const error = typeof fields.error === "string" ? fields.error : `request failed (${response.status})`;
    // Module refusals come back with the contract's plain-language reason.
    const message = typeof fields.reason === "string" ? `${error}: ${fields.reason}` : error;
    throw new ApiError(response.status, message);
  }
  return body as T;
}

const chainPath = `/v1/chains/${CHAIN_ID}`;

/** A change feed's subject: a treasury policy or one of its strategies. */
export interface Subject {
  readonly kind: "policy" | "strategy";
  readonly id: string;
}
const PATH = { policy: "policies", strategy: "strategies" } as const;

export const api = {
  health: () => request<Health>("/health"),
  policies: (safe?: string) => request<Envelope<PolicyListItem[]>>(`${chainPath}/policies${safe ? `?safe=${safe}` : ""}`),
  policy: (id: string) => request<Envelope<PolicyDetail>>(`${chainPath}/policies/${id}`),
  strategies: (filter: { safe?: string; mm?: string; policy?: string } = {}) => {
    const query = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]).toString();
    return request<Envelope<StrategyListItem[]>>(`${chainPath}/strategies${query ? `?${query}` : ""}`);
  },
  strategy: (id: string) => request<Envelope<StrategyDetail>>(`${chainPath}/strategies/${id}`),
  activity: (subject: Subject, before?: string | null, limit = 25) =>
    request<Envelope<ActivityPage>>(
      `${chainPath}/${PATH[subject.kind]}/${subject.id}/activity?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`,
    ),
  policySeries: (id: string) => request<Envelope<PolicySnapshot[]>>(`${chainPath}/policies/${id}/series?limit=2000`),
  strategySeries: (id: string) => request<Envelope<StrategySnapshot[]>>(`${chainPath}/strategies/${id}/series?limit=2000`),
  simulate: (
    strategyId: string,
    body: { taker: string; tokenIn: string; tokenOut: string; amount: string; isExactIn: boolean },
  ) =>
    request<Envelope<SimulationResult>>(`${chainPath}/strategies/${strategyId}/attempts`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  // Sign-in (EIP-4361) and the session cookie.
  nonce: () => request<AuthNonce>("/v1/auth/nonce"),
  verify: (message: string, signature: string) =>
    request<{ data: Session }>("/v1/auth/verify", { method: "POST", body: JSON.stringify({ message, signature }) }),
  session: () => request<{ data: Session }>("/v1/auth/session"),
  logout: () => fetch(`${API_BASE}/v1/auth/logout`, { method: "POST", credentials: "include" }),
  // Marketplace.
  mmProfiles: () => request<{ data: MmProfile[] }>("/v1/mms"),
  mmProfile: (address: string) => request<{ data: MmProfile }>(`/v1/mms/${address}`),
  mmScores: () => request<Envelope<{ weights: Record<string, number>; scores: MmScore[] }>>(`${chainPath}/mms/scores`),
  mmSummary: (address: string) => request<Envelope<StrategySummary[]>>(`${chainPath}/mms/${address}/summary`),
  saveProfile: (profile: Omit<MmProfile, "address" | "updatedAt">) =>
    request<{ data: MmProfile }>("/v1/mms/me", { method: "PUT", body: JSON.stringify(profile) }),
  safeSummary: (safe: string) => request<Envelope<PolicySummary[]>>(`${chainPath}/safes/${safe}/summary`),
  // Proposals: owners of the issuer Safe draft and send; the named market maker accepts with a signature.
  proposalsForSafe: (safe: string) => request<{ data: Proposal[] }>(`/v1/proposals?safe=${safe}`),
  proposalsForMe: () => request<{ data: Proposal[] }>("/v1/proposals?as=mm"),
  createProposal: (body: { safe: string; terms: StrategyTermsJson; expiresAt: number; note: string; send: boolean }) =>
    request<{ data: Proposal }>("/v1/proposals", { method: "POST", body: JSON.stringify({ chainId: CHAIN_ID, ...body }) }),
  proposalAction: (id: string, action: "send" | "withdraw" | "decline") =>
    request<{ data: Proposal }>(`/v1/proposals/${id}/${action}`, { method: "POST" }),
  acceptProposal: (id: string, signature: string) =>
    request<{ data: Proposal }>(`/v1/proposals/${id}/accept`, { method: "POST", body: JSON.stringify({ signature }) }),
  markExecuted: (id: string, strategyId: string) =>
    request<{ data: Proposal }>(`/v1/proposals/${id}/executed`, { method: "POST", body: JSON.stringify({ strategyId }) }),
  launchedTokens: () => request<Envelope<LaunchedToken[]>>(`${chainPath}/tokens/launched`),
  streamUrl: (subject: Subject) => `${API_BASE}${chainPath}/${PATH[subject.kind]}/${subject.id}/stream`,
};
