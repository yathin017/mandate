import { ExternalLink } from "lucide-react";
import { Link, useSearchParams } from "react-router";

import { MandateCards } from "@/components/MandateCards";
import { Hex } from "@/components/status";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatChainTime, formatCompact } from "@/lib/format";
import { useLaunchedTokens, useMandates } from "@/lib/hooks";
import { addressUrl } from "@/wallet/config";

/** Public discovery: live mandates and tokens launched on the platform. No wallet needed. */
export function Explore() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "tokens" ? "tokens" : "mandates";
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-3xl font-semibold tracking-tight">Explore</h1>
        <p className="text-muted-foreground">Every mandate's terms and refusals are public, and so is every launch.</p>
      </div>
      <Tabs value={tab} onValueChange={(v) => setParams(v === "tokens" ? { tab: "tokens" } : {}, { replace: true })}>
        <TabsList>
          <TabsTrigger value="mandates">Mandates</TabsTrigger>
          <TabsTrigger value="tokens">Launched tokens</TabsTrigger>
        </TabsList>
        <TabsContent value="mandates" className="pt-4">
          <Mandates />
        </TabsContent>
        <TabsContent value="tokens" className="pt-4">
          <Tokens />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Mandates() {
  const mandates = useMandates();
  if (mandates.isPending) return <Skeleton className="h-40 w-full" />;
  if (mandates.isError) return <p className="text-blocked">Could not load mandates: {mandates.error.message}</p>;
  if (mandates.data.data.length === 0) {
    return (
      <p className="text-muted-foreground">
        No mandates yet. <Link to="/launch" className="underline underline-offset-4">Launch one</Link>.
      </p>
    );
  }
  return <MandateCards mandates={mandates.data.data} />;
}

function Tokens() {
  const tokens = useLaunchedTokens();
  if (tokens.isPending) return <Skeleton className="h-40 w-full" />;
  if (tokens.isError) return <p className="text-blocked">Could not load launches: {tokens.error.message}</p>;
  if (tokens.data.data.length === 0) {
    return (
      <p className="text-muted-foreground">
        No tokens launched here yet. <Link to="/launch" className="underline underline-offset-4">Launch the first</Link>.
      </p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Token</TableHead>
          <TableHead className="text-right">Supply</TableHead>
          <TableHead>Treasury</TableHead>
          <TableHead>Launched</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tokens.data.data.map((t) => {
          const url = addressUrl(t.token);
          return (
            <TableRow key={t.token}>
              <TableCell>
                <span className="font-medium">{t.symbol}</span> <span className="text-muted-foreground">{t.name}</span>{" "}
                {url ? (
                  <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
                    <Hex value={t.token} /> <ExternalLink className="size-3" />
                  </a>
                ) : (
                  <Hex value={t.token} />
                )}
              </TableCell>
              <TableCell className="tabular text-right font-mono">{formatCompact(t.supply, 18)}</TableCell>
              <TableCell>
                <Hex value={t.recipient} />
              </TableCell>
              <TableCell className="text-muted-foreground">{formatChainTime(t.timestamp)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
