import { ArrowRight } from "lucide-react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BlockedStamp } from "@/components/status";

const STORY = [
  {
    title: "The old deal",
    body: "The project lends its market maker tokens plus a call option. The tokens leave the treasury on day one. Selling has open-ended upside for the MM and a capped downside.",
  },
  {
    title: "What happened",
    body: "Movement (MOVE), Dec 2024: about 66M tokens were sold the day after listing. Binance offboarded the market maker and froze roughly 38M USDT of proceeds (Binance, Mar 2025). The project found out from the chart.",
  },
  {
    title: "Mandate",
    body: "Tokens stay in the project's Safe. The MM can only quote inside limits enforced on every fill: a release schedule, a daily sell cap, a price floor and a Uniswap TWAP anchor. It earns fees on real trades.",
  },
];

export function Landing() {
  return (
    <div className="space-y-16">
      <section className="space-y-6 pt-6">
        <p className="text-sm font-medium tracking-wide text-primary uppercase">The market-maker deal as an onchain program</p>
        <h1 className="max-w-3xl font-serif text-4xl leading-tight font-semibold tracking-tight text-balance sm:text-5xl">
          Market makers get a mandate, not your tokens.
        </h1>
        <p className="max-w-2xl text-lg text-muted-foreground">
          The deal terms are the code, and the code refuses any trade that breaks them. Every refusal is public,
          with the clause it broke.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link to="/replay">
              Watch the replay <ArrowRight />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/mandates">Open a mandate</Link>
          </Button>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {STORY.map((item, i) => (
          <Card key={item.title} className={i === 2 ? "border-primary/40" : undefined}>
            <CardHeader>
              <CardTitle className="font-serif text-xl">{item.title}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm leading-relaxed text-muted-foreground">{item.body}</CardContent>
          </Card>
        ))}
      </section>

      <section className="grid items-center gap-8 rounded-xl border bg-card p-8 md:grid-cols-[1fr_auto]">
        <div className="space-y-2">
          <h2 className="font-serif text-2xl font-semibold">Every "no" explains itself</h2>
          <p className="text-muted-foreground">
            A sell past the daily limit, below the floor, or into a manipulated price is refused by the quoter before
            any token moves, and the refusal lands in the public activity feed.
          </p>
        </div>
        <BlockedStamp clause="Daily sell limit reached" className="scale-125" />
      </section>

      <section className="text-sm text-muted-foreground">
        <h2 className="mb-2 font-medium text-foreground">Honest limits</h2>
        Mandate cannot stop sales on centralized exchanges; it governs treasuries that make markets onchain. The demo
        runs on a local fork of Ethereum mainnet with synthetic tokens and synthetic oracle history.
      </section>
    </div>
  );
}
