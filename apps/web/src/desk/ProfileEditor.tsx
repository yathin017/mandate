import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useConnection } from "wagmi";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError } from "@/lib/api";
import { qk } from "@/lib/hooks";
import { SignInButton } from "@/wallet/ConnectButton";
import { useSession } from "@/wallet/session";

interface Form {
  displayName: string;
  bio: string;
  website: string;
  contact: string;
  coverage: string;
  minDealUsd: string;
  listed: boolean;
}

const EMPTY: Form = { displayName: "", bio: "", website: "", contact: "", coverage: "", minDealUsd: "", listed: true };

/**
 * The market maker's own marketplace listing. Only the signed-in wallet can write it; performance is never part of
 * it (the score comes from onchain data). The API cleans and caps every field.
 */
export function ProfileEditor() {
  const { address } = useConnection();
  const { signedIn } = useSession();
  const client = useQueryClient();
  const me = address?.toLowerCase() ?? "";
  const existing = useQuery({
    queryKey: qk.mmProfile(me),
    queryFn: async () => {
      try {
        return (await api.mmProfile(me)).data;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: Boolean(address),
  });
  const [form, setForm] = useState<Form>(EMPTY);
  useEffect(() => {
    const p = existing.data;
    if (p)
      setForm({
        displayName: p.displayName,
        bio: p.bio,
        website: p.website ?? "",
        contact: p.contact ?? "",
        coverage: p.coverage.join(", "),
        minDealUsd: p.minDealUsd === null ? "" : String(p.minDealUsd),
        listed: p.listed,
      });
  }, [existing.data]);

  const save = useMutation({
    mutationFn: () =>
      api.saveProfile({
        displayName: form.displayName,
        bio: form.bio,
        website: form.website.trim() || null,
        contact: form.contact.trim() || null,
        coverage: form.coverage.split(",").map((t) => t.trim()).filter(Boolean),
        minDealUsd: form.minDealUsd.trim() === "" ? null : Number(form.minDealUsd.replaceAll(",", "")),
        listed: form.listed,
      }),
    onSuccess: async () => {
      await Promise.all([client.invalidateQueries({ queryKey: qk.mmProfiles }), client.invalidateQueries({ queryKey: qk.mmProfile(me) })]);
    },
  });

  if (!address) return <p className="text-sm text-muted-foreground">Connect the wallet you make markets from.</p>;
  if (!signedIn) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        Sign in to edit your listing. <SignInButton />
      </div>
    );
  }
  if (existing.isPending) return <Skeleton className="h-64 w-full" />;
  const minDealInvalid = form.minDealUsd.trim() !== "" && !/^\d[\d,]*$/.test(form.minDealUsd.trim());
  const set = (key: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [key]: e.target.value });

  return (
    <form
      className="max-w-2xl space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="displayName">Desk name</Label>
        <Input id="displayName" maxLength={64} value={form.displayName} onChange={set("displayName")} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="bio">About</Label>
        <textarea id="bio" maxLength={1000} className="min-h-28 w-full rounded-md border bg-transparent px-3 py-2 text-sm" value={form.bio} onChange={set("bio")} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="coverage">Coverage (comma separated, up to 10)</Label>
          <Input id="coverage" placeholder="Base launches, USDC pairs" value={form.coverage} onChange={set("coverage")} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="minDealUsd">Minimum deal (USD)</Label>
          <Input id="minDealUsd" inputMode="numeric" placeholder="No minimum" value={form.minDealUsd} onChange={set("minDealUsd")} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="contact">Contact (shown publicly)</Label>
          <Input id="contact" maxLength={100} placeholder="@telegram or email" value={form.contact} onChange={set("contact")} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="website">Website (https)</Label>
          <Input id="website" maxLength={200} placeholder="https://" value={form.website} onChange={set("website")} />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={form.listed} onChange={(e) => setForm({ ...form, listed: e.target.checked })} />
        Listed in the marketplace (unlisted profiles stay reachable by address)
      </label>
      {minDealInvalid && <p className="text-sm text-blocked">Minimum deal: whole dollars only.</p>}
      {save.error && <p className="text-sm text-blocked">{save.error.message}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!form.displayName.trim() || minDealInvalid || save.isPending}>
          {save.isPending ? "Saving…" : existing.data ? "Save profile" : "Publish profile"}
        </Button>
        {save.isSuccess && (
          <span className="text-sm text-filled">
            Saved. <Link to={`/market-makers/${me}`} className="underline underline-offset-4">View your page</Link>
          </span>
        )}
      </div>
    </form>
  );
}
