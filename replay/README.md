# Fork scenarios and replay export

Run from the repository root with Node 24+, pnpm and Foundry installed:

```sh
pnpm install --frozen-lockfile
pnpm packages:build
pnpm replay:run
pnpm replay:test
pnpm replay:verify
```

`replay:run` loads the optional root `.env`, starts its own Anvil on `127.0.0.1:8547`, forks the block in
`config/chains/1.json`, broadcasts the scripts, validates the results and stops its node. It refuses an occupied
RPC port rather than resetting another node. Override the port with `LOCAL_RPC_URL=http://127.0.0.1:8550`.
`MAINNET_RPC_URL` selects the archive provider; the public default is `https://eth.drpc.org`.

All scripts require runtime chain id **31337**. They use Anvil's public development mnemonic and unlocked account
zero, never real wallet credentials. The module, hook and adapters are deployed normally; the hook address is
mined using CREATE2. Safe proxies come from the canonical factory and require both development-owner signatures.

## Scripts and outputs

| Path | Purpose |
|---|---|
| `contracts/script/DeployFork.s.sol` | Deploy tokens, the shared module/quoter, oracle hook, adapters, demo helpers and four 2-of-2 Safes |
| `contracts/script/SeedV4Pool.s.sol` | Seed separate anchor and traditional-loan pools on the canonical v4 PoolManager |
| `contracts/script/RunActs.s.sol` | Initialize mandates and broadcast the numbered scenario phases |
| `deployments/1.json` | Generated manifest for a **local fork of chain 1**; `chainId` is 31337 and `sourceChainId` is 1 |
| `replay/data/acts.json` | Versioned replay steps, block-specific snapshots, plain-language errors and token-transfer evidence |
| `replay/data/receipts.json` | Actual RPC receipts for setup and replay transactions, including the traditional Safe's token loan |
| `.local/replay/anvil.log` | Ignored local node log for troubleshooting |

The committed JSON is a reproducible demo export, not a mainnet deployment registry. Its hashes belong to the
local fork and cannot be looked up on Etherscan. Re-running creates a fresh local chain and replaces the export
only after its checks pass. A failed run restores the preceding deployment manifest. The node is stopped after
export; the receipts remain available offline. There is no live web application in this segment.

## Acts

1. **Token-loan counterfactual.** The traditional Safe transfers 10M synthetic LAUNCH to its MM; that MM sells
   all of it into a separate v4 pool. A separate mandate fills five 10,000-LAUNCH treasury sales, then blocks
   the next sale at its 50,000-per-epoch cap. The two pools do not share reserves. This is not a MOVE replay.
2. **Repeated sells and market manipulation.** A separate Safe holds 134.1M LAUNCH. There are 150 equal intents
   of 894,000 LAUNCH, totaling 134.1M. One fills; 149 hit the 1.341M cap because another full intent would exceed
   the remaining 447,000. The pump trips `SpotTwapDivergence`, then recovery permits a fill. A sustained crash
   brings the TWAP to $0.30; the quoter blocks a stale-price buyback with `AnchorDeviation`, then permits the
   buyback when the average recovers. This is a **SYNTHETIC** sequence, not historical FUN orders or ETH proceeds.
3. **MM operations.** Tighten 80 → 30 bps; fill; reject a cap increase and a Safe transfer; claim fees; pause;
   block a paused fill; resume with both owners' signatures; fill again; revoke with both signatures; claim
   already-earned fees; reject further reshipping.

Supply, liquidity and oracle history are synthetic. Time advancement mines local blocks and verifies that
the requested interval actually elapsed. The scripts do not inject code, edit contract storage or impersonate
the Safe. The demo actors and the public callback taker are local demo helpers, not production entry points.

## Evidence and draft data format

`ScenarioActor.attempt` executes a call and checks its expected success or revert selector **onchain**. If the
outcome differs, the outer transaction fails and the export stops. Expected blocks produce a successful outer
receipt with a reverted inner call. The event retains the complete revert bytes; the exporter decodes them and
rejects unknown selectors. Rejected attempts are not invented quote results or successful token movements.

For each step, the exporter reads `DemoState.snapshot(mandateId)` at that receipt's exact block, verifies its
receipt/block hashes, and exports ERC20 `Transfer` logs. Snapshot values are integer strings in raw token/X36
units. The snapshot includes balances, sell counters, live spot/TWAP, claimed fees, release capacity, spread,
epoch cap, strategy nonce and status. `source` identifies the reader contract, function, block and block hash.
Initial states share the post-setup block before Act 1 and have their own `initialSource` provenance.

The exporter now uses `@mandate/sdk` for error decoding and copy. `pnpm replay:run` and `pnpm replay:test` build
the shared packages automatically. `pnpm sdk:test:fork` also runs the SDK's live reads, quotes and permission
simulations against the temporary node before it stops.

The Node tests reconcile Safe balance changes against receipt transfer logs, sell counters against `Filled`
events, and replay outcomes against `Attempted` events. They also reject missing evidence, false provenance,
missing synthetic labels, malformed ABI data and unsafe RPC destinations. General ABIs and error wrappers
live in the SDK. The remaining replay-specific decoder handles this draft snapshot and event format.
