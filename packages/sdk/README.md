# @mandate/sdk

Typed contract ABIs, reads, quotes, transaction payloads and error explanations for Mandate. This package uses
viem 2.57.16 and exposes ESM plus TypeScript declarations. All monetary values use `bigint`; price units are
`quoteRaw * 1e36 / baseRaw`.

## Setup and checks

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm packages:build
pnpm packages:typecheck
pnpm packages:test
pnpm generate:check
pnpm sdk:test:fork
```

The build compiles Solidity, generates ABI constants and chain data, derives encoding fixtures from the pinned
Solidity libraries, then compiles both packages. `generate:check` verifies all generated files without changing
them. The live fork check executes the replay and SDK integration tests before stopping its temporary node.

## Contract context and reads

With an RPC that actually hosts your deployment:

```ts
import { createPublicClient, http } from 'viem';
import { getLocalForkDeployment } from '@mandate/chains';
import { createMandateClient } from '@mandate/sdk';

const deployment = getLocalForkDeployment(1);
const publicClient = createPublicClient({ transport: http('http://127.0.0.1:8547') });
const sdk = await createMandateClient(publicClient, deployment);
const snapshot = await sdk.readSnapshot(deployment.mandates.act1);
console.log(snapshot.epoch.netSold, snapshot.remainingThisEpoch, snapshot.source.blockHash);
```

Construction checks the RPC chain id, module bytecode, and its immutable quoter/Aqua/router links. Each read
checks network identity again. `readSnapshot(id, blockNumber?)` pins the mandate, counters, release, fees,
claims, active order and anchor reads to one confirmed block, then verifies the block hash again. A changed
block rejects the snapshot so callers can retry. No cache, polling, wallet or RPC URL is created implicitly.

`snapshot.anchor` reports the v4 spot/TWAP circuit breaker. Its states are `within-spot-band`, `blocked` and
`unavailable`. Missing history remains unavailable. `quote()` evaluates the full fill rules, including execution
price deviation, floor, release, sell cap and lifecycle. Other `IPriceAnchor` implementations may lack the v4
snapshot API; their health is reported unavailable by this v4-focused reader.

```ts
const quote = await sdk.quote(deployment.mandates.act1, {
  taker: deployment.deployer,
  tokenIn: deployment.quote,
  tokenOut: deployment.base,
  amount: 100_000_000n, // 100 sUSDC, using the demo token's verified 6 decimals.
  isExactIn: true,
  context: {
    base: { decimals: 18, symbol: 'LAUNCH' },
    quote: { decimals: 6, symbol: 'sUSDC' },
  },
});
if (quote.ok) console.log(quote.amountIn, quote.amountOut);
else console.log(quote.error.message);
```

`quote` returns a discriminated result with block provenance. A docked order can fail in Aqua before entering
the quoter; its actual `SafeBalancesForTokenNotInActiveStrategy` error is explained accordingly. `mandatesOf`
also returns provenance. Exported `MandateClient`, `MandateSnapshot`, `Mandate`, `MandateBounds`, `MandateParams`
and `SwapOrder` types derive from the generated contract shapes.

## Prepared calls

```ts
import { buildClaimFeesCall, buildRevokeCall, buildReshipCall } from '@mandate/sdk';

const claim = buildClaimFeesCall(deployment, deployment.mandates.act1);
const revoke = buildRevokeCall(deployment, deployment.mandates.act1);
const reship = buildReshipCall(deployment, deployment.mandates.act1, snapshot.mandate.params);
```

Each payload contains `{ chainId, to, data, value: 0n, operation: 0, role }`. The role describes the required
caller; the contracts enforce permission and bounds. Builders never sign, approve or submit anything.

| Builder | Caller |
|---|---|
| `buildCreateMandateCall`, `buildUpdateBoundsCall`, `buildUnpauseCall`, `buildRevokeCall` | Issuer Safe, via its owners' signed transaction |
| `buildReshipCall`, `buildClaimFeesCall` | Mandate MM |
| `buildPauseCall` | Issuer Safe or MM |
| `buildSwapCall`, `buildApproveRouterCall` | Taker |

Creation and bounds builders supply the module's quoter automatically. Fees are claimed directly by the MM.
`buildSwapCall` requires a positive slippage threshold and deadline: minimum output for exact-input swaps,
maximum input for exact-output swaps. Its EOA settlement mode approves the router, which transfers input
tokens and pushes them to Aqua. The issuer Safe's Aqua approval is managed by the module. This helper does
not implement callback-based takers, WETH unwrap, arbitrary hooks or other router versions.

`encodeTakerData` follows the pinned v1.0.2 `TakerTraitsLib.build` format; `hashAquaOrder` follows
`MandateStrategy.strategyHash`. Solidity-generated fixtures test both encodings, including uint256/uint40 limits.

## Errors and units

```ts
import { explainError, parsePriceX36, formatPriceX36 } from '@mandate/sdk';

const issue = explainError(providerError, {
  base: { decimals: 18, symbol: 'LAUNCH' },
  quote: { decimals: 6, symbol: 'sUSDC' },
  now: snapshot.source.timestamp,
  epochResetsAt: snapshot.epochResetsAt,
});
console.log(issue.message);
const price = parsePriceX36('0.40', 18, 6); // 400000000000000000000000n.
formatPriceX36(price, 18, 6);              // '0.4'.
```

Pass actual token metadata for human-unit messages; without it the SDK labels raw amounts as base/X36 units.
The error extractor accepts raw revert bytes and bounded nested viem/JSON-RPC causes. It handles every custom
error in our production contract ABIs, standard Safe codes, nested `SafeCallFailed` causes, common ERC20/Aqua/
router failures, Solidity panics, and unknown or malformed data. It keeps raw bytes and arguments for auditing.
It never scans transaction calldata or arbitrary error text for a matching selector.

`parsePriceX36` rejects unrepresentable input precision. Formatting floors display digits and shows a positive
sub-display-unit price as `<…`; it never labels that price zero. `formatTokenAmount` preserves exact integer
precision. Token metadata ABIs are exported so callers can obtain decimals and symbols explicitly.

All ABIs come from Foundry artifacts: module, quoter, v4 hook/anchor, Aqua, SwapVM interfaces/router, Safe,
ERC20 metadata/errors and demo evidence readers. Import the constants from `@mandate/sdk` or `@mandate/sdk/abis`.
The replay exporter uses this same error mapper. Storage, authentication, caching and indexer policy remain
Segment 7 work.
