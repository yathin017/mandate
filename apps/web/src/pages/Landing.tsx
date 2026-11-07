import { ArrowRight, Building2, Check, LineChart, ShieldCheck } from "lucide-react";
import { Link } from "react-router";

import { BlockedStamp } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useLaunchedTokens, useMmProfiles, useStrategies } from "@/lib/hooks";
import { demoChain } from "@/wallet/config";

const STEPS = [
  { title: "Launch", body: "Create your token with a fixed supply that lands straight in your team's Safe." },
  { title: "Anchor", body: "Open a Uniswap v4 pool with an oracle hook; it reports price, depth and volatility to your treasury." },
  { title: "Policy", body: "Set your treasury's release, sell and buyback limits, price rules and when to turn defensive or pause." },
  { title: "Strategies", body: "Market makers sign the exact terms and trade inside your policy, sharing its limits." },
];

/**
 * Front door for both sides of the market: issuers launching a token, and market makers looking for work.
 * Live counts come from the indexer; nothing here needs a wallet.
 */
export function Landing() {
  return (
    <div className="space-y-16">
      <section className="space-y-6 pt-6">
        <p className="text-sm font-medium tracking-wide text-primary uppercase">Token launches and market making on {demoChain.name}</p>
        <h1 className="max-w-3xl font-serif text-4xl leading-tight font-semibold tracking-tight text-balance sm:text-5xl">
          Market makers get a mandate, not your tokens.
        </h1>
        <p className="max-w-2xl text-lg text-muted-foreground">
          Launch a token, pick a market maker by their onchain record, and hand them limits instead of custody. Every
          trade is checked against the deal; every refusal is public.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link to="/launch">
              Launch a token <ArrowRight />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/market-makers">Browse market makers</Link>
          </Button>
        </div>
        <LiveStats />
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <RoleCard
          icon={<Building2 />}
          title="For issuers"
          description="From a fresh token to a market maker under contract, without giving up custody."
          points={["Launch a fixed-supply token into your Safe", "One policy for the whole treasury: limits no strategy can reset", "Trading turns defensive or pauses when the market looks wrong"]}
          cta={{ to: "/launch", label: "Start a launch" }}
          secondary={{ to: "/issuer", label: "Manage my Safe" }}
        />
        <RoleCard
          icon={<LineChart />}
          title="For market makers"
          description="Win strategies on your record and get paid on real fills, inside clear rails."
          points={["Publish a profile issuers can find", "Accept terms with one signature", "Tune spread and inventory; claim fees directly"]}
          cta={{ to: "/desk", label: "Open the desk" }}
          secondary={{ to: "/market-makers", label: "See the leaderboard" }}
        />
      </section>

      <section className="space-y-4">
        <h2 className="font-serif text-2xl font-semibold">How it works</h2>
        <ol className="grid gap-4 md:grid-cols-4">
          {STEPS.map((step, i) => (
            <li key={step.title} className="space-y-1 rounded-xl border bg-card p-4">
              <p className="text-xs font-medium text-muted-foreground">Step {i + 1}</p>
              <p className="font-medium">{step.title}</p>
              <p className="text-sm text-muted-foreground">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="grid items-center gap-8 rounded-xl border bg-card p-8 md:grid-cols-[1fr_auto]">
        <div className="space-y-2">
          <h2 className="flex items-center gap-2 font-serif text-2xl font-semibold">
            <ShieldCheck className="size-6 text-filled" /> Every "no" explains itself
          </h2>
          <p className="text-muted-foreground">
            A sell past the treasury's limits, below the floor, or into a manipulated or thin market is refused before
            any token moves, and the refusal shows up on the strategy's public page with the clause it broke.
          </p>
        </div>
        <BlockedStamp clause="Net sell limit" className="scale-125" />
      </section>

      <section className="text-sm text-muted-foreground">
        <h2 className="mb-2 font-medium text-foreground">Disclaimer</h2>
        Mandate governs treasuries that make markets onchain; it cannot stop sales on centralized exchanges. Its market
        checks read one Uniswap v4 pool, so a pool with little real liquidity gives weak protection. The contracts are
        unaudited.
      </section>
    </div>
  );
}

function LiveStats() {
  const strategies = useStrategies();
  const mms = useMmProfiles();
  const tokens = useLaunchedTokens();
  const stats = [
    { label: "Strategies", value: strategies.data?.data.length, to: "/explore" },
    { label: "Market makers", value: mms.data?.data.length, to: "/market-makers" },
    { label: "Tokens launched", value: tokens.data?.data.length, to: "/explore?tab=tokens" },
  ];
  return (
    <dl className="flex flex-wrap gap-8 pt-2">
      {stats.map((s) => (
        <Link key={s.label} to={s.to} className="group">
          <dt className="text-xs text-muted-foreground group-hover:text-foreground">{s.label}</dt>
          <dd className="tabular font-mono text-2xl">{s.value ?? "–"}</dd>
        </Link>
      ))}
    </dl>
  );
}

function RoleCard(props: {
  icon: React.ReactNode;
  title: string;
  description: string;
  points: string[];
  cta: { to: string; label: string };
  secondary: { to: string; label: string };
}) {
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 font-serif text-xl [&_svg]:size-5 [&_svg]:text-primary">
          {props.icon} {props.title}
        </CardTitle>
        <CardDescription>{props.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-between gap-6">
        <ul className="space-y-2 text-sm">
          {props.points.map((p) => (
            <li key={p} className="flex gap-2">
              <Check className="mt-0.5 size-3.5 shrink-0 text-filled" /> {p}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link to={props.cta.to}>{props.cta.label}</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link to={props.secondary.to}>{props.secondary.label}</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
