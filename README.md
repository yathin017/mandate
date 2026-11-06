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
| `apps/web` | Dashboard, wallet flows and the self-serve onboarding wizard (Vite + React + shadcn). Dashboards read the indexer API; wallet flows read the chain. |
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
PoolManager and Safe 1.4.1. Source of truth: [`deployments/8453.json`](deployments/8453.json).

| Contract | Address |
|---|---|
| MandateModule | [`0xC10ED38aDfB53c5E1262194d4Db420f6Fa82544d`](https://basescan.org/address/0xC10ED38aDfB53c5E1262194d4Db420f6Fa82544d) |
| MandateQuoter | [`0xBb259F8DB3A9d3A48989cfb9B970D0B481aEd6D8`](https://basescan.org/address/0xBb259F8DB3A9d3A48989cfb9B970D0B481aEd6D8) |
| MandateOracleHook | [`0x30Ff096F8582363807a9b5Cb15b84E7d98371080`](https://basescan.org/address/0x30Ff096F8582363807a9b5Cb15b84E7d98371080) |
| UniswapV4TwapAnchor | [`0x9B78f6553A921D1bea0722CAd111CDAE4299522B`](https://basescan.org/address/0x9B78f6553A921D1bea0722CAd111CDAE4299522B) |
| AnchorLauncher | [`0x5551b2f6a48f86328981EEFD78138dec340C29fB`](https://basescan.org/address/0x5551b2f6a48f86328981EEFD78138dec340C29fB) |
| TokenFactory | [`0x32feE1f159E80eE007B0d750d4eb47A513e40311`](https://basescan.org/address/0x32feE1f159E80eE007B0d750d4eb47A513e40311) |
| Issuer Safe (2-of-2) | [`0xf1528F50A58b95E75F7a2304Ab52618ACDDA7D4d`](https://basescan.org/address/0xf1528F50A58b95E75F7a2304Ab52618ACDDA7D4d) |
| mLAUNCH / mUSD | [`0x66e185Dd1a99B36E955b8966fd8BbC430Cc64e8a`](https://basescan.org/token/0x66e185Dd1a99B36E955b8966fd8BbC430Cc64e8a) / [`0x6f0f1764A727E1e160D4735cc656ddaeBE2879C9`](https://basescan.org/token/0x6f0f1764A727E1e160D4735cc656ddaeBE2879C9) |
| Active mandate | `0xb699954439ee4a37cde5dc2b21f8bcfe8458d78977cc7d4e99a2b16886a2bde8` |

**TWAP pool.** Uniswap v4 pools are not contracts: they live inside the singleton
[PoolManager `0x498581fF718922c3f8e6A244956aF099B2652b2b`](https://basescan.org/address/0x498581fF718922c3f8e6A244956aF099B2652b2b)
and are identified by a PoolId. The mLAUNCH/mUSD anchor pool is PoolId
`0x5c3b24653373b7140cb57a53a28d5ab38cb5eb5c3c18dc3cc28fc5c214eea83c` (fee 0.3%, tick spacing 60, hook
`MandateOracleHook`, full-range liquidity, 300-slot observation buffer), seeded at 0.40 mUSD per mLAUNCH. The anchor
adapter's `POOL_ID()` returns this id.

**Testing wallets** (Base mainnet):

| Role | Address |
|---|---|
| Safe Owner 1 (also deployer and demo taker) | `0x54f75F0E0da2b43b3a6AC0a0e5c4f5Df6B73308e` |
| Safe Owner 2 | `0x6a4fb4561051dD5B25619ab997152892008C7bF6` |
| Market Maker | `0xbDafcA30260a4a5550cAD1F11928b26f1B063126` |

**History.** The first mandate (`0xe41668bb…a6`, market maker `0x6D89…6B59`) took real fills through the canonical
router: [buy](https://basescan.org/tx/0x32d0ac09f07a57c109cad6fc9f64ed3cb824456a86e36de89db5202b146c8e1b),
[buyback](https://basescan.org/tx/0x9d1c4c6905a8c2c9bc14b5f166895b1e4c7592dfd2a5841a6486ca1d8541f4e1),
MM [reship](https://basescan.org/tx/0xdf020edf1fabe4445f203a2f8257c263fc59fe2cb7f821edeb80e67c2fedc461) and
[fee claim](https://basescan.org/tx/0xc206be514f7091f50db3c35322708874184fc860dc3e87bbe92205083a155f07).
It was then [revoked](https://basescan.org/tx/0x1a39831c68cc3bb572d75e880d73804ddffae92f121c710e036c9d7f2db443d2),
the [current mandate created](https://basescan.org/tx/0x9aa05ccc1455fd40a491333716bcaa3b4df847ca35c4371edf0b48a84b4f1f67)
for the Market Maker above, and Safe Owner 2 [swapped](https://basescan.org/tx/0x5e45689c1f616f3a134cf295f2b2b0809e171667e185602e17c97057d06775d8)
to the testing wallet, all as 2-of-2 Safe transactions.

**Self-serve anchors.** `AnchorLauncher.launch(base, quote, initialPriceX36)` creates the v4 pool for any ERC20
pair with the oracle hook (if missing), grows its observation buffer and deploys a TWAP anchor at a predictable
address; quotes work once the pool has 30 minutes of history. Liquidity is added with Uniswap's own tools. The demo
pair's pool above predates the launcher, so `anchorOf(mLAUNCH, mUSD)` is unset.

**Self-serve onboarding.** `/onboard` in the web app takes a project from nothing to a live mandate, each step a
transaction its own wallets sign: treasury Safe, token pair, enable the module, launch the anchor, create the mandate.
It was run on Base with a 2-of-2 Safe in which Owner 1 used scripts and Owner 2 the wizard in a browser wallet:

| | |
|---|---|
| Pair | Demo Nova [`dNOVA 0xB515…9A9B`](https://basescan.org/token/0xB515f7b4136D5282F2186838e02a19A156bC9A9B) / Demo Dollar [`dUSD 0x7F8a…C8a2`](https://basescan.org/token/0x7F8a933C627747Cd5A1B6b828FD48F1649C9C8a2) (mocks) |
| Issuer Safe (2-of-2, Owner 1 + Owner 2) | [`0xB88E30325557e7C7fD409F661C1C1060476C5456`](https://basescan.org/address/0xB88E30325557e7C7fD409F661C1C1060476C5456) |
| Anchor (from the launcher) | [`0xC4C94eB720C0536308f83ED7130F4009b67A8e7a`](https://basescan.org/address/0xC4C94eB720C0536308f83ED7130F4009b67A8e7a), PoolId `0x5312523f4a54811974afb6080b1747b875688420a8a5ff63d90e0d1f1ecddf5c`, full-range liquidity at 0.40 |
| Mandate | `0xeb3a5ead8f87fad3ff3879d381045bec7ff992a92179ec3699b5ea55c7c2a648` (Market Maker above) |

Owner 1's half (`OnboardPair`: tokens, Safe, anchor, liquidity, approval of `enableModule`) starts at block 53973676;
Owner 1 then [approved the mandate](https://basescan.org/tx/0xf66eb79c0d111374b68542e75c4a51dedb2507599a7345e3eb465243973ed564)
from the wizard's shared link with `apps/web/scripts/approve-terms.ts`. Owner 2 executed
[enableModule](https://basescan.org/tx/0x48ede66d8d0289ca70cd7f8f3de287a6b095a369b7b45d3ed60aa54703f90e23) and
[createMandate](https://basescan.org/tx/0xf3745211cf11f308d8400d6e894cd5aa2205b5940fabaa6c59cf8ab138f1a4f3) from the wizard.

Scripts: `contracts/script/live/` (`DeployBase`, `LiveFills`, `RotateRoles`, `DeployLauncher`, `OnboardPair`,
`DeployTokenFactory`). Run the Base stack with `pnpm base:worker`, `pnpm base:server` and `pnpm base:web`.
