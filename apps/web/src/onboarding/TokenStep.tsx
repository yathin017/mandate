import { getChainConfig } from "@mandate/chains";
import { buildLaunchTokenCall, buildMintCall, isFactoryToken, launchProblem, LAUNCH_DECIMALS, mockTokenDeployment, predictLaunchedToken, randomLaunchSalt } from "@mandate/sdk";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { encodeDeployData, isAddress, type Address, type PublicClient } from "viem";
import { useConnection, usePublicClient } from "wagmi";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Hex } from "@/components/status";
import { formatUnits, parseUnits } from "@/lib/format";
import { demoChain, deployment, TOKEN_FACTORY } from "@/wallet/config";
import { hasCode } from "@/wallet/hasCode";
import { TxStatus } from "@/wallet/TxStatus";
import { useTx } from "@/wallet/useTx";

import { CONFIG_CHAIN_ID } from "./SafeStep";
import { useTokenInfo } from "./useTokenInfo";

/** Quote tokens offered first: the chain's canonical USDC/WETH and this deployment's demo quote token. */
function quoteOptions(): { address: Address; label: string }[] {
  const { tokens } = getChainConfig(CONFIG_CHAIN_ID);
  return [
    { address: tokens.usdc, label: "USDC (canonical)" },
    { address: tokens.weth, label: "WETH (canonical)" },
    { address: deployment.quote, label: "Demo quote token" },
  ];
}

/**
 * Step 2: the token the treasury sells (base) and the token it is paid in (quote). Done when both are ERC20s and
 * differ. A zero Safe balance only warns: the Safe can be funded later. A new project can launch its base token
 * here through the TokenFactory, with the whole supply going straight to the Safe.
 */
export function TokenStep({
  safe,
  base,
  quote,
  onChange,
}: {
  safe: string;
  base: string | null;
  quote: string | null;
  onChange: (key: "base" | "quote", value: string | null) => void;
}) {
  const same = base && quote && base.toLowerCase() === quote.toLowerCase();
  return (
    <div className="space-y-6">
      <TokenField
        title="Your token (base)"
        hint="The token the treasury trades under its policy."
        holder={safe}
        value={base}
        onChange={(v) => onChange("base", v)}
        launchable
      />
      <TokenField
        title="Paid in (quote)"
        hint="The token buyers pay with and buybacks use."
        holder={safe}
        value={quote}
        onChange={(v) => onChange("quote", v)}
        options={quoteOptions()}
        mockDefaults={{ name: "Demo Dollar", symbol: "dUSD", decimals: 6, supply: "400000" }}
      />
      {same && <p className="text-sm text-blocked">Base and quote must be different tokens.</p>}
    </div>
  );
}

function TokenField({
  title,
  hint,
  holder,
  value,
  onChange,
  options,
  mockDefaults,
  launchable = false,
}: {
  title: string;
  hint: string;
  holder: string;
  value: string | null;
  onChange: (value: string | null) => void;
  options?: { address: Address; label: string }[];
  /** Demo-only mock token helper (quote side). */
  mockDefaults?: MockDefaults;
  /** Offer a TokenFactory launch (base side), when this chain has a factory. */
  launchable?: boolean;
}) {
  const [input, setInput] = useState(value ?? "");
  const [mode, setMode] = useState<"address" | "mock" | "launch">("address");
  useEffect(() => setInput(value ?? ""), [value]);
  const check = useTokenInfo(value, holder);
  const info = check.info;
  const launched = useFactoryToken(info?.ok ? info.address : undefined);
  const canLaunch = launchable && TOKEN_FACTORY !== undefined;

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {options && (
        <Select value={options.some((o) => o.address === value) ? value! : ""} onValueChange={(v) => onChange(v)}>
          <SelectTrigger className="w-full sm:w-80">
            <SelectValue placeholder="Choose a known token…" />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.address} value={o.address}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <div className="flex flex-wrap gap-2">
        <Input className="min-w-0 flex-1 font-mono" placeholder="0x… token address" value={input} onChange={(e) => setInput(e.target.value.trim())} />
        <Button variant="outline" disabled={!isAddress(input)} onClick={() => onChange(input)}>
          Use
        </Button>
        {canLaunch && (
          <Button variant="ghost" onClick={() => setMode(mode === "launch" ? "address" : "launch")}>
            {mode === "launch" ? "Cancel launch" : "Launch a new token"}
          </Button>
        )}
        {mockDefaults && (
          <Button variant="ghost" onClick={() => setMode(mode === "mock" ? "address" : "mock")}>
            {mode === "mock" ? "Cancel demo token" : "Mint a demo token"}
          </Button>
        )}
      </div>

      {mode === "launch" && <LaunchTokenForm recipient={holder as Address} onCreated={(address) => { onChange(address); setMode("address"); }} />}
      {mode === "mock" && mockDefaults && (
        <MockTokenForm holder={holder} defaults={mockDefaults} onCreated={(address) => { onChange(address); setMode("address"); }} />
      )}

      {value && check.isLoading && <p className="text-sm text-muted-foreground">Reading token…</p>}
      {info && !info.ok && <p className="text-sm text-blocked">{info.reason}</p>}
      {info?.ok && (
        <div className="space-y-1 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <b>{info.symbol}</b> · {info.name} · {info.decimals} decimals · <Hex value={info.address} />
            {check.label?.canonical && <Badge className="bg-filled text-filled-foreground">canonical {check.label.canonical}</Badge>}
            {info.address.toLowerCase() === deployment.quote.toLowerCase() && <Badge variant="outline">demo</Badge>}
            {launched && <Badge variant="outline">launched on Mandate</Badge>}
          </p>
          {check.label?.warning && <p className="text-sm text-blocked">{check.label.warning}</p>}
          {check.balance !== undefined && (
            <p className={check.balance === 0n ? "text-warning" : "text-muted-foreground"}>
              Safe balance: <span className="tabular font-mono">{formatUnits(check.balance, info.decimals, 4)}</span> {info.symbol}
              {check.balance === 0n && " · fund the Safe before its strategies can trade"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** True when the token came from this chain's TokenFactory (not a look-alike with the same name). */
function useFactoryToken(token: Address | undefined): boolean {
  const client = usePublicClient({ chainId: demoChain.id }) as PublicClient | undefined;
  const query = useQuery({
    queryKey: ["factory-token", demoChain.id, TOKEN_FACTORY, token],
    queryFn: () => isFactoryToken(client!, TOKEN_FACTORY!, token!),
    enabled: Boolean(client && TOKEN_FACTORY && token),
    staleTime: Infinity,
  });
  return query.data === true;
}

/**
 * Launch through the TokenFactory: a fixed-supply 18-decimal ERC-20 with no owner or mint, the whole supply sent to
 * the Safe in the same transaction. The address is predicted for the connected wallet before signing.
 */
function LaunchTokenForm({ recipient, onCreated }: { recipient: Address; onCreated: (token: Address) => void }) {
  const [form, setForm] = useState({ name: "", symbol: "", supply: "1000000000" });
  // One salt per form: retrying the same launch after a failure targets the same address.
  const salt = useMemo(() => randomLaunchSalt(), []);
  const { address: creator } = useConnection();
  const client = usePublicClient({ chainId: demoChain.id }) as PublicClient | undefined;
  const tx = useTx();
  const [missing, setMissing] = useState<Address | null>(null);
  const supply = parseUnits(form.supply, LAUNCH_DECIMALS);
  const input = supply === null ? null : { name: form.name, symbol: form.symbol, supply, recipient, salt };
  const problem = !input ? "Supply: enter an amount of tokens" : launchProblem(input);

  async function run() {
    if (!input || problem || !client || !creator || !TOKEN_FACTORY) return;
    const predicted = await predictLaunchedToken(client, TOKEN_FACTORY, creator, input);
    const call = buildLaunchTokenCall(demoChain.id, TOKEN_FACTORY, input);
    const outcome = await tx.run({ send: { to: call.to, data: call.data }, skipIndexerWait: true });
    if (!outcome.ok) return;
    // The factory deploys exactly where predicted for this sender; confirm before using it.
    if (await hasCode(client, predicted)) onCreated(predicted);
    else setMissing(predicted);
  }

  return (
    <div className="space-y-3 rounded-md border p-3">
      <p className="text-xs text-muted-foreground">
        Creates a standard ERC-20 (18 decimals, permit) with a fixed supply and no owner, mint or pause, and sends the
        whole supply to the Safe <Hex value={recipient} />. Nothing about it can change after launch.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
        <Field label="Symbol" value={form.symbol} onChange={(v) => setForm({ ...form, symbol: v })} />
        <Field label="Total supply (tokens)" value={form.supply} onChange={(v) => setForm({ ...form, supply: v })} />
      </div>
      {(form.name || form.symbol) && problem && <p className="text-sm text-blocked">{problem}</p>}
      {!creator && <p className="text-sm text-muted-foreground">Connect a wallet to launch.</p>}
      <Button size="sm" disabled={Boolean(problem) || !creator || tx.busy} onClick={() => void run()}>
        Launch token
      </Button>
      <TxStatus state={tx.state} />
      {missing && <p className="text-sm text-blocked">The launch confirmed but the RPC does not show the token at {missing} yet. Paste that address above and press Use.</p>}
    </div>
  );
}

interface MockDefaults {
  name: string;
  symbol: string;
  decimals: number;
  supply: string;
}

/** Demo-only: deploy a clearly named mock token from the connected wallet, then mint the supply into the Safe. */
function MockTokenForm({ holder, defaults, onCreated }: { holder: string; defaults: MockDefaults; onCreated: (token: Address) => void }) {
  const [form, setForm] = useState(defaults);
  const deploy = useTx();
  const mint = useTx();
  let error: string | null = null;
  let request: ReturnType<typeof mockTokenDeployment> | null = null;
  const supply = parseUnits(form.supply, form.decimals);
  try {
    request = mockTokenDeployment(form.name, form.symbol, form.decimals);
    if (supply === null || supply === 0n) throw new Error("Supply must be a positive amount");
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  async function run() {
    if (!request || !supply) return;
    const deployed = await deploy.run({
      send: { data: encodeDeployData({ abi: request.abi, bytecode: request.bytecode, args: request.args }) },
      skipIndexerWait: true,
    });
    if (!deployed.ok || !deployed.contractAddress) return;
    const call = buildMintCall(CONFIG_CHAIN_ID, deployed.contractAddress, holder as Address, supply);
    const minted = await mint.run({ send: { to: call.to, data: call.data }, skipIndexerWait: true });
    if (minted.ok) onCreated(deployed.contractAddress);
  }

  return (
    <div className="space-y-3 rounded-md border border-dashed border-warning/60 p-3">
      <p className="text-xs text-muted-foreground">
        Demo only: creates a worthless test token you own (name must start with "Demo ") and mints the supply into the Safe.
      </p>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
        <Field label="Symbol" value={form.symbol} onChange={(v) => setForm({ ...form, symbol: v })} />
        <Field label="Decimals" value={String(form.decimals)} onChange={(v) => setForm({ ...form, decimals: Number(v) || 0 })} />
        <Field label="Supply to Safe" value={form.supply} onChange={(v) => setForm({ ...form, supply: v })} />
      </div>
      {error && <p className="text-sm text-blocked">{error}</p>}
      <Button size="sm" disabled={Boolean(error) || deploy.busy || mint.busy} onClick={() => void run()}>
        Deploy and mint
      </Button>
      <TxStatus state={deploy.state} />
      <TxStatus state={mint.state} />
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input className="font-mono" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
