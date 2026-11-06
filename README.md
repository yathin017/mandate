# Mandate

**The market-maker deal as an onchain program.** A project's tokens never leave its own Safe; the market maker gets a bounded *mandate* to quote them on 1inch Aqua, enforced by code and anchored to a Uniswap v4 TWAP.

Built for ETHGlobal Mumbai 2026.

- Product spec: [`.agents/README.md`](.agents/README.md)
- Verified facts and decisions: [`NOTES.md`](NOTES.md)

## Layout

| Path | What lives there |
|---|---|
| `config/chains/<chainId>.json` | External addresses per chain (Aqua, SwapVM router, v4 PoolManager, Safe, tokens). Adding a chain = adding a file here. |
| `deployments/<chainId>.json` | Addresses of our contracts, written by deploy scripts. |
| `contracts/` | Foundry project: quoter, Safe module, v4 oracle hook, tests, scripts. |
| `packages/` | Shared TypeScript packages (chain registry, SDK). |
| `apps/indexer` | Indexer worker + public API (Postgres, Redis, SSE). |
| `apps/web` | Dashboard (Vite + React + shadcn); reads only the indexer API. |
| `replay/` | Scenario export for the Replay Theater. |

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
isolation and the live-price circuit breaker. Token supply and oracle history in these tests are synthetic.

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

Segments 1–6 are implemented. Next: Segment 7's indexer, draft Postgres schema, Redis views and REST API.
Indexer stack and blocked-attempt ingestion choices remain for that gate's user review.
