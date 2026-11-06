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

## Live on Base mainnet

The contracts are also deployed on Base (chain 8453) with **mock tokens** (Mandate Demo Launch `mLAUNCH`,
Mandate Demo Dollar `mUSD`; owner-mintable, no value) against the canonical Aqua, SwapVM router, Uniswap v4
PoolManager and Safe 1.4.1. Addresses: [`deployments/8453.json`](deployments/8453.json).

| Contract | Basescan |
|---|---|
| MandateModule | [0xC10E…544d](https://basescan.org/address/0xC10ED38aDfB53c5E1262194d4Db420f6Fa82544d) |
| MandateQuoter | [0xBb25…D6D8](https://basescan.org/address/0xBb259F8DB3A9d3A48989cfb9B970D0B481aEd6D8) |
| MandateOracleHook | [0x30Ff…1080](https://basescan.org/address/0x30Ff096F8582363807a9b5Cb15b84E7d98371080) |
| UniswapV4TwapAnchor | [0x9B78…522B](https://basescan.org/address/0x9B78f6553A921D1bea0722CAd111CDAE4299522B) |
| Issuer Safe (2-of-2) | [0xf152…7D4d](https://basescan.org/address/0xf1528F50A58b95E75F7a2304Ab52618ACDDA7D4d) |

Real fills through the canonical router: [buy](https://basescan.org/tx/0x32d0ac09f07a57c109cad6fc9f64ed3cb824456a86e36de89db5202b146c8e1b),
[buyback](https://basescan.org/tx/0x9d1c4c6905a8c2c9bc14b5f166895b1e4c7592dfd2a5841a6486ca1d8541f4e1),
MM [reship](https://basescan.org/tx/0xdf020edf1fabe4445f203a2f8257c263fc59fe2cb7f821edeb80e67c2fedc461) and
[fee claim](https://basescan.org/tx/0xc206be514f7091f50db3c35322708874184fc860dc3e87bbe92205083a155f07).
Scripts: `contracts/script/live/` (`DeployBase`, `LiveFills`); run the Base stack with `pnpm base:worker`,
`pnpm base:server` and `pnpm base:web` (needs a keyed `BASE_INDEXER_RPC_URL`).
