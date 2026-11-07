import { CheckCircle2, Circle, CircleDot } from "lucide-react";
import { useSearchParams } from "react-router";
import type { Address } from "viem";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SafeStep } from "@/onboarding/SafeStep";
import { AnchorStep, useAnchorStatus } from "@/onboarding/AnchorStep";
import { ModuleStep } from "@/onboarding/ModuleStep";
import { PolicyStep } from "@/onboarding/PolicyStep";
import { StrategyStep } from "@/onboarding/StrategyStep";
import { TokenStep } from "@/onboarding/TokenStep";
import { useTokenInfo } from "@/onboarding/useTokenInfo";
import { useSafeCheck } from "@/onboarding/useSafeCheck";
import { useSafePolicy } from "@/onboarding/useSafePolicy";
import { cn } from "@/lib/utils";
import { demoChain, isLive } from "@/wallet/config";

type StepState = "done" | "current" | "upcoming";

/**
 * Self-serve launch: Safe → tokens → module → anchor and liquidity → treasury policy → strategy (proposed to a market
 * maker, or added directly). Choices live in the URL (?safe=…, ?mm=…, and the reviewed policy and terms), so every
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
  const moduleDone = tokensDone && check.moduleEnabled;
  const safePolicy = useSafePolicy(moduleDone ? (safe as Address) : null, tokensDone ? (base as Address) : null);
  const policy = safePolicy.data ?? null;
  const anchor = useAnchorStatus(
    tokensDone ? (base as Address) : null,
    tokensDone ? (quote as Address) : null,
    policy ? Number(policy.config.oracle.twapWindow) : undefined,
  );
  // An oracle on an empty pool is meaningless: the step is done once the pool has liquidity too.
  const anchorDone = Boolean(anchor.data?.anchor && anchor.data.liquidity > 0n);
  const display = (info: typeof baseCheck.info) => (info?.ok ? { symbol: info.symbol, decimals: info.decimals } : { symbol: "?", decimals: 18 });
  const policyDone = Boolean(policy && policy.quote.toLowerCase() === quote?.toLowerCase());
  const strategyDone = Boolean(policy?.strategies.some((s) => s.status !== 3));
  const tokenRef = (info: typeof baseCheck.info) => (info?.ok ? { address: info.address, symbol: info.symbol, decimals: info.decimals } : null);
  const baseRef = tokenRef(baseCheck.info);
  const quoteRef = tokenRef(quoteCheck.info);

  const select = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const steps: { title: string; description: string; state: StepState; body?: React.ReactNode; waitingFor?: string }[] = [
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
    {
      title: "Enable Mandate",
      description: "The Safe's owners turn on the Mandate module.",
      state: moduleDone ? "done" : tokensDone ? "current" : "upcoming",
      body: safe ? <ModuleStep safe={safe as Address} check={check} /> : undefined,
    },
    {
      title: "Price anchor",
      description: "A Uniswap v4 pool with the oracle hook, and liquidity in it.",
      // Independent of the module: anyone can launch the anchor while owners approve.
      state: anchorDone ? "done" : tokensDone ? "current" : "upcoming",
      body: tokensDone ? (
        <AnchorStep
          base={base as Address}
          quote={quote as Address}
          baseToken={display(baseCheck.info)}
          quoteToken={display(quoteCheck.info)}
          {...(safeDone ? { safe: safe as Address } : {})}
          holdings={{ base: baseCheck.balance, quote: quoteCheck.balance }}
          lpParam={params.get("lp")}
          onLp={(encoded) => select("lp", encoded)}
          {...(policy ? { window: Number(policy.config.oracle.twapWindow) } : {})}
        />
      ) : undefined,
    },
    {
      title: "Treasury policy",
      description: "Release, limits shared by every strategy, price rules and market-risk thresholds. All yours to set.",
      state: policyDone ? "done" : moduleDone && anchor.data?.anchor ? "current" : "upcoming",
      waitingFor: !tokensDone ? "the token pair is set (step 2)" : !moduleDone ? "the Mandate module is enabled on the Safe (step 3)" : "the price anchor is launched (step 4)",
      body:
        moduleDone && anchor.data?.anchor && baseRef && quoteRef ? (
          <PolicyStep
            safe={safe as Address}
            threshold={check.threshold}
            base={baseRef}
            quote={quoteRef}
            oracle={anchor.data.anchor}
            holdings={baseCheck.balance !== undefined ? { base: baseCheck.balance } : {}}
            policy={policy}
            policyParam={params.get("policy")}
            onPolicy={(encoded) => select("policy", encoded)}
            onCreated={() => {
              select("policy", null);
              void safePolicy.refetch();
            }}
          />
        ) : undefined,
    },
    {
      title: "Strategy",
      description: "A market maker runs it under the policy: proposed and signed, or added directly.",
      state: strategyDone ? "done" : policyDone ? "current" : "upcoming",
      waitingFor: "the treasury policy is created (step 5)",
      body:
        policyDone && policy && baseRef && quoteRef ? (
          <StrategyStep
            safe={safe as Address}
            threshold={check.threshold}
            base={baseRef}
            quote={quoteRef}
            policy={policy}
            anchorPriceX36={anchor.data?.spotPriceX36}
            termsParam={params.get("terms")}
            onTerms={(encoded) => select("terms", encoded)}
            onCreated={() => {
              select("terms", null);
              void safePolicy.refetch();
            }}
            mode={params.get("mode") === "direct" ? "direct" : "propose"}
            onMode={(m) => select("mode", m === "direct" ? "direct" : null)}
            mm={params.get("mm")}
            onMm={(m) => select("mm", m)}
          />
        ) : undefined,
    },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-serif text-3xl font-semibold tracking-tight">Launch</h1>
        <p className="text-muted-foreground">
          Set up market making for your own token on {demoChain.name}. Every step is a transaction you sign; nothing is custodial.
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
              {step.state === "upcoming" && step.waitingFor && (
                <CardContent className="text-sm text-muted-foreground">Opens once {step.waitingFor}.</CardContent>
              )}
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
