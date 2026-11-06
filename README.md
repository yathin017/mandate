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
| `apps/` | Runnable services (indexer API, web app). |
| `replay/` | Scenario export for the Replay Theater. |

## Requirements

Foundry ≥ 1.7, Node ≥ 24, pnpm 10.

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

The quoter, v4 anchor and Safe module are implemented. Next: deterministic scenario scripts and replay JSON
(Acts 1–3 in the product spec), followed by the Replay Theater.
