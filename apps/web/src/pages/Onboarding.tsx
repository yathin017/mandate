import { CheckCircle2, Circle, CircleDot } from "lucide-react";
import { useSearchParams } from "react-router";
import type { Address } from "viem";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SafeStep } from "@/onboarding/SafeStep";
import { TokenStep } from "@/onboarding/TokenStep";
import { useTokenInfo } from "@/onboarding/useTokenInfo";
import { useSafeCheck } from "@/onboarding/useSafeCheck";
import { cn } from "@/lib/utils";
import { demoChain, isLive } from "@/wallet/config";

type StepState = "done" | "current" | "upcoming";

/**
 * Self-serve onboarding: Safe → tokens → module → anchor → mandate. Choices live in the URL (?safe=…), so every
 * owner can open the same link and continue; each step's completion is read from the chain, not stored locally.
 */
export function Onboarding() {
  const [params, setParams] = useSearchParams();
  const safe = params.get("safe");
  const check = useSafeCheck(safe);
  const safeDone = Boolean(safe && check.isSafe);
  const base = params.get("base");
  const quote = params.get("quote");
  const baseCheck = useTokenInfo(base, safe);
  const quoteCheck = useTokenInfo(quote, safe);
  const tokensDone =
    safeDone && baseCheck.info?.ok === true && quoteCheck.info?.ok === true && base!.toLowerCase() !== quote!.toLowerCase();

  const select = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const steps: { title: string; description: string; state: StepState; body?: React.ReactNode }[] = [
    {
      title: "Treasury Safe",
      description: "The Safe that holds your tokens. The market maker never gets custody.",
      state: safeDone ? "done" : "current",
      body: <SafeStep safe={safe} check={check} onSelect={(address: Address) => select("safe", address)} />,
    },
    {
      title: "Token pair",
      description: "Your token and the token you are paid in.",
      state: tokensDone ? "done" : safeDone ? "current" : "upcoming",
      body: safe ? <TokenStep safe={safe} base={base} quote={quote} onChange={select} /> : undefined,
    },
    { title: "Enable Mandate", description: "The Safe's owners turn on the Mandate module.", state: tokensDone ? "current" : "upcoming" },
    { title: "Price anchor", description: "A Uniswap v4 pool with the oracle hook and 30 minutes of history.", state: "upcoming" },
    { title: "Create the mandate", description: "Terms, market maker, owners' approval.", state: "upcoming" },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-serif text-3xl font-semibold tracking-tight">Onboard a project</h1>
        <p className="text-muted-foreground">
          Set up a mandate for your own token on {demoChain.name}. Every step is a transaction you sign; nothing is custodial.
        </p>
      </div>
      {isLive && (
        <Alert>
          <AlertTitle>Real network</AlertTitle>
          <AlertDescription>
            This deployment runs on {demoChain.name} mainnet. Transactions cost real gas. Use test tokens unless you intend otherwise.
          </AlertDescription>
        </Alert>
      )}
      <ol className="space-y-4">
        {steps.map((step, i) => (
          <li key={step.title}>
            <Card className={cn(step.state === "upcoming" && "opacity-60")}>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <StepIcon state={step.state} />
                  <span className="text-muted-foreground">{i + 1}.</span> {step.title}
                </CardTitle>
                <CardDescription>{step.description}</CardDescription>
              </CardHeader>
              {step.body && step.state !== "upcoming" && <CardContent>{step.body}</CardContent>}
            </Card>
          </li>
        ))}
      </ol>
    </div>
  );
}

function StepIcon({ state }: { state: StepState }) {
  if (state === "done") return <CheckCircle2 className="size-5 text-filled" aria-label="done" />;
  if (state === "current") return <CircleDot className="size-5 text-primary" aria-label="current step" />;
  return <Circle className="size-5 text-muted-foreground" aria-label="upcoming" />;
}
