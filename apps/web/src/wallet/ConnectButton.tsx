import { BadgeCheck, LogOut, Wallet } from "lucide-react";
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from "wagmi";

import { Button } from "@/components/ui/button";
import { shortHex } from "@/lib/format";

import { demoChain, roleOf } from "./config";
import { useSession, useSignIn, useSignOut } from "./session";

/** Connect an injected wallet; prompts a network switch when it is not on the demo chain. */
export function ConnectButton() {
  const connection = useConnection();
  const connectors = useConnectors();
  const { connect, isPending } = useConnect();
  const { disconnect: disconnectWallet } = useDisconnect();
  const signOut = useSignOut();
  const disconnect = () => {
    // A session outliving the wallet connection would act for an address the user just put away.
    signOut.mutate();
    disconnectWallet();
  };
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
      <span className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 font-mono text-xs">
        {shortHex(connection.address)}
        {roleOf(connection.address) && <span className="font-sans text-muted-foreground">· {roleOf(connection.address)}</span>}
      </span>
      <SignInButton />
      <Button size="icon" variant="ghost" aria-label="Disconnect wallet" onClick={() => disconnect()}>
        <LogOut />
      </Button>
    </div>
  );
}

/** Proves the connected address to the API (profiles, proposals). Disconnecting the wallet also signs out. */
export function SignInButton() {
  const { signedIn } = useSession();
  const signIn = useSignIn();
  const signOut = useSignOut();
  if (signedIn) {
    return (
      <Button size="sm" variant="ghost" className="text-filled" title="Signed in. Click to sign out." onClick={() => signOut.mutate()}>
        <BadgeCheck /> <span className="hidden sm:inline">Signed in</span>
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={signIn.isPending}
      title={signIn.error ? signIn.error.message : "Sign a message (no gas) to use profiles and proposals"}
      onClick={() => signIn.mutate()}
    >
      {signIn.isPending ? "Signing…" : signIn.isError ? "Retry sign-in" : "Sign in"}
    </Button>
  );
}
