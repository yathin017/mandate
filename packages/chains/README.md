# @mandate/chains

Validated chain configuration and deployment context for the SDK, indexer and web app. Runtime code is ESM
and uses no filesystem, process environment or Node-only APIs.

`src/generated.ts` is generated from `config/chains/*.json` and `deployments/*.json`. Edit those source files,
then run `pnpm packages:build` from the repository root. `pnpm generate:check` rejects stale generated files.

```ts
import { getChainConfig, getDeployment, getLocalForkDeployment, getTransactionUrl, isLiveDeployment } from '@mandate/chains';

const mainnetVenue = getChainConfig(1); // Canonical external Aqua, SwapVM, v4 and Safe addresses.
const fork = getLocalForkDeployment(1);
console.log(fork.chainId);       // 31337: runtime network.
console.log(fork.sourceChainId); // 1: upstream fork source.
getDeployment(31337);            // Same recorded local deployment.
// getDeployment(1) throws: no Mandate contracts are registered on mainnet.
// For a receipt from this fork, getTransactionUrl(fork.chainId, receipt.transactionHash) returns undefined.
```

`getTransactionUrl` takes the **runtime** chain id and the receipt's transaction hash.

`parseChainConfig(unknown)` validates ids, non-zero addresses, explorer URLs and RPC environment-variable names.
`parseLocalForkDeployment(unknown)` validates the manifest's runtime/source distinction, addresses, hashes and
synthetic-data labels. Registry objects and nested configuration objects are frozen.

`MandateDeployment` is the contract context accepted by SDK helpers. `getDeployment(chainId)` returns a
`Deployment`, either kind below; narrow it with `isLiveDeployment` or `environment`.

| Kind | Registered | Extra context |
|---|---|---|
| `LocalForkDeployment` (`environment: "local-mainnet-fork"`) | runtime chain 31337, forked from Ethereum (1) | the recorded demo's Safes, pools, scenario actors, each act's policy and strategy ids; no explorer links |
| `LiveDeployment` (`environment: "live"`) | Base mainnet (8453) | deploy block, issuer Safe, owner 2, market maker, the demo policy and strategy ids; Basescan links. A v1 manifest (a single mandate id) is rejected |

```ts
const base = getDeployment(8453);
if (isLiveDeployment(base)) console.log(base.safe, base.mm, base.policy, base.strategy);
getTransactionUrl(8453, hash); // https://basescan.org/tx/<hash>
```

`parseLiveDeployment` requires the runtime chain to be its own source chain, a chain config for it, and the
mock-token disclosure. Chain configurations exist for Ethereum (1) and Base (8453).

The checked-in fork deployment is a reference export. A running RPC must actually contain those contracts before
the SDK can read it. The replay exporter stops its temporary Anvil after export; `pnpm sdk:test:fork` creates,
deploys and verifies a fresh temporary node automatically.
