import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { useConnection } from "wagmi";

import { Hex } from "@/components/status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Inbox } from "@/desk/Inbox";
import { MyMandates } from "@/desk/MyMandates";
import { Performance } from "@/desk/Performance";
import { ProfileEditor } from "@/desk/ProfileEditor";
import { api } from "@/lib/api";
import { DEMO_ACCOUNTS, isLive } from "@/wallet/config";
import { useSession } from "@/wallet/session";

const TABS = ["inbox", "mandates", "profile", "performance"] as const;
type Tab = (typeof TABS)[number];

/**
 * The market maker's workspace: proposals to answer, mandates to operate, the public listing, and the onchain record
 * issuers judge it by. The active tab lives in the URL (?tab=).
 */
export function MMDesk() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.includes(params.get("tab") as Tab) ? (params.get("tab") as Tab) : "inbox";
  const { status } = useConnection();
  const { signedIn } = useSession();
  // Same key as the inbox list, so the badge and the list share one request.
  const inbox = useQuery({ queryKey: ["proposals", "inbox"], queryFn: api.proposalsForMe, enabled: signedIn, refetchInterval: 15_000 });
  const waiting = inbox.data?.data.filter((p) => p.status === "sent").length ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-3xl font-semibold tracking-tight">Desk</h1>
        <p className="text-muted-foreground">Answer proposals, operate your mandates inside the issuer's rails, and keep your listing current.</p>
      </div>
      {status !== "connected" && (
        <Alert>
          <AlertTitle>Connect your market-making wallet</AlertTitle>
          <AlertDescription>
            The testing Market Maker wallet is <Hex value={DEMO_ACCOUNTS.marketMaker} />
            {isLive ? "." : " (Anvil account #2)."}
          </AlertDescription>
        </Alert>
      )}
      <Tabs value={tab} onValueChange={(v) => setParams(v === "inbox" ? {} : { tab: v }, { replace: true })}>
        <TabsList>
          <TabsTrigger value="inbox">
            Inbox {waiting > 0 && <Badge className="ml-1.5 h-5 px-1.5">{waiting}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="mandates">My mandates</TabsTrigger>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="performance">Performance</TabsTrigger>
        </TabsList>
        <TabsContent value="inbox" className="pt-4">
          <Inbox />
        </TabsContent>
        <TabsContent value="mandates" className="pt-4">
          <MyMandates />
        </TabsContent>
        <TabsContent value="profile" className="pt-4">
          <ProfileEditor />
        </TabsContent>
        <TabsContent value="performance" className="pt-4">
          <Performance />
        </TabsContent>
      </Tabs>
    </div>
  );
}
