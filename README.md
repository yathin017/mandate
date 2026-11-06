# Mandate

**The market-maker deal as an onchain program.** A project's tokens never leave its own Safe. The Safe sets one
**treasury policy** per token (release schedule, per-period sell and buyback limits, price rules, and market-risk
thresholds read from a Uniswap v4 oracle), and market makers run **strategies** under it on 1inch Aqua, inside
bounds the issuer sets. Every fill is checked by code; every refusal is public.

Built for ETHGlobal Mumbai 2026.

**One place for new token issuers and market makers on Base:**

| Issuers | Market makers |
|---|---|
| Launch a fixed-supply token straight into a Safe (TokenFactory) | Publish a profile in the marketplace |
| Open a Uniswap v4 pool and its market oracle (AnchorLauncher), seed liquidity | Are ranked by an onchain-only score (availability, execution vs the market, volume, reliability, responsiveness) |
| Set the treasury policy: every value is the issuer's, nothing is pre-filled | See the policy they would trade under before accepting |
| Pick a market maker by score and propose a strategy | Accept a strategy by signing its exact terms (EIP-712, no gas) |
| Owners add it through the Safe; pause, edit the policy or revoke any time | Operate inside the bounds and what the Safe can back; claim their fee share directly |
| Track shared limits, release, risk mode, fills, execution quality, MM pay, refusals | Track volume, execution quality, earned and claimable fees, refusals |

**What the v2 model closes.** Strategies share one policy, so extra strategies, reships and buy-sell round trips
cannot reset or multiply the budget (gross and net sell limits). Every ship checks the Safe actually holds what all
its live strategies promise. The oracle reports spot, long and short TWAPs, *trusted* depth (liquidity added within
a settle window does not count) and pool age; the quoter turns these into Normal, Defensive or Paused against the
issuer's thresholds, with per-mode fill caps, minimum spread and buyback permission. A strategy's pre-trade price
must sit near the TWAP (no stale quotes), separately from per-fill price impact. Design: [`NOTES.md` §18](NOTES.md).

- Product spec: [`.agents/README.md`](.agents/README.md)
- Verified facts and decisions: [`NOTES.md`](NOTES.md)

## Layout

| Path | What lives there |
|---|---|
| `config/chains/<chainId>.json` | External addresses per chain (Aqua, SwapVM router, v4 PoolManager, Safe, tokens). Adding a chain = adding a file here. |
| `deployments/<chainId>.json` | Addresses of our contracts, written by deploy scripts. |
| `contracts/` | Foundry project: quoter, Safe module (policies and strategies), v4 oracle hook and market oracle, tests, scripts. |
| `packages/` | Shared TypeScript packages (chain registry, SDK). |
| `apps/indexer` | Indexer worker + public API (Postgres, Redis, SSE). |
| `apps/web` | Dashboard, wallet flows and the self-serve onboarding wizard (Vite + React + shadcn). Dashboards read the indexer API; wallet flows read the chain. |
| `replay/` | Scenario export behind the demo fork (`pnpm replay:serve`) and the indexer tests. |

## Requirements

Foundry ≥ 1.7, Node ≥ 24, pnpm 10.

Install the pinned JavaScript dependencies with `pnpm install --frozen-lockfile`.

## Contract verification

```sh
# Offline unit and integration suites; fork suites skip without MAINNET_RPC_URL.
pnpm contracts:test

# Include canonical Safe, Aqua, SwapVM and v4 contracts at the pinned mainnet block.
# Alternatively, copy .env.example to .env; the pnpm script loads it.
MAINNET_RPC_URL=https://eth.drpc.org pnpm contracts:test
```

The module fork suite creates a 2-of-2 Safe through the canonical factory and signs issuer transactions with
generated test keys. It verifies token transfers, direct MM fee claims, reshipping, pause/revoke, cross-Safe
isolation and the market-risk pause on a live v4 pool. The market-risk suite drives a real hooked pool through a
flash pump, a sustained crash, just-in-time liquidity and a too-young pool. Token supply and oracle history in these
tests are synthetic.

## Platform lifecycle test

`apps/indexer/test/lifecycle.test.ts` runs the whole platform on the local fork with the real contracts, API, indexer
and prober: a TokenFactory launch funding a new 2-of-2 Safe, the module, an anchor with seeded and settled liquidity,
the treasury policy, a listed market maker, a strategy proposal, the market maker's signed acceptance, execution
through the Safe, a taker trade, then both sides' analytics (including execution quality) and a scored market maker. Run it with the indexer suite (`pnpm indexer:test`, see `apps/indexer/README.md`).

## Scenario replay

```sh
pnpm replay:run
pnpm replay:test
pnpm replay:verify
```

This starts a fresh local Anvil fork, deploys the demo, broadcasts Acts 1–3 and exports
[`replay/data/acts.json`](replay/data/acts.json) plus actual transaction receipts. The generated
[`deployments/1.json`](deployments/1.json) describes a **local fork of mainnet**, with runtime chain id 31337.
See [`replay/README.md`](replay/README.md) for the scenario inputs, evidence format and synthetic-data disclosures.

## Shared packages

```sh
pnpm packages:build
pnpm packages:typecheck
pnpm packages:test
pnpm generate:check
pnpm sdk:test:fork
```

- [`@mandate/chains`](packages/chains/README.md): validated source-chain configuration and runtime deployment registry.
- [`@mandate/sdk`](packages/sdk/README.md): generated ABIs, reads with block provenance, quotes, prepared calls,
  exact price units and shared plain-language error mapping.

The replay exporter uses the SDK error mapper. `sdk:test:fork` runs the complete replay plus live SDK tests
against a fresh local fork; all temporary nodes are stopped afterward.

## Live on Base mainnet

**v2 (policies and strategies)** is deployed by `contracts/script/live/DeployBase.s.sol`: module and quoter, oracle hook,
AnchorLauncher, and a demo pair with mock tokens, a 2-of-2 issuer Safe, its policy and one market-making strategy. It
writes [`deployments/8453.json`](deployments/8453.json) and keeps the existing TokenFactory
([`0x32feE1f159E80eE007B0d750d4eb47A513e40311`](https://basescan.org/address/0x32feE1f159E80eE007B0d750d4eb47A513e40311)).
Until it is broadcast, the app has no Base deployment registered.

**v1 (single mandates)** ran on Base from block 53927227 with mock tokens against the canonical Aqua, SwapVM router,
Uniswap v4 PoolManager and Safe 1.4.1; its manifest is archived in
[`deployments/archive/8453-v1.json`](deployments/archive/8453-v1.json). It took real fills through the canonical
router ([buy](https://basescan.org/tx/0x32d0ac09f07a57c109cad6fc9f64ed3cb824456a86e36de89db5202b146c8e1b),
[buyback](https://basescan.org/tx/0x9d1c4c6905a8c2c9bc14b5f166895b1e4c7592dfd2a5841a6486ca1d8541f4e1)), an MM
[reship](https://basescan.org/tx/0xdf020edf1fabe4445f203a2f8257c263fc59fe2cb7f821edeb80e67c2fedc461) and
[fee claim](https://basescan.org/tx/0xc206be514f7091f50db3c35322708874184fc860dc3e87bbe92205083a155f07), a
[revoke](https://basescan.org/tx/0x1a39831c68cc3bb572d75e880d73804ddffae92f121c710e036c9d7f2db443d2), and a self-serve
onboarding with a 2-of-2 Safe where one owner used scripts and the other the wizard
([createMandate](https://basescan.org/tx/0xf3745211cf11f308d8400d6e894cd5aa2205b5940fabaa6c59cf8ab138f1a4f3)).

**Self-serve.** `/launch` takes a project from nothing to a live strategy, each step a transaction its own wallets
sign: treasury Safe, token pair, enable the module, launch the anchor and add liquidity, set the treasury policy, then
propose a strategy to a market maker (or add one directly). Co-owners approve from a shared link, in the browser or with
`apps/web/scripts/approve-terms.ts`.

Scripts: `contracts/script/live/` (`DeployBase`, `LiveFills`, `RotateRoles`, `OnboardPair`, `DeployTokenFactory`).
Run the Base stack with `pnpm base:worker`, `pnpm base:server` and `pnpm base:web`.
