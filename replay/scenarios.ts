export const SCENARIOS = [
  {
    act: 1, title: "The token-loan counterfactual", label: "SYNTHETIC COUNTERFACTUAL",
    disclosure: "Separate 10M LAUNCH allocations. The traditional MM sells into a separate v4 pool. This is not a replay of MOVE or a claim about Binance price impact.",
    allottedBase: "10000000000000000000000000", epochCap: "50000000000000000000000",
  },
  {
    act: 2, title: "Repeated sells and price manipulation", label: "SYNTHETIC",
    disclosure: "150 equal intents totaling 134.1M synthetic LAUNCH, followed by pump/crash/recovery. Not historical FUN transaction sizes, times, routing or 111.5 ETH proceeds. All quote amounts are synthetic USDC.",
    allottedBase: "134100000000000000000000000", epochCap: "1341000000000000000000000",
  },
  {
    act: 3, title: "The MM at work", label: "SYNTHETIC",
    disclosure: "Real fork calls demonstrate bounded tuning, custody restrictions, fee claims and signed Safe revocation.",
    allottedBase: "10000000000000000000000000", epochCap: "50000000000000000000000",
  },
];

export function stepDescription(act: number, step: number) {
  if (act === 1) {
    if (step === 0) return { kind: "approval", label: "Traditional MM approves the pool" };
    if (step === 1) return { kind: "traditional-sell", label: "Traditional MM sells its entire 10M loan", requestedBase: "10000000000000000000000000" };
    if (step >= 10 && step <= 15) return { kind: "treasury-sell", label: `Mandate sale ${step - 9}`, requestedBase: "10000000000000000000000" };
  }
  if (act === 2) {
    if (step >= 1 && step <= 150) return { kind: "treasury-sell", label: `Synthetic sell intent ${step}/150`, requestedBase: "894000000000000000000000" };
    const special: Record<number, { kind: string; label: string; requestedBase?: string }> = {
      200: { kind: "market-move", label: "Pump v4 spot from $0.40 to $0.60" },
      201: { kind: "treasury-sell", label: "Try a fill during the pump", requestedBase: "1000000000000000000000" },
      202: { kind: "market-move", label: "Arbitrage v4 spot back to $0.40" },
      203: { kind: "treasury-sell", label: "The recovered market fills again", requestedBase: "1000000000000000000000" },
      210: { kind: "market-move", label: "Crash v4 to $0.30 and hold for a TWAP window" },
      211: { kind: "treasury-buyback", label: "Block a stale-price exit after the sustained crash", requestedBase: "1000000000000000000000" },
      212: { kind: "market-move", label: "Restore $0.40 and wait a TWAP window" },
      213: { kind: "treasury-buyback", label: "Buyback fills after the average recovers", requestedBase: "1000000000000000000000" },
    };
    if (special[step]) return special[step];
  }
  if (act === 3) {
    const kinds = ["reship", "treasury-sell", "reship", "custody-attempt", "fee-claim", "pause", "treasury-sell", "unpause", "treasury-sell", "revoke", "fee-claim", "reship"];
    const labels = ["Tighten spread from 80 to 30 bps", "Earn fees on a fill", "Try to exceed the issuer's cap", "Try to transfer tokens from the Safe", "Claim earned fees directly", "MM pauses the mandate", "A paused mandate refuses fills", "Two Safe owners sign to resume", "Earn fees on another fill", "Two Safe owners sign to revoke", "Claim fees earned before revocation", "A revoked mandate refuses reshipping"];
    if (kinds[step]) return { kind: kinds[step], label: labels[step], ...([1, 6, 8].includes(step) ? { requestedBase: "1000000000000000000000" } : {}) };
  }
  throw new Error(`Unknown scenario step ${act}/${step}`);
}
