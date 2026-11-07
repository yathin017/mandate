# Uniswap developer feedback — Mandate (ETHGlobal Mumbai 2026)

Mandate turns a token project's market-maker deal into an onchain program: the tokens stay in the issuer's Safe,
market makers trade under a treasury policy on 1inch Aqua + SwapVM, and **a Uniswap v4 pool with our hook is the
price and risk oracle every fill is checked against**. This file is our honest feedback on building that on v4.

What we built on v4 (details and line links in the README, *Partner integrations*):

- **`MandateOracleHook`** — extends OpenZeppelin's `BaseOracleHook` (uniswap-hooks v1.2.1) with `beforeAddLiquidity`
  to record each pool's initialisation time and the liquidity that existed *before* recent adds ("trusted
  liquidity"), so just-in-time liquidity cannot pass a depth check.
- **`UniswapV4MarketOracle`** — per pair: long and short TWAP from the hook's observations, spot from
  `StateLibrary.getSlot0`, trusted depth within ±band via `SqrtPriceMath`, and pool age.
- **`AnchorLauncher`** — permissionless: initialises the pool on the canonical PoolManager with our hook, grows the
  observation buffer, deploys the pair's oracle.
- Live on **Base mainnet** against the canonical PoolManager `0x498581fF718922c3f8e6A244956aF099B2652b2b`, with real
  fills priced and policed from the oracle.

## What worked well

- **Hooks are the right primitive for this.** Being able to observe initialise / add-liquidity / swap on the pool
  itself let us build a manipulation-aware oracle without trusting an off-chain feed.
- **`StateLibrary` and `SqrtPriceMath`.** Reading slot0 and active liquidity from another contract, and computing
  how much base moves the price by a band, was straightforward and exact for full-range positions.
- **OpenZeppelin `BaseOracleHook`** saved a lot of time: observation storage, `observe`, cardinality growth.
- **Singleton PoolManager.** One hook and one launcher serve every pair; launching a pool is cheap enough to do from
  a web wizard.

## Friction, and what would have helped

1. **Compiler pin.** `PoolManager.sol` is pinned to solc `0.8.26`; our project (and 1inch swap-vm v1.0.2) uses
   `0.8.30`, so we could not deploy a PoolManager inside unit or integration tests. Every v4 integration test runs
   on a mainnet fork instead (slower, needs an archive RPC). *Suggestion:* a `^0.8.26` build, or a published
   pre-compiled artifact / test helper that deploys the PoolManager from bytecode.
2. **Permissions in the hook address.** Adding one permission (`beforeAddLiquidity`) in our second version meant a
   new hook address and therefore new pools; pools on the old hook keep the old behaviour forever. That is by design,
   but it surprised us mid-build. *Suggestion:* call this out prominently in the hooks guide ("decide every flag you
   might need before launching pools"), next to the `HookMiner` instructions.
3. **Oracle history on a new pool.** A new pool stores one observation; after the first swap `observe(window)`
   reverts until a full window of history exists, and buffer growth only takes effect at the next swap. Anyone can
   trigger that state, which halts a consumer that requires a TWAP. We grow cardinality to 300 at launch and treat
   "no history" as paused. *Suggestion:* a short "oracle hook checklist" (cardinality vs window and block time,
   behaviour before the first full window).
4. **No notion of liquidity age.** Oracle consumers that size trades from depth are exposed to just-in-time
   liquidity. We track it ourselves in `beforeAddLiquidity` (liquidity before the adds within a settle window). A
   reference implementation in uniswap-hooks would help others avoid the same trap.
5. **Depth in a price band.** `SqrtPriceMath` is exact only while liquidity is constant across the band; for
   concentrated books you must walk initialised ticks. *Suggestion:* a periphery lens or library function
   "base/quote needed to move the price ±x%" that walks ticks correctly.
6. **Version pinning.** uniswap-hooks v1.2.1 vendors v4-core / v4-periphery at commit `d153b04` (v4.0.0 plus CI-only
   commits) rather than a tag, which took some digging to confirm. Tagged versions in the hooks repo's dependencies
   would make audits and reproducible builds easier.
7. **Scripting liquidity and swaps.** For deployment scripts and a demo on mainnet we used the
   `PoolModifyLiquidityTest` / `PoolSwapTest` routers because `PositionManager`'s action encoding is heavy to hand-roll
   in a script (the web app does use the canonical PositionManager). A small, documented script-friendly router, or
   copy-paste examples of PositionManager calls from Foundry and viem, would close that gap.
8. **Truncated vs untruncated series.** `BaseOracleHook` keeps both; which one to read for a manipulation-resistant
   TWAP was not obvious. We read the untruncated series and deploy with `maxAbsTickDelta = MAX_TICK`. A paragraph on
   the trade-off would help.

## Docs we wished existed

- An end-to-end "hook as an oracle for another protocol" example: launch pool with hook → grow buffer → read TWAP
  and depth from a third contract → fail safe before history exists.
- Base mainnet addresses (PoolManager, PositionManager, StateView) together on one page with the chain's block time
  and recommended oracle cardinality.
