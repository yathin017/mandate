import { buildCreateSafeCall } from "@mandate/sdk";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { isAddress, type Address } from "viem";
import { useConnection, usePublicClient } from "wagmi";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Hex } from "@/components/status";
import { demoChain, deployment, roleOf } from "@/wallet/config";
import { TxStatus } from "@/wallet/TxStatus";
import { useTx } from "@/wallet/useTx";

import type { SafeCheck } from "./useSafeCheck";

/** Chain whose config (Safe factory, canonical tokens) applies: the fork uses its source chain's addresses. */
export const CONFIG_CHAIN_ID = deployment.sourceChainId;

/**
 * Step 1: the treasury Safe. Either validate an existing Safe or create one through the chain's canonical
 * Safe 1.4.1 factory. The chosen address is lifted to the URL by `onSelect`.
 */
export function SafeStep({ safe, check, onSelect }: { safe: string | null; check: SafeCheck; onSelect: (safe: Address) => void }) {
  const [mode, setMode] = useState<"existing" | "create">(safe ? "existing" : "create");
  return (
    <Tabs value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
      <TabsList>
        <TabsTrigger value="create">Create a new Safe</TabsTrigger>
        <TabsTrigger value="existing">Use an existing Safe</TabsTrigger>
      </TabsList>
      <TabsContent value="existing" className="space-y-3 pt-3">
        <ExistingSafe safe={safe} check={check} onSelect={onSelect} />
      </TabsContent>
      <TabsContent value="create" className="pt-3">
        <CreateSafe onCreated={(address) => { onSelect(address); setMode("existing"); }} />
      </TabsContent>
    </Tabs>
  );
}

function ExistingSafe({ safe, check, onSelect }: { safe: string | null; check: SafeCheck; onSelect: (safe: Address) => void }) {
  const [input, setInput] = useState(safe ?? "");
  useEffect(() => setInput(safe ?? ""), [safe]);
  const valid = isAddress(input);
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="safe-address">Safe address</Label>
        <div className="flex gap-2">
          <Input id="safe-address" className="font-mono" placeholder="0x…" value={input} onChange={(e) => setInput(e.target.value.trim())} />
          <Button variant="outline" disabled={!valid} onClick={() => onSelect(input as Address)}>
            Use
          </Button>
        </div>
      </div>
      {safe && check.isSafe === false && <p className="text-sm text-blocked">This address is not a Safe on {demoChain.name}.</p>}
      {safe && check.isSafe && (
        <div className="space-y-1 rounded-lg border p-3 text-sm">
          <p>
            Safe <Hex value={safe} chars={6} /> · version {check.version} · threshold <b>{check.threshold}</b> of {check.owners.length}
          </p>
          <ul>
            {check.owners.map((o) => (
              <li key={o}>
                <Hex value={o} /> {roleOf(o) && <span className="text-xs text-muted-foreground">{roleOf(o)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Random 64-bit salt so two projects with the same owners never collide on the factory's CREATE2. */
function randomSalt(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
}

function CreateSafe({ onCreated }: { onCreated: (safe: Address) => void }) {
  const { address, chainId } = useConnection();
  const wrongNetwork = Boolean(address) && chainId !== demoChain.id;
  const publicClient = usePublicClient({ chainId: demoChain.id });
  const tx = useTx();
  const [owners, setOwners] = useState<string[]>([""]);
  const [threshold, setThreshold] = useState(1);
  const [salt] = useState(randomSalt);
  const [predicted, setPredicted] = useState<Address | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Default the first owner to the connected wallet.
  useEffect(() => {
    if (address && owners[0] === "") setOwners([address, ...owners.slice(1)]);
  }, [address, owners]);

  const cleaned = owners.map((o) => o.trim()).filter(Boolean);
  let call: ReturnType<typeof buildCreateSafeCall> | null = null;
  let invalid: string | null = null;
  try {
    if (cleaned.some((o) => !isAddress(o))) throw new Error("Every owner must be a valid address.");
    call = buildCreateSafeCall(CONFIG_CHAIN_ID, { owners: cleaned as Address[], threshold, saltNonce: salt });
  } catch (e) {
    invalid = e instanceof Error ? e.message : String(e);
  }

  // The factory's CREATE2 address depends only on (singleton, setup, salt): simulate to show it before signing.
  useEffect(() => {
    setPredicted(null);
    setError(null);
    if (!call || !publicClient || !address) return;
    let cancelled = false;
    publicClient
      .call({ account: address, to: call.to, data: call.data })
      .then((result) => {
        if (cancelled || !result.data) return;
        setPredicted(`0x${result.data.slice(-40)}` as Address);
      })
      .catch(() => !cancelled && setError("The Safe factory refused these settings."));
    return () => {
      cancelled = true;
    };
    // Keyed on the calldata: `call` is rebuilt every render but only its bytes matter.
  }, [call?.data, publicClient, address]);

  async function create() {
    if (!call || !predicted || !publicClient) return;
    setError(null);
    const outcome = await tx.run({ send: { to: call.to, data: call.data }, skipIndexerWait: true });
    if (!outcome.ok) return;
    // A load-balanced public RPC can answer from a node that has not seen the receipt's block yet: retry briefly
    // before concluding the Safe is missing.
    let code: string | undefined;
    for (let attempt = 0; attempt < 10 && (!code || code === "0x"); attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1500));
      code = await publicClient.getCode({ address: predicted }).catch(() => undefined);
    }
    if (!code || code === "0x") {
      setError("The transaction confirmed but no Safe exists at the predicted address. Do not use it; contact support.");
      return;
    }
    onCreated(predicted);
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Owners</Label>
        {owners.map((owner, i) => (
          <div key={i} className="flex gap-2">
            <Input
              className="font-mono"
              placeholder="0x…"
              value={owner}
              onChange={(e) => setOwners(owners.map((o, j) => (j === i ? e.target.value : o)))}
              aria-label={`Owner ${i + 1}`}
            />
            {owners.length > 1 && (
              <Button variant="ghost" size="icon" aria-label={`Remove owner ${i + 1}`} onClick={() => setOwners(owners.filter((_, j) => j !== i))}>
                <Trash2 />
              </Button>
            )}
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={() => setOwners([...owners, ""])}>
          <Plus /> Add owner
        </Button>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="threshold">Approvals required</Label>
        <Input
          id="threshold"
          type="number"
          min={1}
          max={Math.max(1, cleaned.length)}
          className="w-24 tabular font-mono"
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
        />
        <p className="text-[11px] text-muted-foreground">
          How many owners must approve each issuer action. 2 or more is recommended for a real treasury.
        </p>
      </div>
      {invalid && <p className="text-sm text-blocked">{invalid}</p>}
      {predicted && (
        <p className="text-sm">
          Your Safe will be created at <Hex value={predicted} chars={6} /> (Safe 1.4.1, official factory).
        </p>
      )}
      {!address && <p className="text-xs text-muted-foreground">Connect a wallet to pay for the deployment.</p>}
      {wrongNetwork && <p className="text-xs text-blocked">Switch your wallet to {demoChain.name} to create the Safe.</p>}
      <Button disabled={!predicted || wrongNetwork || tx.busy} onClick={() => void create()}>
        Create Safe
      </Button>
      <TxStatus state={tx.state} />
      {error && <p className="text-sm text-blocked">{error}</p>}
      <p className="text-[11px] text-muted-foreground">Uses the canonical Safe factory and singleton from config/chains.</p>
    </div>
  );
}
