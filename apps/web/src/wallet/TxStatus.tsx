import { CheckCircle2, Loader2, XCircle } from "lucide-react";

import { BlockedStamp, Hex } from "@/components/status";
import { clauseOf } from "@/lib/clauses";

import type { TxState } from "./useTx";

/** idle → checking → confirm in wallet → pending (hash) → confirmed (block), or a plain-language refusal. */
export function TxStatus({ state }: { state: TxState }) {
  switch (state.status) {
    case "idle":
      return null;
    case "simulating":
      return <Line icon={<Loader2 className="size-4 animate-spin" />}>Checking with the contracts…</Line>;
    case "signing":
      return <Line icon={<Loader2 className="size-4 animate-spin" />}>Confirm in your wallet…</Line>;
    case "pending":
      return (
        <Line icon={<Loader2 className="size-4 animate-spin" />}>
          Pending · tx <Hex value={state.hash} />
        </Line>
      );
    case "confirmed":
      return (
        <Line icon={<CheckCircle2 className="size-4 text-filled" />}>
          Confirmed in block <span className="tabular font-mono">{state.blockNumber.toString()}</span> · tx <Hex value={state.hash} />
        </Line>
      );
    case "blocked":
      return (
        <div className="space-y-2 rounded-lg border border-blocked/40 bg-blocked/5 p-3" role="alert">
          <BlockedStamp clause={clauseOf(state.error.errorName)} />
          <p className="text-sm">{state.error.message}</p>
          <p className="text-xs text-muted-foreground">Nothing was sent.</p>
        </div>
      );
    case "failed":
      return (
        <Line icon={<XCircle className="size-4 text-blocked" />}>
          {state.message}
          {state.hash && <> · tx <Hex value={state.hash} /></>}
        </Line>
      );
  }
}

function Line({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm" aria-live="polite">
      {icon}
      <span>{children}</span>
    </p>
  );
}
