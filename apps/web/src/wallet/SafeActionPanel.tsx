import type { ErrorContext, PreparedCall } from "@mandate/sdk";
import { Check, Circle } from "lucide-react";
import type { Address } from "viem";
import { useConnection } from "wagmi";

import { Button } from "@/components/ui/button";
import { Hex } from "@/components/status";

import { demoChain } from "./config";
import { useSafeAction } from "./useSafe";
import { TxStatus } from "./TxStatus";

/**
 * Collects onchain approvals from the Safe's owners for one module call, then executes it.
 * The approval is bound to this exact call and the Safe's current nonce.
 */
export function SafeActionPanel({
  safe,
  call,
  label,
  context,
  onDone,
}: {
  safe: Address;
  call: PreparedCall;
  label: string;
  context?: ErrorContext;
  onDone?: () => void;
}) {
  const action = useSafeAction(safe, call, context);
  const { info, approvals, threshold, approvedCount, isOwner, hasApproved, canExecute, tx, executed } = action;
  const connection = useConnection();

  if (executed) {
    return (
      <div className="space-y-2 rounded-lg border border-filled/40 p-4">
        <p className="font-medium">{label}: executed</p>
        <TxStatus state={tx.state} />
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">{label}</p>
        <span className="text-xs text-muted-foreground">
          {approvedCount} of {threshold || "?"} approvals · Safe nonce {info.nonce?.toString() ?? "…"}
        </span>
      </div>
      {action.safeTxHash && (
        <p className="text-xs text-muted-foreground">
          Safe transaction <Hex value={action.safeTxHash} chars={6} />
        </p>
      )}
      <ul className="space-y-1 text-sm">
        {info.owners?.map((owner) => (
          <li key={owner} className="flex items-center gap-2">
            {approvals.get(owner.toLowerCase()) ? <Check className="size-4 text-filled" /> : <Circle className="size-4 text-muted-foreground" />}
            <Hex value={owner} />
          </li>
        ))}
      </ul>
      <ExecuteHint
        wrongChain={connection.status === "connected" && connection.chainId !== demoChain.id}
        loading={!info.owners || !action.safeTxHash}
        isOwner={isOwner}
        busy={tx.busy}
        missing={Math.max(0, threshold - approvedCount - (hasApproved ? 0 : 1))}
      />
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={!isOwner || hasApproved || tx.busy} onClick={() => void action.approve()}>
          {hasApproved ? "Approved" : "Approve as owner"}
        </Button>
        <Button
          disabled={!canExecute || tx.busy}
          onClick={async () => {
            await action.execute();
            onDone?.();
          }}
        >
          Execute
        </Button>
      </div>
      <TxStatus state={tx.state} />
    </div>
  );
}

/**
 * Says why the buttons are disabled, in the order a user would fix it. Execute counts the executor's own signature,
 * so it needs `threshold − 1` prior approvals from the other owners.
 */
function ExecuteHint({ wrongChain, loading, isOwner, busy, missing }: { wrongChain: boolean; loading: boolean; isOwner: boolean; busy: boolean; missing: number }) {
  let text: string | null = null;
  if (wrongChain) text = `Switch your wallet to ${demoChain.name} to approve or execute.`;
  else if (loading) text = "Reading the Safe's owners, nonce and approvals…";
  else if (!isOwner) text = "Connect one of the Safe's owners to approve or execute.";
  else if (busy) text = "A transaction is in progress; the buttons come back once it is confirmed.";
  else if (missing > 0) text = `Execute needs ${missing} more owner approval${missing === 1 ? "" : "s"} first: another owner clicks Approve.`;
  return text ? <p className="text-xs text-muted-foreground">{text}</p> : null;
}
