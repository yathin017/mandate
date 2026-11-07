# Mandate

**The market-maker deal as an onchain program.** A project's tokens never leave its own Safe. The Safe sets one
**treasury policy** per token (release schedule, per-period sell and buyback limits, price rules, and market-risk
thresholds read from a Uniswap v4 oracle), and market makers run **strategies** under it on 1inch Aqua, inside
bounds the issuer sets. Every fill is checked by code; every refusal is public.

Built for ETHGlobal Mumbai 2026. **Judges:** [Partner integrations](#partner-integrations-for-judges) links every
Uniswap v4 and 1inch Aqua/SwapVM integration to its contract lines; Uniswap feedback is in [`FEEDBACK.md`](FEEDBACK.md).

**One place for new token issuers and market makers on Base:**

| Issuers | Market makers |
|---|---|
| Launch a fixed-supply token straight into a Safe (TokenFactory) | Publish a profile in the marketplace |
| Open a Uniswap v4 pool and its market oracle (AnchorLauncher), seed liquidity | Are ranked by an onchain-only score (availability, execution vs the market, volume, reliability, responsiveness) |
| Set the treasury policy from suggested values; every field explains, live, what it will do | See the policy they would trade under before accepting |
| Pick a market maker by score and propose a strategy | Accept a strategy by signing its exact terms (EIP-712, no gas) |
| Owners add it through the Safe; pause, edit the policy or revoke any time | Operate inside the bounds and what the Safe can back; claim their fee share directly |
| Track shared limits, release, risk mode, fills, execution quality, MM pay, refusals | Track volume, execution quality, earned and claimable fees, refusals |

**What the v2 model closes.** Strategies share one policy, so extra strategies, reships and buy-sell round trips
cannot reset or multiply the budget (gross and net sell limits). Every ship checks the Safe actually holds what all
its live strategies promise. The oracle reports spot, long and short TWAPs, *trusted* depth (liquidity added within
a settle window does not count) and pool age; the quoter turns these into Normal, Defensive or Paused against the
issuer's thresholds, with per-mode fill caps, minimum spread and buyback permission. A strategy's pre-trade price
must sit near the TWAP (no stale quotes), separately from per-fill price impact. Design: [`NOTES.md` §18](NOTES.md).

- Product spec: [`.agents/README.md`](.agents/README.md)
- Verified facts and decisions: [`NOTES.md`](NOTES.md)

## Layout

| Path | What lives there |
|---|---|
| `config/chains/<chainId>.json` | External addresses per chain (Aqua, SwapVM router, v4 PoolManager, Safe, tokens). Adding a chain = adding a file here. |
| `deployments/<chainId>.json` | Addresses of our contracts, written by deploy scripts. |
| `contracts/` | Foundry project: quoter, Safe module (policies and strategies), v4 oracle hook and market oracle, tests, scripts. |
| `packages/` | Shared TypeScript packages (chain registry, SDK). |
| `apps/indexer` | Indexer worker + public API (Postgres, Redis, SSE). |
| `apps/web` | Dashboard, wallet flows and the self-serve onboarding wizard (Vite + React + shadcn). Dashboards read the indexer API; wallet flows read the chain. |
| `replay/` | Scenario export behind the demo fork (`pnpm replay:serve`) and the indexer tests. |

## Two ways to run it

| | Against Base mainnet | Against a local fork |
|---|---|---|
| Chain | The live Base deployment (contracts already deployed) | A private copy of Ethereum mainnet on your machine, with our contracts deployed on it |
| You run | Postgres + Redis, the indexer worker, the API, the web app | The same, plus the local chain |
| Tools | Node, pnpm, Docker | Node, pnpm, Docker, Foundry, `jq` |
| Wallet | Your own wallet on Base; transactions cost real (small) gas | Public test keys; no real gas |
| Tokens | Mock tokens, or ones you launch through the platform | Synthetic demo tokens |
| Best for | Using the product | Development, tests, trying things without gas |

## Run the app against Base mainnet

No local chain and no Foundry: the contracts are already on Base. You run your own copy of the indexer, the API
and the web app; they read the Base chain, and your browser wallet signs on Base.

```
 Base mainnet ──▶ indexer worker ──▶ Postgres ◀── API (8788) ◀── web app (5173) ◀── your browser
 (our contracts)     reads logs        + Redis      REST + SSE      proxies /api       + wallet on Base
```

### 1. Setup (once)

```sh
pnpm install --frozen-lockfile   # exact dependency versions
pnpm packages:compile            # compiles the shared packages (chain registry and SDK)
cp .env.example .env             # then edit the two Base lines below
pnpm infra:up                    # Postgres 16 and Redis 7 in Docker, loopback only
docker compose exec postgres psql -U mandate -c 'CREATE DATABASE mandate_base'   # the Base indexer's database
```

In `.env`, uncomment and fill:

```sh
# An RPC that serves eth_getLogs. A keyed one (Alchemy, QuickNode, Infura) is best; public ones rate-limit.
BASE_INDEXER_RPC_URL=https://base-mainnet.g.alchemy.com/v2/<your key>
BASE_DATABASE_URL=postgres://mandate:mandate@127.0.0.1:5432/mandate_base
```

No keys are needed: you only read the chain, and your wallet signs in the browser. With a public RPC (for example
`https://base.gateway.tenderly.co`; `mainnet.base.org` rate-limits `eth_getLogs` too hard to index with), also uncomment the three
`BASE_INDEXER_*` lines in `.env.example` that slow the worker down.

### 2. Start (three terminals, in this order)

```sh
pnpm base:worker   # terminal 1
pnpm base:server   # terminal 2
pnpm base:web      # terminal 3, then open http://localhost:5173
```

- **`base:worker`** first checks Postgres, Redis and the RPC, and applies the database migrations. Then it indexes
  Base from the block before our deployment (`deployBlock` in `deployments/8453.json`): policies, strategies, fills,
  refusals, token launches and market readings. It waits 2 confirmations per block. The first start catches up on
  history, then it follows new blocks every few seconds.
- **`base:server`** serves the API on `127.0.0.1:8788` from that database. Start it after the worker has
  migrated. Check it with `curl localhost:8788/health`: `head` is the newest block the worker has indexed.
- **`base:web`** runs the web app on <http://localhost:5173> for chain 8453. Pages read the API; wallet actions
  read and sign on Base directly, through `https://mainnet.base.org` (set `VITE_RPC_URL` in `apps/web/.env.local`
  to use another RPC). Contract addresses come from the build-time registry, never from the API.

The three share one `.env` with the local setup. The `base:*` commands override only the chain, RPC, database and
port, so both setups can run side by side (API 8787 local, 8788 Base). Only one web app fits on 5173 at a time;
start the other with `--port`.

### 3. Use it

Connect your wallet on **Base mainnet**. Every transaction is real and costs a little ETH for gas; the demo tokens
are mocks with no value, but anything you launch is a real token on Base.

1. **Launch** (`/launch`): create your own 2-of-2 Safe, launch a token with the TokenFactory (or mint a demo token),
   enable the module, launch the price anchor, add liquidity, set your treasury policy (every value is yours) and
   propose a strategy to a market maker. A two-owner Safe needs two wallets: approve with one, execute with the other.
2. **Market makers** (`/market-makers`, `/desk`): list a profile (sign in first), accept proposals by signing,
   operate strategies and claim fees.
3. **Explore** (`/explore`): every strategy and launch on Base, with live activity.

The deployment's own demo Safe and wallets are listed under *Live on Base mainnet* below.

## Run it locally (fork)

Everything runs on your machine against a **local fork of Ethereum mainnet**: a private Anvil chain that copies
mainnet at a pinned block, so the real Aqua, SwapVM router, Uniswap v4 PoolManager and Safe contracts are there,
and our contracts are deployed next to them. Tokens and price history on it are synthetic. Nothing costs real gas.

```
 Anvil fork (8547) ──▶ indexer worker ──▶ Postgres ◀── indexer API (8787) ◀── web app (5173) ◀── your browser
   real Aqua/v4/Safe        reads logs         + Redis        REST + live SSE        proxies /api     + wallet (reads
   + our contracts          every block                                                                and signs on 8547)
```

### 1. Install the tools (once)

| Tool | Version | Why |
|---|---|---|
| [Foundry](https://book.getfoundry.sh/getting-started/installation) (`forge`, `anvil`, `cast`) | ≥ 1.7 | Builds and tests the contracts, runs the local chain |
| Node.js | ≥ 24 | Runs the indexer, the web app and the scripts (TypeScript runs directly, no build step) |
| pnpm | 10 | Installs the workspace |
| Docker | any recent | Runs Postgres and Redis for the indexer |
| `jq` | any | Used by `pnpm fork` to read the pinned fork block |

### 2. Set up the repo (once)

```sh
pnpm install --frozen-lockfile   # exact dependency versions from the lockfile
cp .env.example .env             # local settings; the defaults work as they are
pnpm infra:up                    # starts Postgres 16 and Redis 7 in Docker, on 127.0.0.1 only
```

`.env` is gitignored. The defaults point everything at the local machine. The only remote service is
`MAINNET_RPC_URL`, the public archive RPC the fork copies mainnet state from.

### 3. Start the stack (four terminals)

Run each command from the repo root, in this order, and leave them running.

**Terminal 1: the chain.**

```sh
pnpm replay:serve
```

Builds the contracts and the shared packages. Starts Anvil on `127.0.0.1:8547` as chain id 31337, forked from
mainnet block `26355000`. Then it deploys the demo: the Safe module and its quoter, the oracle hook, two demo
tokens (`LAUNCH`, `sUSDC`), seeded Uniswap v4 pools, and four 2-of-2 demo Safes. Last, it plays three scenarios
(each Safe gets a treasury policy and a strategy, then real fills, refusals, a price pump and crash, a pause and a
revoke) and checks every result.

It writes `deployments/1.json` (the addresses) and `replay/data/` (the evidence). The first run takes a few
minutes, because Foundry fetches mainnet state; later runs reuse the cache. When it prints *Keeping the fork alive*,
the chain is ready. Ctrl+C stops it and the chain is gone: the next run starts fresh.

**Terminal 2 (one-off, while terminal 1 runs): the self-serve contracts.**

```sh
pnpm fork:platform
```

The demo deploy does not include the AnchorLauncher (creates pools for any pair) or the TokenFactory (launches
tokens). This command deploys both onto the running fork and prints three lines. Put the first two in
`apps/web/.env.local` and the third in `.env`:

```sh
VITE_ANCHOR_LAUNCHER=0x…   # apps/web/.env.local
VITE_TOKEN_FACTORY=0x…     # apps/web/.env.local
INDEXER_TOKEN_FACTORY=0x…  # .env
```

On a fresh fork the addresses are the same every time, so this is a one-time edit. Skip this step to only browse
the demo; you need it to launch tokens or pools in the wizard.

**Terminal 2: the indexer worker.**

```sh
pnpm indexer:worker
```

Checks that Postgres, Redis and the chain are reachable, then applies the database migrations. After that it
follows the chain from the fork block. For every block range it reads our contracts' logs, reads each touched
policy and strategy at that block, and writes fills, refusals and readings to Postgres in one transaction. It also
records how far it has got in Redis.

It handles reorgs by rolling back to the last block it still agrees on. Every 10 minutes it runs small read-only
probe quotes for the market-maker score. Leave it running.

**Terminal 3: the API.**

```sh
pnpm indexer:server
```

Starts the public JSON API on `127.0.0.1:8787`, reading from Postgres, with responses cached in Redis per block.
It also serves live change streams, wallet sign-in, market-maker profiles and proposals. Start it after the worker
has migrated the database. Check it with `curl localhost:8787/health`.

**Terminal 4: the web app.**

```sh
pnpm web:dev
```

Starts the Vite dev server on <http://localhost:5173>. Pages read the indexer API through the dev server's `/api`
proxy; wallet actions read the chain and sign on `127.0.0.1:8547` directly. Contract addresses come from the
build-time registry, never from the API. Edits to the code reload in the browser.

### 4. Connect a wallet

Pages work without a wallet. To act, add a custom network to your browser wallet (e.g. MetaMask): RPC
`http://127.0.0.1:8547`, chain id `31337`, currency `ETH`. Then import these **public Anvil development keys**.
They are known to everyone; never use them anywhere else.

| Role | Address | Private key |
|---|---|---|
| Safe Owner 1 | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` |
| Safe Owner 2 | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d` |
| Market Maker | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` | `0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a` |

Both owners own the demo Safes. A Safe action needs both: one owner clicks **Approve as owner**, then you switch
accounts and the other clicks **Execute**. Profiles and proposals also need **Sign in** in the header, an EIP-4361
message with no gas.

The demo strategies' market maker is a scenario contract, so they cannot be operated from the desk. To try the
market maker side, propose a strategy to the Market Maker account above.

### 5. Try it

1. **Explore** (`/explore`): the three demo strategies. Open one for its treasury limits, market-risk reading,
   fills and refusals, and use **Try a trade** to ask the quoter about any trade.
2. **Issuer** (`/issuer`, pick a demo Safe): its policy and strategies. As both owners: pause, resume, edit the
   policy, revoke.
3. **Launch** (`/launch`): the full self-serve path for a new token, step by step. Create a Safe, launch or mint
   a token, enable the module, launch the price anchor and add liquidity. Then set the treasury policy (every
   value starts from a suggestion sized to your pool and Safe, and says what it will do) and propose a strategy
   to the Market Maker. Steps 3 onward need `pnpm fork:platform`.
4. **Desk** (`/desk`, as the Market Maker, signed in): accept the proposal by signing it. The owners then add it
   in `/launch` or `/issuer`, and the market maker tunes and claims fees under **My strategies**.

The policy checks a minimum pool age and other market thresholds that you set, using chain time. To let time pass
on the fork, mine a block with a later timestamp, for example one hour ahead:

```sh
cast rpc evm_mine $(( $(cast block latest -f timestamp --rpc-url http://127.0.0.1:8547) + 3600 )) --rpc-url http://127.0.0.1:8547
```

### 6. Stop and reset

- Ctrl+C in each terminal stops it. The fork's state disappears with it.
- `pnpm infra:down` stops Postgres and Redis. Their data volume is kept.
- After restarting the fork, keep the database. A fresh demo chain is identical block for block, and anything you
  did on the old one looks like a reorg to the worker: it rolls back to the last shared block and re-indexes.
- To start the indexer from scratch, stop the worker and the API, then run
  `docker compose exec postgres psql -U mandate -c 'DROP DATABASE mandate' -c 'CREATE DATABASE mandate'`.
  The worker re-applies the migrations on its next start.

### Ports

| Port | What | Change it with |
|---|---|---|
| 8547 | Anvil fork (chain 31337) | `LOCAL_RPC_URL`, plus `INDEXER_RPC_URL` and `VITE_RPC_URL` |
| 8787 | Indexer API | `API_PORT`, plus `MANDATE_API_PROXY` for the web app |
| 5173 | Web app | `pnpm web:dev --port <n>`, plus `API_CORS_ORIGINS` and `API_AUTH_ORIGINS` |
| 5432 / 6379 | Postgres / Redis (Docker, loopback only) | `POSTGRES_PORT` / `REDIS_PORT`, plus `DATABASE_URL` / `REDIS_URL` |

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `replay:serve` says the port is in use | Another node is on 8547. It never resets a running node; stop the other one or set `LOCAL_RPC_URL=http://127.0.0.1:<port>` (and point `INDEXER_RPC_URL` / `VITE_RPC_URL` at it). |
| Worker exits with one line about Postgres, the schema or the RPC | Start what it names: `pnpm infra:up`, the fork, or run the worker before the server. |
| Worker logs `wrong chain or fork` or `Reorg deeper than stored history` | The database was indexed from a different chain (another fork block, or a long-gone fork). Recreate it (see *Stop and reset*). |
| Wizard says *No AnchorLauncher is registered* | Run `pnpm fork:platform`, put its lines in `apps/web/.env.local`, restart `pnpm web:dev`. |
| Trades refused with a market-pause reason | Your policy's thresholds apply: a new pool must be older than your minimum age and its added liquidity must settle. Mine time forward (above). |
| Wallet shows a nonce or "transaction underpriced" error after a fork restart | The wallet cached the old chain. Reset the account's activity in the wallet settings. |

## Command reference

All commands run from the repo root.

**Contracts**

| Command | What it does |
|---|---|
| `pnpm contracts:build` | Compiles the Foundry project (`forge build`). |
| `pnpm contracts:test` | Runs every contract test: unit, integration against the pinned Aqua/SwapVM source, and mainnet-fork suites against the canonical Safe, Aqua, SwapVM and v4 contracts (the fork suites skip without `MAINNET_RPC_URL`). Loads `.env`, which Foundry alone does not. |
| `pnpm fork` | Starts a bare mainnet fork on 8547 with nothing of ours deployed, for experiments. `replay:serve` is the usual way. |
| `pnpm fork:platform` | Deploys the AnchorLauncher and TokenFactory onto a running demo fork and prints the env lines for the web app and the worker. |

**Demo chain and scenarios**

| Command | What it does |
|---|---|
| `pnpm replay:serve` | Fresh fork, demo deployment, the three scenarios, checks, then keeps the chain running on 8547. |
| `pnpm replay:run` | Same, but stops the chain when done. Regenerates `deployments/1.json` and `replay/data/`. |
| `pnpm replay:test` | Checks the exported scenario evidence against its receipts and the compiled ABIs. |
| `pnpm replay:verify` | Re-runs the invariant checks on `replay/data/acts.json` only. |

**Shared packages** (`packages/chains`, `packages/sdk`)

| Command | What it does |
|---|---|
| `pnpm generate` | Builds the contracts, writes SDK test vectors from Solidity, and regenerates the chain registry and contract ABIs from `config/chains/`, `deployments/` and the Foundry artifacts. |
| `pnpm generate:check` | Fails if any generated file is out of date (for CI). |
| `pnpm packages:build` | `generate`, then compiles both packages. Other commands run it for you. |
| `pnpm packages:compile` | Compiles both packages from the committed generated sources, without Foundry (enough for the Base setup). |
| `pnpm packages:test` / `packages:typecheck` | Unit tests and type checks of both packages. |
| `pnpm sdk:test:fork` | Fresh fork plus scenarios, then the SDK's reads, quotes and permission checks against it; stops the chain. |
| `pnpm sdk:test:base` | Read-only SDK checks against the live Base deployment. |

**Indexer** (`apps/indexer`)

| Command | What it does |
|---|---|
| `pnpm infra:up` / `infra:down` | Starts / stops Postgres and Redis (Docker Compose). |
| `pnpm indexer:migrate` | Applies database migrations only (the worker does this on start too). |
| `pnpm indexer:worker` | Follows the chain and writes to Postgres (see step 3). |
| `pnpm indexer:server` | Serves the API on 8787 (see step 3). |
| `pnpm indexer:test` | The indexer suites. Needs the demo chain running and `INDEXER_TEST_DATABASE_URL` set to a **disposable** database, which is wiped on every run (see `apps/indexer/README.md`). |
| `pnpm indexer:typecheck` | Type checks. |

**Web app** (`apps/web`)

| Command | What it does |
|---|---|
| `pnpm web:dev` | Dev server on 5173 for the local fork (see step 3). |
| `pnpm web:build` | Type checks and builds the production bundle into `apps/web/dist`. |
| `pnpm web:test` | Pure tests of the policy and strategy term modules, plus fork flows (Safe, tokens, anchor, liquidity, policy, strategy, a real fill) that run when the demo chain is up; it is snapshotted and restored. |
| `pnpm web:typecheck` | Type checks. |

**Live Base deployment** (needs the Base lines in `.env`; see *Run the app against Base mainnet*)

| Command | What it does |
|---|---|
| `pnpm base:worker` / `base:server` | The indexer worker and the API (port 8788) for Base, with their own database `BASE_DATABASE_URL`. |
| `pnpm base:web` | The web app for Base on 5173, proxying to the Base API. |
| `pnpm base:fills` | Dry run of a few real trades against a Base strategy (`STRATEGY=0x…`; add `--broadcast` to send). |

## Tests at a glance

```sh
pnpm contracts:test                     # contracts (add MAINNET_RPC_URL for the fork suites)
pnpm packages:test && pnpm replay:test  # SDK, chain registry, scenario evidence
pnpm replay:serve                       # then, in another terminal, with the chain running:
INDEXER_TEST_DATABASE_URL=postgres://mandate:mandate@127.0.0.1:5432/mandate_test pnpm indexer:test
pnpm web:test
```

`apps/indexer/test/lifecycle.test.ts` runs the whole platform on the fork with the real contracts, API, indexer and
prober. It covers a TokenFactory launch funding a new 2-of-2 Safe, the module, an anchor with seeded and settled
liquidity, the treasury policy, and a listed market maker. Then a strategy proposal, the market maker's signed
acceptance, execution through the Safe and a taker trade. It ends with both sides' analytics, including execution
quality, and a scored market maker. Chain-backed suites snapshot and restore the fork, so the demo stays intact.
Scenario inputs, evidence format and synthetic-data disclosures are in [`replay/README.md`](replay/README.md).

## Partner integrations (for judges)

Line links point at the contracts on this branch. Deployed addresses are in [`deployments/8453.json`](deployments/8453.json)
and the canonical protocol addresses in [`config/chains/8453.json`](config/chains/8453.json).

### Uniswap v4: the price and risk oracle every fill is checked against

| What | Where |
|---|---|
| Hook on OpenZeppelin `BaseOracleHook`: TWAP observations, plus `beforeAddLiquidity` | [`MandateOracleHook.sol` L54-L57](contracts/src/hook/MandateOracleHook.sol#L54-L57) (permissions) |
| Pool initialisation time (pool age) | [`MandateOracleHook.sol` L59-L66](contracts/src/hook/MandateOracleHook.sol#L59-L66) (`_afterInitialize`) |
| Trusted liquidity: adds only count after a settle window (no just-in-time depth) | [`MandateOracleHook.sol` L68-L90](contracts/src/hook/MandateOracleHook.sol#L68-L90) (`_beforeAddLiquidity`, `trustedLiquidity`) |
| Pair oracle: spot (`StateLibrary.getSlot0`), long and short TWAP (`observe`), trusted depth, pool age | [`UniswapV4MarketOracle.sol` L64-L84](contracts/src/anchor/UniswapV4MarketOracle.sol#L64-L84) (`health`), [L87-L99](contracts/src/anchor/UniswapV4MarketOracle.sol#L87-L99) (TWAP) |
| Depth within ±band with `SqrtPriceMath` | [`UniswapV4MarketOracle.sol` L102-L119](contracts/src/anchor/UniswapV4MarketOracle.sol#L102-L119) (`_depth`) |
| Launching a pool on the canonical PoolManager with the hook, growing the observation buffer to 300 | [`AnchorLauncher.sol` L66-L96](contracts/src/anchor/AnchorLauncher.sol#L66-L96) (`launch`) |
| The quoter reads the oracle on every fill and derives Normal / Defensive / Paused | [`MandateQuoter.sol` L322-L325](contracts/src/quoter/MandateQuoter.sol#L322-L325), [`RiskModes.sol`](contracts/src/libraries/RiskModes.sol) |
| Full-range liquidity from the Safe via the canonical PositionManager (web) | [`packages/sdk/src/liquidity.ts`](packages/sdk/src/liquidity.ts), [`LiquidityPanel.tsx`](apps/web/src/onboarding/LiquidityPanel.tsx) |
| Fork tests against the canonical PoolManager: pump, crash, JIT liquidity, young pool | [`MarketOracle.fork.t.sol`](contracts/test/fork/MarketOracle.fork.t.sol), [`MarketRisk.fork.t.sol`](contracts/test/fork/MarketRisk.fork.t.sol), [`AnchorLauncher.fork.t.sol`](contracts/test/fork/AnchorLauncher.fork.t.sol) |

On Base: PoolManager `0x498581fF718922c3f8e6A244956aF099B2652b2b` (canonical), our hook
[`0xE3498691dD0cB1e3870C5da43579d51e0B961880`](https://basescan.org/address/0xE3498691dD0cB1e3870C5da43579d51e0B961880).
Developer feedback: [`FEEDBACK.md`](FEEDBACK.md).

### 1inch Aqua + SwapVM: the strategies themselves

Mandate uses the **official, unmodified** Aqua and AquaSwapVMRouter (swap-vm v1.0.2) at their canonical addresses:
Aqua `0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a`, router `0x111111338c5091e8440b67B168Bae16a668ac0dE`. Tokens stay
in the Safe as Aqua virtual balances and only move when a taker fills.

| What | Where |
|---|---|
| A strategy is a SwapVM order whose program is `[salt, Extruction(MandateQuoter)]` | [`MandateStrategy.sol` L14-L48](contracts/src/libraries/MandateStrategy.sol#L14-L48) (`order`), [`AquaProgram.sol` L41-L43](contracts/src/libraries/AquaProgram.sol#L41-L43) |
| `MandateQuoter` is the Extruction target: prices every fill and refuses any that breaks the policy | [`MandateQuoter.sol` L99-L130](contracts/src/quoter/MandateQuoter.sol#L99-L130) (`extruction`), [L170-L210](contracts/src/quoter/MandateQuoter.sol#L170-L210) (`_evaluate`) |
| The Safe ships inventory to Aqua (`IAqua.ship`) through the Safe module | [`MandateModule.sol` L399-L410](contracts/src/module/MandateModule.sol#L399-L410) (`_ship`) |
| Backing check against Aqua's `rawBalances` across every live strategy | [`MandateModule.sol` L429-L438](contracts/src/module/MandateModule.sol#L429-L438) (`_requireBacking`) |
| Docking on revoke (`IAqua.dock`) | [`MandateModule.sol` L451-L454](contracts/src/module/MandateModule.sol#L451-L454) |
| Fork tests: real fills through the canonical router against a 2-of-2 Safe | [`AquaFill.fork.t.sol`](contracts/test/fork/AquaFill.fork.t.sol), [`MandateModule.fork.t.sol`](contracts/test/fork/MandateModule.fork.t.sol) |

**Onchain token transfers on Base mainnet** through the canonical router (demo treasury, see below): a
[buy](https://basescan.org/tx/0xc63828661076fc057f8c6deacbb170d219d76658cfa3ee2882f478dd32ee3ec2), a
[buy](https://basescan.org/tx/0x876ef7b5184ff0f2a4d346cf7ced060b327737dac14d1bb6721b220921f2fd40) and a
[buyback](https://basescan.org/tx/0xc98df9e262b641b7a77cf2771f345fef34802ad3e8ab19eec4f483039ffcdc15), plus the
[ship](https://basescan.org/tx/0xafc69ebfa18d9d278eeb3e139368ae2f2e51d0e5ead71678de0b0fc85a54e501) that funded the order
from the Safe. Locally, `pnpm fork` runs the same contracts on a mainnet fork.

## Live on Base mainnet

**v2 (policies and strategies)** was deployed at block 54111087 by `contracts/script/live/DeployBase.s.sol` with **mock
tokens** against the canonical Aqua, SwapVM router, Uniswap v4 PoolManager and Safe 1.4.1. Source of truth:
[`deployments/8453.json`](deployments/8453.json).

| Contract | Address |
|---|---|
| MandateModule | [`0x0BaB320f821Ef1684de6463C1506aEC0Ce24E615`](https://basescan.org/address/0x0BaB320f821Ef1684de6463C1506aEC0Ce24E615) |
| MandateQuoter | [`0x9A8F9123752E31a8577380c356d3F44959E9f8c8`](https://basescan.org/address/0x9A8F9123752E31a8577380c356d3F44959E9f8c8) |
| MandateOracleHook (afterInitialize, beforeAddLiquidity, beforeSwap; 10-minute settle) | [`0xE3498691dD0cB1e3870C5da43579d51e0B961880`](https://basescan.org/address/0xE3498691dD0cB1e3870C5da43579d51e0B961880) |
| AnchorLauncher | [`0xC2B7b39584705668cE47ceF2ab9F930c07F8Aa53`](https://basescan.org/address/0xC2B7b39584705668cE47ceF2ab9F930c07F8Aa53) |
| Demo pair market oracle (mLAUNCH/mUSD) | [`0x8ef6314610087E0bBCe13466a3cC1CdD678F990e`](https://basescan.org/address/0x8ef6314610087E0bBCe13466a3cC1CdD678F990e) |
| TokenFactory (kept from v1) | [`0x32feE1f159E80eE007B0d750d4eb47A513e40311`](https://basescan.org/address/0x32feE1f159E80eE007B0d750d4eb47A513e40311) |
| Issuer Safe (2-of-2: Safe Owner 1 + Safe Owner 2) | [`0xaD4e23999d17FAFa2E351640127197D12328565b`](https://basescan.org/address/0xaD4e23999d17FAFa2E351640127197D12328565b) |
| mLAUNCH / mUSD | [`0xD88907F8278C3A3a90e5acCcaE87154cf5e3d516`](https://basescan.org/token/0xD88907F8278C3A3a90e5acCcaE87154cf5e3d516) / [`0x7a4088D9EA49Ee2ae48d55d1A0d6d9C47dC035BB`](https://basescan.org/token/0x7a4088D9EA49Ee2ae48d55d1A0d6d9C47dC035BB) |

The Safe holds 1M mLAUNCH and 400k mUSD (demo inventory), and Owner 1 has approved `enableModule`. No policy or
strategy exists yet: Safe Owner 2 executes `enableModule` in `/launch`, then the owners set the treasury policy and
propose a strategy to the Market Maker with their own values.

| Role | Address |
|---|---|
| Safe Owner 1 (also deployer) | `0x54f75F0E0da2b43b3a6AC0a0e5c4f5Df6B73308e` |
| Safe Owner 2 | `0x6a4fb4561051dD5B25619ab997152892008C7bF6` |
| Market Maker | `0xbDafcA30260a4a5550cAD1F11928b26f1B063126` |

**Demo treasury.** A second, complete treasury runs on the same v2 contracts with its own three wallets, built by
`apps/web/scripts/base-demo.ts` through the same SDK builders, two-owner Safe flow and API the app uses (it leaves
the pinned roles above untouched):

| | Address |
|---|---|
| Issuer Safe (2-of-2: Demo Owner 1 + Demo Owner 2) | [`0x807CBEd6139886044E6F30c1105389855B097904`](https://basescan.org/address/0x807CBEd6139886044E6F30c1105389855B097904) |
| Demo Orbit (dORBIT, launched by TokenFactory) / Demo Dollar (dUSD, mock) | [`0xC593D152c38446EB88Bb2FF3D05b6464De32C914`](https://basescan.org/token/0xC593D152c38446EB88Bb2FF3D05b6464De32C914) / [`0x2D718b826aB88023b693D1bd8531D83054d7e877`](https://basescan.org/token/0x2D718b826aB88023b693D1bd8531D83054d7e877) |
| Pair market oracle (anchor at 0.40 dUSD) | [`0x2376eD3BDC8eA7faC0EBeFb978855878aC6A692D`](https://basescan.org/address/0x2376eD3BDC8eA7faC0EBeFb978855878aC6A692D) |
| Policy | `0x4450aef3628ebf5a11a3f0d28718e785904bddff9636774659280a954934a50f` ([created](https://basescan.org/tx/0xf04e571209a8ab21e0b1f119eb122eb371870bb2e44b72778b287dd43274f01b)) |
| Strategy (market making, accepted by the MM's signature) | `0x9437324f15c945ba1524b1fee126c1087516dc6187f1d223daebff10214d3e7e` ([added](https://basescan.org/tx/0xafc69ebfa18d9d278eeb3e139368ae2f2e51d0e5ead71678de0b0fc85a54e501)) |
| Test trade: Demo Owner 2 buys 500 dORBIT from the strategy through the SwapVM router | [trade](https://basescan.org/tx/0xc63828661076fc057f8c6deacbb170d219d76658cfa3ee2882f478dd32ee3ec2) |
| More trades (`trades`): buy 80, sell back 200, buy 150, sell back 150, buy 150, sell back 100 dORBIT | [1](https://basescan.org/tx/0x876ef7b5184ff0f2a4d346cf7ced060b327737dac14d1bb6721b220921f2fd40) · [2](https://basescan.org/tx/0xc98df9e262b641b7a77cf2771f345fef34802ad3e8ab19eec4f483039ffcdc15) · [3](https://basescan.org/tx/0xc6d562cec472a76c9af009995ec9aa71aa317a0e992a9011146a05c4d9d7efd1) · [4](https://basescan.org/tx/0xf251151169dccd3dd73efcc4331b261a381246efcbae74488436eb92815e2fa9) · [5](https://basescan.org/tx/0xfa8949a14f259e31ef5ca776858dcdec579c867d069182fbc923dfb784b17091) · [6](https://basescan.org/tx/0x8fe33814c66c8428613c7137a33098cc90b6dd150ca78b19b405a38f29d755df) |
| Demo Owner 1 / Demo Owner 2 / Demo Market Maker | `0x174F75176b73124627116653085Ce9585E261388` / `0x9A6D76cB905Df126832AEB1802A27a1b37a6e872` / `0x5F8b93e830a42200CB85420e89BE5FC9154F9192` |

Run it with the demo keys in `.env` (`DEMO_OWNER1_PRIVATE_KEY`, `DEMO_OWNER2_PRIVATE_KEY`, `DEMO_MM_PRIVATE_KEY`) and the
Base API running: `node --env-file=../../.env scripts/base-demo.ts setup|strategy|trade|status` from `apps/web`. Each
phase saves progress in `.local/base-demo.json`, so a re-run continues where it stopped. The policy pauses trading
until its TWAP has 30 minutes of history and the pool is an hour old. For the test trade the owners shortened those
checks with `relax` ([update](https://basescan.org/tx/0x27562c5cdd7873df7080c4cafd142fcec16b5120c5414b9e9dec3838573851a6):
TWAP 5 min, short TWAP 2 min, pool age 5 min), traded, and put them back with `restore`
([update](https://basescan.org/tx/0xac260c7d11eb35b060c3e61b239840149f91543da77de0bd83bb033e2e778a34)). A first attempt
at 1,000 dORBIT was refused by the release schedule: on day one only about 590 of the allotment had unlocked.
A second relax → `trades` → restore round filled both sides at the strategy's 0.8% spread (buys near 0.405 dUSD,
buybacks near 0.398); the policy then counted 880 dORBIT gross sold, 430 net and 179.24 dUSD of buyback budget spent.

**v1 (single mandates)** ran on Base from block 53927227 with mock tokens against the canonical Aqua, SwapVM router,
Uniswap v4 PoolManager and Safe 1.4.1; its manifest is archived in
[`deployments/archive/8453-v1.json`](deployments/archive/8453-v1.json). It took real fills through the canonical
router ([buy](https://basescan.org/tx/0x32d0ac09f07a57c109cad6fc9f64ed3cb824456a86e36de89db5202b146c8e1b),
[buyback](https://basescan.org/tx/0x9d1c4c6905a8c2c9bc14b5f166895b1e4c7592dfd2a5841a6486ca1d8541f4e1)), an MM
[reship](https://basescan.org/tx/0xdf020edf1fabe4445f203a2f8257c263fc59fe2cb7f821edeb80e67c2fedc461) and
[fee claim](https://basescan.org/tx/0xc206be514f7091f50db3c35322708874184fc860dc3e87bbe92205083a155f07), a
[revoke](https://basescan.org/tx/0x1a39831c68cc3bb572d75e880d73804ddffae92f121c710e036c9d7f2db443d2), and a self-serve
onboarding with a 2-of-2 Safe where one owner used scripts and the other the wizard
([createMandate](https://basescan.org/tx/0xf3745211cf11f308d8400d6e894cd5aa2205b5940fabaa6c59cf8ab138f1a4f3)).

**Self-serve.** `/launch` takes a project from nothing to a live strategy, each step a transaction its own wallets
sign: treasury Safe, token pair, enable the module, launch the anchor and add liquidity, set the treasury policy, then
propose a strategy to a market maker (or add one directly). Co-owners approve from a shared link, in the browser or with
`apps/web/scripts/approve-terms.ts`.

Scripts: `contracts/script/live/` (`DeployBase`, `LiveFills`, `OnboardPair`, `DeployTokenFactory`). The demo roles
(Safe Owner 2 `0x6a4fb4561051dD5B25619ab997152892008C7bF6`, Market Maker `0xbDafcA30260a4a5550cAD1F11928b26f1B063126`)
are constants in `LiveConfig.sol`; no script replaces them.
Run the Base stack with `pnpm base:worker`, `pnpm base:server` and `pnpm base:web`.

## License

[MIT](LICENSE). Contract sources carry `SPDX-License-Identifier: MIT`.
