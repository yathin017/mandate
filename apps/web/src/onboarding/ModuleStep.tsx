import { buildEnableModuleCall } from "@mandate/sdk";
import type { Address } from "viem";

import { deployment } from "@/wallet/config";
import { SafeActionPanel } from "@/wallet/SafeActionPanel";

import { CONFIG_CHAIN_ID } from "./SafeStep";
import type { SafeCheck } from "./useSafeCheck";

/** Step 3: the Safe enables the Mandate module on itself, approved by its owners. */
export function ModuleStep({ safe, check }: { safe: Address; check: SafeCheck }) {
  if (check.moduleEnabled) {
    return <p className="text-sm text-filled">The Mandate module is enabled on this Safe.</p>;
  }
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Lets the Safe ship Mandate strategies. It cannot move tokens on its own: every policy and strategy still needs the
        owners' approval, and a market maker only gets the bounded powers its strategy grants.
      </p>
      <SafeActionPanel
        safe={safe}
        call={buildEnableModuleCall(CONFIG_CHAIN_ID, safe, deployment.module)}
        label="Enable the Mandate module"
        onDone={check.refetch}
      />
    </div>
  );
}
