import type {
  ActivityPage,
  Envelope,
  Health,
  MandateDetail,
  MandateListItem,
  SimulationResult,
  Snapshot,
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
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `request failed (${response.status})`;
    throw new ApiError(response.status, message);
  }
  return body as T;
}

const chainPath = `/v1/chains/${CHAIN_ID}`;

export const api = {
  health: () => request<Health>("/health"),
  mandates: () => request<Envelope<MandateListItem[]>>(`${chainPath}/mandates`),
  mandatesByMm: (mm: string) => request<Envelope<MandateListItem[]>>(`${chainPath}/mandates?mm=${encodeURIComponent(mm)}`),
  mandate: (id: string) => request<Envelope<MandateDetail>>(`${chainPath}/mandates/${id}`),
  activity: (id: string, before?: string | null, limit = 25) =>
    request<Envelope<ActivityPage>>(
      `${chainPath}/mandates/${id}/activity?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`,
    ),
  series: (id: string) => request<Envelope<Snapshot[]>>(`${chainPath}/mandates/${id}/series?limit=2000`),
  simulate: (
    id: string,
    body: { taker: string; tokenIn: string; tokenOut: string; amount: string; isExactIn: boolean },
  ) =>
    request<Envelope<SimulationResult>>(`${chainPath}/mandates/${id}/attempts`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  streamUrl: (id: string) => `${API_BASE}${chainPath}/mandates/${id}/stream`,
};
