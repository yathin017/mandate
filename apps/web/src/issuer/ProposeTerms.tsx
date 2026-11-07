import { termsToJson } from "@mandate/sdk";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { isAddress, type Address } from "viem";

import { ScoreBadge } from "@/components/score";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useMmProfiles, useMmScores } from "@/lib/hooks";
import { DEMO_MARKET_MAKER } from "@/wallet/config";
import { SignInButton } from "@/wallet/ConnectButton";
import { useSession } from "@/wallet/session";

import { proposalsKey } from "./ProposalList";
import type { BuiltTerms, TokenRef } from "./terms";

const OTHER = "other";

/**
 * Market-maker picker: listed profiles ranked by onchain score, or any address (a market maker the issuer found
 * elsewhere). Calls `onChange` with a valid address or null. With nothing chosen yet it preselects the demo market
 * maker when it is listed, else the top-ranked one.
 */
export function MarketMakerPicker({ value, onChange }: { value: string | null; onChange: (mm: string | null) => void }) {
  const profiles = useMmProfiles();
  const scores = useMmScores();
  const scoreOf = new Map((scores.data?.data.scores ?? []).map((s) => [s.mm, s] as const));
  const listed = [...(profiles.data?.data ?? [])].sort((a, b) => (scoreOf.get(b.address)?.score ?? -1) - (scoreOf.get(a.address)?.score ?? -1));
  const isListed = value !== null && listed.some((p) => p.address === value.toLowerCase());
  const [mode, setMode] = useState<string>(value && !isListed ? OTHER : (value?.toLowerCase() ?? ""));
  const [typed, setTyped] = useState(value && !isListed ? value : "");
  useEffect(() => {
    if (value !== null || mode !== "" || listed.length === 0) return;
    const pick = listed.find((p) => p.address === DEMO_MARKET_MAKER.toLowerCase()) ?? listed[0]!;
    setMode(pick.address);
    onChange(pick.address);
  }, [value, mode, listed.length]);

  return (
    <div className="space-y-2">
      <Label>Market maker</Label>
      <Select
        value={mode}
        onValueChange={(v) => {
          setMode(v);
          onChange(v === OTHER ? (isAddress(typed) ? typed : null) : v);
        }}
      >
        <SelectTrigger className="w-full sm:w-96">
          <SelectValue placeholder={profiles.isPending ? "Loading market makers…" : "Choose from the marketplace…"} />
        </SelectTrigger>
        <SelectContent>
          {listed.map((p) => (
            <SelectItem key={p.address} value={p.address}>
              <span className="flex items-center gap-2">
                {p.displayName} <ScoreBadge score={scoreOf.get(p.address)} />
              </span>
            </SelectItem>
          ))}
          <SelectItem value={OTHER}>Another address…</SelectItem>
        </SelectContent>
      </Select>
      {mode === OTHER && (
        <Input
          className="font-mono"
          placeholder="0x… market maker address"
          value={typed}
          onChange={(e) => {
            const v = e.target.value.trim();
            setTyped(v);
            onChange(isAddress(v) ? v : null);
          }}
        />
      )}
      <p className="text-xs text-muted-foreground">
        Scores come from onchain behaviour only; open a market maker's page from the marketplace to see the evidence.
      </p>
    </div>
  );
}

const EXPIRY_DAYS = [3, 7, 14, 30];

/**
 * Review-screen action for proposal mode: sends the reviewed terms to the market maker as a proposal (signed-in
 * Safe owner required). Nothing happens onchain until the market maker signs and the owners execute.
 */
export function SendProposal({ safe, base, quote, built, onSent }: { safe: Address; base: TokenRef; quote: TokenRef; built: BuiltTerms; onSent: () => void }) {
  const { signedIn } = useSession();
  const client = useQueryClient();
  const [note, setNote] = useState(`Market making for ${base.symbol}/${quote.symbol} under our treasury policy.`);
  const [days, setDays] = useState("7");
  const send = useMutation({
    mutationFn: () =>
      api.createProposal({
        safe,
        terms: termsToJson({ marketMaker: built.marketMaker, base: base.address, quote: quote.address, kind: built.kind, bounds: built.bounds, params: built.params }),
        expiresAt: Math.floor(Date.now() / 1000) + Number(days) * 86_400,
        note,
        send: true,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: proposalsKey(safe) });
      onSent();
    },
  });

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <p className="font-medium">Send as a proposal</p>
      <p className="text-sm text-muted-foreground">
        The market maker accepts by signing these exact terms. Then the Safe's owners approve and add the strategy under
        their treasury policy.
      </p>
      <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
        <div className="space-y-1.5">
          <Label htmlFor="proposal-note">Note to the market maker (optional)</Label>
          <textarea
            id="proposal-note"
            className="min-h-20 w-full rounded-md border bg-transparent px-3 py-2 text-sm"
            maxLength={1000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Offer valid for</Label>
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXPIRY_DAYS.map((d) => (
                <SelectItem key={d} value={String(d)}>
                  {d} days
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {signedIn ? (
        <Button disabled={send.isPending} onClick={() => send.mutate()}>
          {send.isPending ? "Sending…" : "Send proposal"}
        </Button>
      ) : (
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          Sign in as a Safe owner to send proposals. <SignInButton />
        </div>
      )}
      {send.error && <p className="text-sm text-blocked">{send.error.message}</p>}
    </div>
  );
}
