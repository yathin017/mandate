# NOTES

Verified facts, decisions and spec conflicts. Every entry names its source. If this file and
`.agents/README.md` disagree, this file reflects what the code/chain actually does.

Last verified: Nov 6, 2026. Fork tests pin mainnet block 26,355,000. Updated through Segment 6.

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
  `preTransferInCallback` (see `src/mocks/AquaTaker.sol`), or via the `useTransferFromAndAquaPush` trait.

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

### Module integration requirements (implemented in Segment 4)

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

### Live-price circuit breaker

- The adapter also reads the pool's live tick through `StateLibrary.getSlot0`. If the resulting spot price is
  more than its immutable `MAX_SPOT_DEVIATION_BPS` from the TWAP, `consult` reverts with `SpotTwapDivergence`.
  The demo limit is 200 bps (2%). `snapshot(window)` reports spot, TWAP and deviation even when that breaker trips.
- **Act 2 now has two distinct protections:** a same-block pump to 0.60 leaves the TWAP near 0.40 but trips
  `SpotTwapDivergence`; after arbitrage restores spot, fills resume. A sustained crash to 0.30 eventually brings
  spot and TWAP together, so the breaker clears, but the quoter's `AnchorDeviation` still refuses fills at the
  stale treasury price. Recovery restores fills in both cases.
- Sources: `contracts/src/anchor/UniswapV4TwapAnchor.sol`, `test/unit/UniswapV4TwapAnchor.t.sol`, and
  `test/fork/V4Anchor.fork.t.sol` (`test_flashPump_tripsCircuitBreaker_thenRecovers` and
  `test_sustainedCrash_blocksStaleExit_thenRecovers`). The replay must map each actual error accurately.

## 9. Safe module (Segment 4)

Code: `contracts/src/module/MandateModule.sol`, `src/libraries/MandateStrategy.sol`.

- **One module for every Safe.** It deploys its own quoter in its constructor; the registry link and quoter target
  cannot be independently misconfigured. Mandate ids include chain id, module address, Safe and a per-Safe counter.
- **Issuer actions come from the Safe itself.** Owners authorize creation, bounds updates, unpause and revoke
  through Safe transactions. The MM may reship inside the rails, pause and claim fees; it is never a Safe module.
- **Quote inventory has an explicit rail:** `maxShippedQuote` caps the MM's requested virtual buyback inventory.
  `shippedBase` is capped at `allotment - totalNetSold`; reshipping never resets sell counters or accrued fees.
- **Direct claims, fixed share.** The MM claims its fraction of each token's cumulative fees, less prior claims.
  The fee share is fixed at creation and earned fees remain claimable after revoke. Claims still require the module
  to be enabled and the Safe to hold the owed tokens; there is no fee escrow or guaranteed solvency.
- **Revoke changes status before attempting to dock.** A disabled module cannot dock through Safe, but the Safe's
  signed transaction can still revoke in the registry. The quoter then rejects the still-shipped strategy.
- **Bounds updates clamp live spread and epoch cap.** Shipped-inventory rails are rechecked on the next reship;
  updating those rails alone does not dock or change existing Aqua virtual balances.
- **Canonical Safe:** singleton `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`, factory
  `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`. Verified against Safe's
  [SafeL2 deployment manifest](https://github.com/safe-global/safe-deployments/blob/main/src/assets/v1.4.1/safe_l2.json)
  and [factory manifest](https://github.com/safe-global/safe-deployments/blob/main/src/assets/v1.4.1/safe_proxy_factory.json).
- Fork/test ABI and EIP-712 signing helper are in `script/lib/SafeTransactions.sol`, verified against
  [Safe v1.4.1](https://github.com/safe-global/safe-smart-account/blob/v1.4.1/contracts/Safe.sol),
  [ModuleManager](https://github.com/safe-global/safe-smart-account/blob/v1.4.1/contracts/base/ModuleManager.sol), and
  [SafeProxyFactory](https://github.com/safe-global/safe-smart-account/blob/v1.4.1/contracts/proxies/SafeProxyFactory.sol).
  Proxy setup is atomic with creation; owner signatures are sorted by address and sign the Safe's current nonce.
- Coverage: `test/integration/MandateModule.integration.t.sol` covers the permission matrix offline with a mock Safe.
  `test/fork/MandateModule.fork.t.sol` exercises a real 2-of-2 Safe against canonical Aqua, SwapVM and v4, including
  both fee tokens, reship accounting, signer threshold and replay rejection, cross-Safe isolation, revoke after
  disabling the module, and a blocked fill during a live price pump. Mock token supply and time-warped oracle
  history are **SYNTHETIC**.
- Verification on Nov 6: `MAINNET_RPC_URL=https://eth.drpc.org forge test` from `contracts/` passed **104 tests**,
  with **0 failures and 0 skips**, including all 11 Safe-module fork tests. The offline suite passes 81 tests.

## 10. Deployment and replay (Segment 5)

- `DeployFork.s.sol` broadcasts normal contract creations to chain 31337. The hook uses a salt mined with the
  pinned v4-periphery `HookMiner` and the standard CREATE2 deployer proxy `0x4e59b44847b379578588920cA78FbF26c0B4956C`.
  The broadcast verifies its predicted address; no code injection is used. `SeedV4Pool.s.sol` seeds separate
  anchor and traditional-loan pools on the canonical PoolManager.
- Four canonical Safe proxies require two signatures each. Three hold independent mandate inventories for
  Acts 1–3; the fourth transfers a traditional 10M token loan to its MM through a signed Safe transaction.
  All scripts use Anvil's public development mnemonic and reject runtime chains other than 31337.
- **Manifest semantics:** `deployments/1.json` is a generated demo manifest for a fork **of** chain 1. It explicitly
  records `environment: local-mainnet-fork`, `chainId: 31337`, `sourceChainId: 1`, the pinned block and its hash.
  These are not deployed mainnet addresses or Etherscan transaction hashes.
- The zero-dependency Node 24 runner `replay/export.ts` owns its Anvil process, refuses an occupied loopback port,
  invokes the scripts, advances synthetic history and exports confirmed receipts and block-specific snapshots.
  General ABIs/client wrappers remain Segment 6 work.
- **Verified time-control detail:** Anvil's fixed block timestamp interval overrides `evm_increaseTime` in this
  workflow. The runner temporarily changes `anvil_setBlockTimestampInterval`, mines a block and checks the actual
  timestamp delta. It warms an hour of history initially and a full 1801 seconds after the crash/recovery phases.
  Source: the executed local RPC workflow and [Anvil's timestamp API](https://foundry-rs.github.io/foundry/anvil/eth/api/struct.EthApi.html).
- **Synthetic scenarios:** Act 1 uses a 50,000-LAUNCH cap so price impact stays in the 3% anchor band. Five 10,000
  fills succeed and the sixth is capped. Act 2 uses 150 equal 894,000-token intents totaling 134.1M LAUNCH, a
  separate 134.1M allocation and 1.341M epoch cap. One fills; the next full intent exceeds the remaining 447,000.
  This is not verified FUN transaction data, historical timing/routing or a reproduction of 111.5 ETH proceeds.
  Quote amounts are in synthetic 6-decimal sUSDC. The export uses explicit SYNTHETIC labels throughout.
- **Blocked-attempt evidence:** `ScenarioActor` catches an actual inner-call revert, verifies its selector and
  emits the complete bytes. Its outer transaction succeeds. Exported `outerReceiptStatus` and the top-level
  disclosure make this distinction explicit. Unexpected outcomes stop the scenario rather than create a row.
- Each replay snapshot is read from `DemoState.snapshot` at its attempt's receipt block, with block hash and
  function provenance. Raw receipts retain `Attempted`, `Filled`, Safe and ERC20 `Transfer` logs. Release, sell
  caps, custody, parameter changes and claims remain auditable after the runner stops its node.
- The end-to-end run produces **178 steps, including 156 blocked inner calls**. The complete Solidity suite
  passes **111 tests, 0 failures, 0 skips**. New unit tests ensure mismatched outcomes cannot be recorded as a
  success or expected block. **All 7 Node replay tests pass** and reconcile receipts, transfer amounts, Safe
  balances and sell counters. Two consecutive fresh-node runs produced byte-identical `acts.json`,
  `receipts.json` and `deployments/1.json`.
- `replay/README.md` documents commands, the draft export format and demo limitations. Segment 6 is next; no
  indexer schema, Redis implementation or web application is included in this segment.

## 11. Chain registry and SDK (Segment 6)

- `packages/chains` generates browser-compatible ESM data from the existing chain/deployment JSON. It validates
  ids, non-zero addresses, hashes, RPC env names, explorer URLs and fork disclosures. Lookup uses **runtime**
  chain ids: `getDeployment(31337)` returns the demo; `getDeployment(1)` rejects because no Mandate deployment
  is registered on mainnet. `getTransactionUrl(31337, hash)` returns no Etherscan link. Source-chain config
  remains separate from deployment context.
- `packages/sdk` uses exactly pinned **viem 2.57.16**, **TypeScript 5.9.3** and **Node 24 types 24.19.2**, with a
  committed pnpm lockfile. Both packages emit ESM and declarations under strict TypeScript settings; tests also
  typecheck against their published package entry points. Runtime source contains no Node-only APIs.
- `scripts/generate.ts` copies ABIs from freshly compiled Foundry artifacts, preserving tuple names, events and
  inherited errors. Exported constants cover the module, quoter, hook/anchor, Aqua, SwapVM/router, Safe, ERC20
  metadata/errors and demo evidence contracts. `pnpm generate:check` fails on stale generated files.
- **Quote ABI detail:** the router implementation's `quote` is not declared view, while its pinned `ISwapVM`
  interface exposes the same selector as view. The SDK uses that generated interface for read-only `eth_call`;
  the live integration confirms correct amounts and order hashes. No manually edited ABI mutability is used.
- `GenerateSdkFixtures.s.sol` derives taker-data and Aqua order-hash vectors from the pinned Solidity
  `TakerTraitsLib.build` and `MandateStrategy`. The SDK passes exact-byte comparisons for quote modes,
  threshold/deadline modes, zero threshold and uint256/uint40 maxima. Its EOA settlement uses transferFrom to
  the router, then Aqua.push; the taker approves the **router**, while the Safe's approval goes to **Aqua**.
- Read helpers verify RPC chain identity, deployed module code and the module's immutable venue/quoter links.
  Each snapshot reads one confirmed block and rechecks its hash afterward; a reorg rejects the read. The
  adapter's health reports its spot/TWAP band separately from full quote eligibility. Missing history remains
  unavailable. There is no cache or implicit fallback price.
- Prepared calls cover create, bounds, reship, pause/unpause, revoke, direct claims, router approvals and swaps.
  Issuer calls are payloads for signed Safe transactions. Builders carry role metadata and never sign or submit.
  Submit-ready swap data requires a positive threshold and expiry. Monetary amounts remain bigint, and price
  parsing rejects unrepresentable precision instead of rounding silently.
- **Error coverage:** all **49 distinct custom error names** present in our production ABIs have explicit copy,
  enforced by TypeScript and tests. The mapper also handles Safe codes, nested SafeCallFailed causes, common
  ERC20/Aqua/router errors, panics and malformed/unknown provider data. It follows known provider cause/data
  fields with depth/cycle limits and does not mistake transaction calldata for revert bytes.
- **Verified revoke ordering:** a successfully docked strategy can fail in Aqua with
  `SafeBalancesForTokenNotInActiveStrategy` before reaching `MandateRevoked`. The live SDK test asserts that
  actual error and its docked-strategy explanation. When docking fails, the quoter's revoked check still applies,
  as covered by the existing Safe fork suite. Source: pinned `IAqua`, `Aqua` and the executed integration tests.
- The replay now imports this shared error mapper. Its refreshed JSON changes explanation text while retaining
  actual outcomes and receipt evidence. The live run still verifies **178 steps / 156 blocked inner calls**.
- Verification: **111 Solidity tests, 19 package tests, 4 live SDK tests and 7 replay tests pass**, with no skips
  in those runs. Package declarations, consumer tests and generated-file freshness checks pass. The SDK live
  command owns and shuts down a fresh local Anvil; it performs read-only permission simulations.
- viem behavior was checked against installed source and its primary documentation for
  [readContract](https://github.com/wevm/viem/blob/main/site/pages/docs/contract/readContract.md),
  [decodeErrorResult](https://github.com/wevm/viem/blob/main/site/pages/docs/contract/decodeErrorResult.md), and
  [simulateContract](https://github.com/wevm/viem/blob/main/site/pages/docs/contract/simulateContract.md).
- Package READMEs document the APIs and commands. Segment 7 remains gated: indexer framework, ORM, blocked-
  attempt ingestion and the draft database schema require the user's choices/review before implementation.

## 12. Indexer and API (Segment 7)

Code: `apps/indexer`. Decisions (user): Hono, Drizzle + postgres.js, events + server re-simulation, docker compose.

- **Schema is a draft** (`src/db/schema.ts`, migration `0000_draft_initial`). All tables keyed by `chain_id`;
  uint256 as `numeric(78,0)`; hex text with format checks. Every evidence row cascades from `blocks`.
- **Blocked attempts.** Reverted swaps emit nothing. Two labeled sources: `onchain_actor` (demo ScenarioActor
  `Attempted`, receipt-backed) and `simulated` (server `eth_call` at the indexed head; the client supplies
  parameters only). Allowed actor attempts are omitted from the feed because their `Filled` row covers them.
- **Reorg findings (fixed, tested):** (1) the cursor's canonicality must be checked before comparing with the head,
  because a replacement chain can be shorter; (2) viem caches `getBlockNumber` for 4s by default, so the client is
  created with `cacheTime: 0`; (3) on the demo node, empty replacement blocks are byte-identical (fixed timestamp
  interval, see §10), so the reorg test includes a transaction to make the fork real.
- **Cache.** Response keys embed the head hash, so a new head is the invalidation. Simulations bump a per-mandate
  version in feed keys. Dedupe of simulations moved from a Redis memo to the table's unique key after a test
  showed the memo could outlive a database reset and skip the insert.
- **Live updates.** One shared Redis subscriber fans out to all SSE clients; streams are capped per process.
- **Node 24 type stripping** forbids parameter properties; `erasableSyntaxOnly` is on so tsc rejects them.
- `pnpm replay:serve` keeps the verified demo fork alive for the worker. Exports stay byte-identical, so the
  committed manifest matches the live node.
- Verification: **27 indexer tests pass** (indexer reconciliation with `acts.json`, forced reorg, API, cache,
  simulations, SSE). End-to-end: worker indexed 216 events; API, simulation and SSE checked with real processes.
- Not yet done: a trusted-proxy setting for rate limiting behind a load balancer; a separate read-only DB role for
  the API process; image digests in `compose.yaml` (currently major-version tags).

## 13. Infra

- RPC: `https://eth.drpc.org` serves archive state at the pinned block. `ethereum-rpc.publicnode.com`
  (403, needs token), `rpc.flashbots.net` (pruned), `1rpc.io` (discontinued) do not.
- Fork block `26355000` (in `config/chains/1.json`). Foundry caches fork state after the first run (the first v4
  fork run takes about 2 min).
- Foundry does not read the repo-root `.env`; use `pnpm contracts:test` / `pnpm fork`.
