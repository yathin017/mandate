# NOTES

Verified facts, decisions and spec conflicts. Every entry names its source. If this file and
`.agents/README.md` disagree, this file reflects what the code/chain actually does.

Last verified: Nov 6, 2026, mainnet block ~26,355,100.

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
> requires dApps to include it is policy, not code. Our fork demo can omit or include it; decide in
> Segment 2.

## 7. Design implications for MandateQuoter (Segment 2)

1. **Router gate is not enough.** Anyone can ship their *own* strategy that points at our quoter
   with our `mandateId` in args and then swap through the real router, so `msg.sender == router`
   passes and they could burn the epoch cap. The quoter must also check `query.maker == mandate.safe`
   and, ideally, `query.orderHash == mandate.activeStrategyHash` (registered by MandateModule on reship).
2. `orderHash` changes on every reship (strategies are immutable), so epoch/net-sold state is keyed by
   `mandateId`, not `orderHash`.
3. Mandate args must fit in 235 bytes → pass only `mandateId` (32 bytes); read terms from storage.
4. Router 1.0.2 has `flatFeeAmountInXD` (opcode 21). Spread/fee could use it instead of quoter math;
   decide in Segment 2.

## 8. Infra

- RPC: `https://eth.drpc.org` serves archive state at the pinned block. `ethereum-rpc.publicnode.com`
  (403, needs token), `rpc.flashbots.net` (pruned), `1rpc.io` (discontinued) do not.
- Fork block `26355000` (in `config/chains/1.json`). Foundry caches fork state after first run.
- Foundry does not read the repo-root `.env`; use `pnpm contracts:test` / `pnpm fork`.
