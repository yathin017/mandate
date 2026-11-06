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
const policy = await sdk.readPolicy(deployment.policies.act1);
console.log(policy.counters.netSold, policy.risk.mode, policy.risk.reason, policy.source.blockHash);
const strategy = await sdk.readStrategy(deployment.strategies.act1, policy.source.blockNumber);
```

Construction checks the RPC chain id, module bytecode, and its immutable quoter/Aqua/router links. Each read
checks network identity again. `readPolicy(id, blockNumber?)` pins the policy's terms, shared counters
(`policyCounters`), risk mode with its reason and the oracle readings behind it (`riskMode`), and its strategy ids
to one confirmed block, then verifies the block hash again. `readStrategy(id, blockNumber?)` does the same for a
strategy's terms, active order, version and fee accounting. A changed block rejects the read so callers can retry.
`policiesOf` and `activePolicyOf(safe, base)` return provenance too. No cache, polling, wallet or RPC URL is
created implicitly.

The risk mode is what the quoter would apply to a fill in that block: `0` Normal, `1` Defensive, `2` Paused, with
`reason` one of `RISK_REASONS` (`riskReasonText` gives the plain sentence). `quote()` evaluates the full fill rules
(statuses, risk mode, quote tolerance and impact, fill size, floor, gross/net/release limits, buyback rules).

```ts
const quote = await sdk.quote(deployment.strategies.act1, {
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
the quoter; its actual `SafeBalancesForTokenNotInActiveStrategy` error is explained accordingly. Exported
`MandateClient`, `PolicySnapshot`, `StrategySnapshot`, `Policy`, `PolicyConfig`, `Strategy`, `StrategyBounds`,
`StrategyParams` and `SwapOrder` types derive from the generated contract shapes.

## Prepared calls

```ts
import { buildClaimFeesCall, buildRevokePolicyCall, buildReshipCall } from '@mandate/sdk';

const claim = buildClaimFeesCall(deployment, deployment.strategies.act1);
const revoke = buildRevokePolicyCall(deployment, deployment.policies.act1);
const reship = buildReshipCall(deployment, deployment.strategies.act1, strategy.strategy.params);
```

Each payload contains `{ chainId, to, data, value: 0n, operation: 0, role }`. The role describes the required
caller; the contracts enforce permission and bounds. Builders never sign, approve or submit anything.

| Builder | Caller |
|---|---|
| `buildCreatePolicyCall`, `buildUpdatePolicyCall`, `buildPausePolicyCall`, `buildUnpausePolicyCall`, `buildRevokePolicyCall` | Issuer Safe, via its owners' signed transaction |
| `buildAddStrategyCall`, `buildUpdateStrategyBoundsCall`, `buildUnpauseStrategyCall`, `buildRevokeStrategyCall` | Issuer Safe |
| `buildReshipCall`, `buildClaimFeesCall` | The strategy's MM |
| `buildPauseStrategyCall` | Issuer Safe or the strategy's MM |
| `buildSwapCall`, `buildApproveRouterCall` | Taker |

Builders encode exactly the values given: no defaults are filled in. Fees are claimed directly by the MM.
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
  now: policy.source.timestamp,
  periodEndsAt: policy.counters.periodEndsAt,
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

All ABIs come from Foundry artifacts: module, quoter, v4 hook and market oracle, Aqua, SwapVM interfaces/router,
Safe, ERC20 metadata/errors and demo evidence readers. Import the constants from `@mandate/sdk` or
`@mandate/sdk/abis`. The replay exporter and the indexer use this same error mapper.

## Proposals

`strategyTermsTypedData` / `hashStrategyTerms` give the EIP-712 message a market maker signs to accept a proposed
strategy (`StrategyTerms`: proposal id, Safe, market maker, pair, kind, bounds, params, expiry; domain = chain +
module, version `2`, so v1 mandate acceptances cannot be replayed). `termsToJson` / `termsFromJson` are the
range-checked storage form. The treasury policy is the issuer's own and is not part of the signed terms.

## Self-serve onboarding

Helpers for letting any project set up a treasury policy and strategies on a live chain. Builders return `PreparedCall`s with a `role`
(`anyone`, `issuer-safe`, `token-owner`, …) and never sign.

| Helper | Purpose |
|---|---|
| `buildCreateSafeCall(chainId, { owners, threshold, saltNonce })` | Safe 1.4.1 proxy from the chain's canonical factory/singleton (`encodeSafeSetup` validates owners/threshold) |
| `buildEnableModuleCall(chainId, safe, module)` | The Safe enables the Mandate module on itself (run it as a Safe transaction) |
| `readTokenInfo(client, token)` / `labelToken(chainId, token, symbol)` | ERC20 metadata or a reason it is not a token; canonical USDC/WETH labels and look-alike warnings |
| `mockTokenDeployment(name, symbol, decimals)` / `buildMintCall(...)` | Demo-only tokens; names must start with "Demo " |
| `buildLaunchAnchorCall(chainId, launcher, { base, quote, initialPriceX36 })` | AnchorLauncher: pool with the oracle hook (if missing) + market oracle |
| `readAnchorStatus(client, { chainId, launcher, base, quote, window? })` | Oracle (existing/predicted), PoolId, pool price, liquidity and trusted liquidity, pool age, observation buffer and history at one block; with the policy's TWAP `window`, whether it is covered (`ready` is `null` without one) |

`anchorPoolKey` / `poolIdOf` compute the launcher's pool offline (checked against a Solidity `PoolIdLibrary`
vector). `pnpm sdk:test:base` runs read-only checks of these helpers against the live Base deployment.
