import { LogOut, Wallet } from "lucide-react";
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from "wagmi";

import { Button } from "@/components/ui/button";
import { shortHex } from "@/lib/format";

import { demoChain } from "./config";

/** Connect an injected wallet; prompts a network switch when it is not on the demo chain. */
export function ConnectButton() {
  const connection = useConnection();
  const connectors = useConnectors();
  const { connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  if (connection.status !== "connected") {
    const connector = connectors[0];
    return (
      <Button size="sm" variant="outline" disabled={!connector || isPending} onClick={() => connector && connect({ connector })}>
        <Wallet /> {isPending ? "Connecting…" : connector ? "Connect wallet" : "No wallet found"}
      </Button>
    );
  }

  if (connection.chainId !== demoChain.id) {
    return (
      <Button size="sm" variant="destructive" disabled={switching} onClick={() => switchChain({ chainId: demoChain.id })}>
        Switch to {demoChain.name}
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <span className="rounded-md bg-muted px-2 py-1 font-mono text-xs">{shortHex(connection.address)}</span>
      <Button size="icon" variant="ghost" aria-label="Disconnect wallet" onClick={() => disconnect()}>
        <LogOut />
      </Button>
    </div>
  );
}
