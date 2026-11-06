# @mandate/chains

Validated chain configuration and deployment context for the SDK, indexer and web app. Runtime code is ESM
and uses no filesystem, process environment or Node-only APIs.

`src/generated.ts` is generated from `config/chains/*.json` and `deployments/*.json`. Edit those source files,
then run `pnpm packages:build` from the repository root. `pnpm generate:check` rejects stale generated files.

```ts
import { getChainConfig, getDeployment, getLocalForkDeployment, getTransactionUrl } from '@mandate/chains';

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

`MandateDeployment` is the contract context accepted by SDK helpers. `LocalForkDeployment` extends it with
the recorded demo's parties, pools, mandate ids and provenance. Only the Ethereum configuration and its local
fork deployment are currently registered. Adding source chain configurations goes through the same generator
and validation; registering an actual production deployment requires an explicit manifest format and rollout.

The checked-in deployment is a reference export. A running RPC must actually contain those contracts before
the SDK can read it. The replay exporter stops its temporary Anvil after export; `pnpm sdk:test:fork` creates,
deploys and verifies a fresh temporary node automatically.
