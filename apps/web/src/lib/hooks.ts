import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { api } from "./api";

/** Query keys. Everything for one mandate shares the `["mandate", id]` prefix so one invalidation refreshes all. */
export const qk = {
  health: ["health"] as const,
  mandates: ["mandates"] as const,
  mandate: (id: string) => ["mandate", id, "detail"] as const,
  activity: (id: string) => ["mandate", id, "activity"] as const,
  series: (id: string) => ["mandate", id, "series"] as const,
  session: ["session"] as const,
  mmProfiles: ["mm-profiles"] as const,
  mmProfile: (address: string) => ["mm-profile", address.toLowerCase()] as const,
  mmScores: ["mm-scores"] as const,
  launchedTokens: ["launched-tokens"] as const,
};

export const useHealth = () => useQuery({ queryKey: qk.health, queryFn: api.health, refetchInterval: 15_000 });
export const useMandates = () => useQuery({ queryKey: qk.mandates, queryFn: api.mandates });
export const useMandate = (id: string) => useQuery({ queryKey: qk.mandate(id), queryFn: () => api.mandate(id) });
export const useSeries = (id: string) => useQuery({ queryKey: qk.series(id), queryFn: () => api.series(id) });
export const useMmProfiles = () => useQuery({ queryKey: qk.mmProfiles, queryFn: api.mmProfiles });
export const useMmScores = () => useQuery({ queryKey: qk.mmScores, queryFn: api.mmScores });
export const useLaunchedTokens = () => useQuery({ queryKey: qk.launchedTokens, queryFn: api.launchedTokens });

export const useActivity = (id: string) =>
  useInfiniteQuery({
    queryKey: qk.activity(id),
    queryFn: ({ pageParam }) => api.activity(id, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.data.next,
  });

export type StreamState = "connecting" | "live" | "offline";

/**
 * Subscribes to the indexer's SSE stream for one mandate and refetches its queries on every `change`.
 * The stream carries no data of its own; REST stays the single source of what is shown.
 */
export function useMandateStream(id: string): StreamState {
  const client = useQueryClient();
  const [state, setState] = useState<StreamState>("connecting");

  useEffect(() => {
    const source = new EventSource(api.streamUrl(id));
    source.addEventListener("ready", () => setState("live"));
    source.addEventListener("change", () => {
      void client.invalidateQueries({ queryKey: ["mandate", id] });
      void client.invalidateQueries({ queryKey: qk.health });
    });
    // EventSource reconnects by itself; show offline until it does.
    source.onerror = () => setState(source.readyState === EventSource.CLOSED ? "offline" : "connecting");
    return () => source.close();
  }, [client, id]);

  return state;
}
