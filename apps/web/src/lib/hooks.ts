import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { api, type Subject } from "./api";

/**
 * Query keys. Everything about one policy or strategy shares its `[kind, id]` prefix, so one invalidation (from the
 * live stream) refreshes all of it. A strategy's page also reads its policy, so policy changes refresh it too.
 */
export const qk = {
  health: ["health"] as const,
  policies: ["policies"] as const,
  strategies: (filter: object = {}) => ["strategies", "list", filter] as const,
  policy: (id: string) => ["policy", id, "detail"] as const,
  strategy: (id: string) => ["strategy", id, "detail"] as const,
  activity: (subject: Subject) => [subject.kind, subject.id, "activity"] as const,
  policySeries: (id: string) => ["policy", id, "series"] as const,
  strategySeries: (id: string) => ["strategy", id, "series"] as const,
  session: ["session"] as const,
  mmProfiles: ["mm-profiles"] as const,
  mmProfile: (address: string) => ["mm-profile", address.toLowerCase()] as const,
  mmScores: ["mm-scores"] as const,
  launchedTokens: ["launched-tokens"] as const,
};

export const useHealth = () => useQuery({ queryKey: qk.health, queryFn: api.health, refetchInterval: 15_000 });
export const usePolicies = () => useQuery({ queryKey: qk.policies, queryFn: () => api.policies() });
export const useStrategies = (filter: { safe?: string; mm?: string; policy?: string } = {}) =>
  useQuery({ queryKey: qk.strategies(filter), queryFn: () => api.strategies(filter) });
export const usePolicy = (id: string | undefined) =>
  useQuery({ queryKey: qk.policy(id ?? ""), queryFn: () => api.policy(id!), enabled: Boolean(id) });
export const useStrategy = (id: string) => useQuery({ queryKey: qk.strategy(id), queryFn: () => api.strategy(id) });
export const usePolicySeries = (id: string | undefined) =>
  useQuery({ queryKey: qk.policySeries(id ?? ""), queryFn: () => api.policySeries(id!), enabled: Boolean(id) });
export const useStrategySeries = (id: string) => useQuery({ queryKey: qk.strategySeries(id), queryFn: () => api.strategySeries(id) });
export const useMmProfiles = () => useQuery({ queryKey: qk.mmProfiles, queryFn: api.mmProfiles });
export const useMmScores = () => useQuery({ queryKey: qk.mmScores, queryFn: api.mmScores });
export const useLaunchedTokens = () => useQuery({ queryKey: qk.launchedTokens, queryFn: api.launchedTokens });

export const useActivity = (subject: Subject) =>
  useInfiniteQuery({
    queryKey: qk.activity(subject),
    queryFn: ({ pageParam }) => api.activity(subject, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.data.next,
  });

export type StreamState = "connecting" | "live" | "offline";

/**
 * Subscribes to the indexer's SSE stream for one policy or strategy and refetches its queries on every `change`.
 * The stream carries no data of its own; REST stays the single source of what is shown.
 */
export function useLiveStream(subject: Subject | undefined): StreamState {
  const client = useQueryClient();
  const [state, setState] = useState<StreamState>("connecting");
  const kind = subject?.kind;
  const id = subject?.id;

  useEffect(() => {
    if (!kind || !id) return;
    const source = new EventSource(api.streamUrl({ kind, id }));
    source.addEventListener("ready", () => setState("live"));
    source.addEventListener("change", () => {
      void client.invalidateQueries({ queryKey: [kind, id] });
      void client.invalidateQueries({ queryKey: qk.health });
    });
    // EventSource reconnects by itself; show offline until it does.
    source.onerror = () => setState(source.readyState === EventSource.CLOSED ? "offline" : "connecting");
    return () => source.close();
  }, [client, kind, id]);

  return state;
}
