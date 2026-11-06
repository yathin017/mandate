# NOTES

Verified facts, decisions and spec conflicts. Every entry names its source. If this file and
`.agents/README.md` disagree, this file reflects what the code/chain actually does.

Last verified: Nov 6, 2026, mainnet block ~26,355,100. Updated after Segment 3.

---

## 1. Canonical deployments (Ethereum mainnet)

| Contract | Address | How verified |
|---|---|---|
| Aqua | `0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a` | `aqua/deployments.md` (v1.0.1+); code present; router's `AQUA()` returns it |
| AquaSwapVMRouter | `0x111111338c5091e8440b67B168Bae16a668ac0dE` | same file; `eip712Domain()` → name `"1inch SwapVM v1.0"`, version `"1.0.2"`; owner `0x5AFc…338D` |

Same addresses on all 17 chains listed in `aqua/deployments.md` (deterministic deploys), which makes
adding chains a config-only change (`config/chains/<chainId>.json`).

Other routers seen on mainnet, **not used**:

| Address | `eip712Domain` | Aqua it points to | Note |
|---|---|---|---|
| `0x8fdd04dbf6111437b44bbca99c28882434e0958f` | `AquaSwapVMRouter` / `1.0.0` | `0x4999…6d31` | Developer release quoted in the spec |
| `0x3c4758979ec30ca45857cabc2462a70699ed790e` | `1inch SwapVM v1.0` / `1.0.1` | `0x4a05…A580` | swap-vm v1.0.2 tag's broadcast file |

> **Conflict with spec §8:** the spec lists Aqua `0x4999…` and SwapVM `0x8fdd…`. Those are the old
> developer release. We use the canonical `0x1111…` pair.

## 2. Pinned source versions

| Dep | Pin | Why |
|---|---|---|
| swap-vm | `v1.0.2` (`32c687c`) | Matches deployed router's EIP-712 version `1.0.2` |
| aqua | `0.1.0` (`b51f3b6`) | What swap-vm v1.0.2 builds against; diff to v1.0.1 is formatting only |
| solidity-utils | `6.9.7` | swap-vm v1.0.2 dependency |
| openzeppelin-contracts | `v5.4.0` | swap-vm v1.0.2 dependency |
| forge-std | `v1.11.0` | swap-vm v1.0.2 dependency |
| uniswap-hooks (OZ) | `v1.2.1` (`acbd604`) | Latest stable; ships `BaseOracleHook` |
| v4-core / v4-periphery | nested in uniswap-hooks (`d153b04` = v4.0.0 + 19 CI-only commits) | The revision OZ tests the hook against |
| solc | `0.8.30`, via-IR, 700 runs | swap-vm v1.0.2 `foundry.toml` |

**Do not use swap-vm `main`.** It moved to a library layout and reordered opcodes on Oct 22, 2026
(commit `9abc6ca`). Its opcode numbers do not match the deployed router. Any SDK we use must target
router `1.0.2` (check before using `@1inch/swap-vm-sdk`). `@1inch/swap-vm` is not on npm.

## 3. SwapVM program format (router 1.0.2)

- Instruction = `[uint8 opcode][uint8 argsLength][args]`. Args ≤ 255 bytes → **Extruction gets
  ≤ 235 bytes** after its 20-byte target. Source: `swap-vm/src/libs/VM.sol` `runLoop`.
- Opcode = index in the router's opcode table (`src/opcodes/AquaOpcodes.sol`), after dropping the
  leading placeholder. Verified by `test/unit/AquaProgram.t.sol`.

| # | Instruction | # | Instruction |
|---|---|---|---|
| 10 | jump | 20 | salt |
| 11 | jumpIfTokenIn | 21 | flatFeeAmountInXD |
| 12 | jumpIfTokenOut | 27 | protocolFeeAmountInXD |
| 13 | deadline | 28 | aquaProtocolFeeAmountInXD |
| 14 | onlyTakerTokenBalanceNonZero | 29 | dynamicProtocolFeeAmountInXD |
| 15 | onlyTakerTokenBalanceGte | 30 | aquaDynamicProtocolFeeAmountInXD |
| 16 | onlyTakerTokenSupplyShareGte | 31 | peggedSwapGrowPriceRange2D |
| 17 | **xycSwapXD** | 32 | **extruction** |
| 18 | xycConcentrateGrowLiquidity2D | 33 | onlyTxOriginTokenBalanceNonZero |
| 19 | decayXD | | |

No LimitSwap, oracle adjusters or `InvalidateTokenOut` on this router (matches REPORT.md §4).

## 4. Extruction interface (router 1.0.2)

Source: `swap-vm/src/instructions/Extruction.sol`.

```solidity
function extruction(
    bool isStaticContext, uint256 nextPC,
    SwapQuery calldata query,        // orderHash, maker, taker, tokenIn, tokenOut, isExactIn
    SwapRegisters calldata swap,     // balanceIn, balanceOut, amountIn, amountOut, amountNetPulled
    bytes calldata args, bytes calldata takerData
) external [view] returns (uint256 updatedNextPC, uint256 choppedLength, SwapRegisters memory updatedSwap);
```

- `IStaticExtruction` (view) is called on quote, `IExtruction` on swap. Same selector, so **one
  function** serves both; write storage only when `isStaticContext == false` (the quote path uses
  STATICCALL). Verified on the live router by `test/fork/AquaFill.fork.t.sol`.
- Balances registers are pre-loaded from `Aqua.safeBalances` before the program runs.
- Return `nextPC` unchanged and `choppedLength = 0` unless consuming taker args.

## 5. Aqua mechanics

Source: `aqua/src/Aqua.sol`, `swap-vm/src/SwapVM.sol`. Verified on fork.

- `ship(app, strategy, tokens, amounts)`; `strategyHash = keccak256(strategy)`. For SwapVM,
  `strategy = abi.encode(order)` so **strategyHash == router.hash(order) == SwapQuery.orderHash**.
- Shipping an existing hash reverts (`StrategiesMustBeImmutable`); `dock` must list all tokens.
- Maker only approves Aqua. On fill Aqua `pull`s `tokenOut` from the maker wallet straight to the taker.
- Taker pays `tokenIn` by calling `Aqua.push(maker, router, orderHash, tokenIn, amount)` inside
  `preTransferInCallback` (see `test/utils/AquaTaker.sol`), or via the `useTransferFromAndAquaPush` trait.

## 6. Taker gating

> **Conflict with spec §5 / REPORT §4:** router 1.0.2 does not gate takers itself. Gating is the
> opt-in opcode 33 `onlyTxOriginTokenBalanceNonZero` placed in a strategy's program. Whether 1inch
> requires dApps to include it is policy, not code.

**Decision (Segment 2):** the fork demo omits opcode 33; the pitch mentions gating as a live-launch feature.

## 7. MandateQuoter design (decided in Segment 2)

Code: `contracts/src/quoter/MandateQuoter.sol`. Strategy program: `[Salt(nonce), Extruction(quoter, mandateId)]`.

1. **Identity, not just router gating.** `msg.sender == router` alone lets anyone ship their own strategy
   pointing at our quoter and burn a mandate's cap through the real router. The quoter also requires
   `query.maker == mandate.safe` and `query.orderHash == mandate.activeStrategyHash` (set by the module
   on every reship), plus the exact base/quote pair. Tested in unit, integration and griefing tests.
2. **State keyed by `mandateId`**, since `orderHash` changes on every reship.
3. **Args = 32-byte `mandateId` only** (fits the 235-byte limit); terms are read from the registry.
4. **Pricing and spread inside the quoter** (not opcode 21): constant product over Aqua balances with the
   spread taken from the gross input. One place for pricing and fee accounting.
5. **Fees accrue per token, in tokenIn:** quote on sells, base on buybacks. Converting to one unit
   would need a price assumption. Payout accounting (`mmFeeShareBps`, paid amounts) belongs to the module.
6. **Prices are `quoteRaw * 1e36 / baseRaw`.** Decimal-agnostic and precise for sub-cent tokens.
   UI converts with token decimals.
7. **Anchor check uses the execution price, both directions** (spec says "Aqua price"). That bounds both
   a drifted pool and large price impact. `anchorStatus()` reports the Aqua *spot* price for the UI.
   Consequence: a single fill's impact plus spread must stay inside `maxAnchorDeviationBps`, so the
   module should require `spreadBpsMax < maxAnchorDeviationBps`.
8. **Floor, epoch cap and release apply to sells only.** Buybacks subtract from both counters, floored at 0.
9. **Epochs count from `releaseStart`.** Effective cap = `min(params.epochCap, bounds.maxEpochCap)` as
   defence in depth.
10. **Quote reverts exactly like swap**, so takers and the UI see the blocking rule before sending a tx.
11. **Errors carry more context than the spec** for plain-language UI copy, e.g.
    `EpochCapReached(used, requested, cap)`, `ReleaseExceeded(totalNetSold, requested, released)`,
    `AnchorDeviation(price, twap, deviationBps, maxBps)`.

### For Segment 4 (MandateModule)

- **Every (re)ship needs a fresh salt.** Aqua never re-ships a docked hash (`StrategiesMustBeImmutable`).
- The module must implement `IMandateRegistry.getMandate` and update `activeStrategyHash` atomically with
  dock + ship.
- Validate on create/update: `epochLength > 0`, `spreadBpsMin <= spreadBpsMax < maxAnchorDeviationBps`,
  `spreadBpsMax < 10_000`, `anchor != 0`, `quoter` = the deployed MandateQuoter.

## 8. Uniswap v4 anchor (Segment 3)

Code: `src/hook/MandateOracleHook.sol`, `src/anchor/UniswapV4TwapAnchor.sol`.

- **Canonical PoolManager** `0x000000000004444c5dc75cB358380D2e3dE08A90` (mainnet). `PoolManager.sol` is pinned to
  solc `0.8.26`, so it cannot compile in our 0.8.30 project; v4 integration tests run on the fork only.
  The adapter's maths has offline unit tests with a mock observer.
- **Hook** = OZ `BaseOracleHook` (Panoptic-derived oracle). Flags: `afterInitialize | beforeSwap`; must live at an
  address with exactly those low bits (tests use `deployCodeTo`; deploy scripts will mine a CREATE2 salt with
  v4-periphery `HookMiner`). One hook serves many pools.
- **Plain (untruncated) TWAP.** The hook also keeps a truncated series that caps per-block tick moves. We use the
  plain geometric-mean TWAP (Uniswap v3 style): with a 30-min window, manipulation must hold a price for many
  blocks, and the truncated series lags real crashes, which would keep a stale treasury price "in band" for longer.
  The hook is deployed with `maxAbsTickDelta = MAX_TICK` so the truncated series does nothing.
- **Observation buffer must cover the window.** A new pool stores 1 observation. One swap then wipes the history,
  and `observe(window)` reverts until a full window passes, which halts trading (fail-safe, but anyone can trigger
  it). Writes happen at most once per block, so the buffer needs ≥ window / block time entries: 30 min / 12 s = 150.
  **Use 300.** Growth takes effect at the next swap. Tested by `test_insufficientHistory_haltsTrading`.
- **Price units:** adapter converts `TickMath.getSqrtPriceAtTick(meanTick)` to `quoteRaw * 1e36 / baseRaw`, inverting
  when base is `currency1`. Below 1e-36 the value rounds to 0, so `consult` **reverts** (`PriceOutOfRange`) rather
  than return 0.
- **Any failure blocks trading.** Unknown pair, zero window, missing history and out-of-range price all revert, and
  the quoter propagates the revert.

> **Conflict with spec §11 Act 2:** "the attacker pumps the v4 pool first and tries to sell to the treasury →
> AnchorDeviation" does not happen with a TWAP anchor, and that is by design: a same-block pump moves v4 spot but
> not the TWAP (`test_flashPump_doesNotMoveAnchor`). What the anchor does block is a **sustained** market move that
> leaves the treasury's Aqua price stale: after the v4 price falls to 0.30 and holds for the window, dumpers cannot
> sell into the treasury at 0.40; when the market recovers, the same trade fills
> (`test_sustainedCrash_blocksStaleExit_thenRecovers`). The Act 2 script should use this sequence. Adding a
> v4 spot-vs-TWAP circuit breaker is possible later if we also want to pause during the pump itself.

## 9. Infra

- RPC: `https://eth.drpc.org` serves archive state at the pinned block. `ethereum-rpc.publicnode.com`
  (403, needs token), `rpc.flashbots.net` (pruned), `1rpc.io` (discontinued) do not.
- Fork block `26355000` (in `config/chains/1.json`). Foundry caches fork state after the first run (the first v4
  fork run takes about 2 min).
- Foundry does not read the repo-root `.env`; use `pnpm contracts:test` / `pnpm fork`.
