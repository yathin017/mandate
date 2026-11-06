# @mandate/web

Mandate's dashboard: Vite 8 + React 19 + TypeScript, Tailwind 4 and [shadcn/ui](https://ui.shadcn.com) (Radix,
Nova preset) with the project's [tweakcn theme](https://tweakcn.com/themes/cmmea3qbd000004jvb99v39cd). Mandate
status colours (`filled`, `blocked`, `warning`) are added on top of the theme in `src/index.css`.

**Dashboards read only the indexer API.** The chain RPC is used only inside wallet flows (Issuer console, MM desk
and onboarding): Safe owners/nonce/approvals, token and anchor reads, pre-send simulation and receipts. The onboarding
wizard reads everything it needs from the chain, so it works without a running indexer. Contract addresses for
anything a user signs come from the build-time `@mandate/chains` registry, never from API responses.

## Run it

```sh
pnpm infra:up          # Postgres + Redis (Docker)
pnpm replay:serve      # demo fork (127.0.0.1:8547)
pnpm indexer:worker    # indexes it
pnpm indexer:server    # API on 127.0.0.1:8787
pnpm web:dev           # http://localhost:5173, /api proxied to the API
```

Production: `VITE_API_URL=https://api.example VITE_RPC_URL=https://rpc.example pnpm web:build`, then serve `apps/web/dist` and add the site's
origin to the API's `API_CORS_ORIGINS`. `MANDATE_API_PROXY` changes the dev proxy target. Both can live in
`apps/web/.env` (see `apps/web/.env.example`).

## Pages

Navigation is by role: public discovery (Explore, Market makers), then each side's workspace (Launch and Issuer
for issuers, Desk for market makers).

| Route | What it shows |
|---|---|
| `/` | Landing for issuers and market makers: calls to action, live counts, how it works, honest limits |
| `/explore` | Mandates (cards) and tokens launched through the TokenFactory (`?tab=tokens`) |
| `/market-makers` | Listed market makers ranked by onchain score |
| `/market-makers/:address` | Profile, score with each component's weight, value and evidence, and the market maker's mandates |
| `/launch` | Self-serve wizard: treasury Safe → token pair (launch a new token) → enable Mandate → price anchor (launch it, then add full-range liquidity from the Safe in one batched transaction) → mandate: propose to a market maker from the marketplace (default) or create directly |
| `/issuer` | One Safe at a glance: Safe-wide counts, proposals with their next step (send, withdraw, execute once the market maker signed), each mandate's progress (sold of released, today vs cap, fills, volume, MM fees, refused trades) and pause/unpause/revoke as Safe transactions |
| `/desk` | Market maker's workspace (`?tab=`): **Inbox** (proposals with the full terms, accept by signing or decline), **My mandates** (spread and daily-cap sliders inside the issuer's bounds, inventory caps, re-ship, pause, claim fees, a simulate-only "exceed the cap" probe), **Profile** (marketplace listing), **Performance** (score with evidence; per mandate fills, volume, earned and claimable fee share, refused trades) |
| `/mandates/:id` | Public mandate page: sell-limit ring, release curve vs sold, spot/TWAP band and floor, anchor health, MM pay, live activity feed, server-simulated "try a trade", numbered term sheet |

`/mandates` and `/onboard` redirect to `/explore` and `/launch` (query strings kept).

**Sign-in.** Connecting a wallet is enough to browse and send transactions. Profiles and proposals also need
**Sign in** in the header: an EIP-4361 message for this site, no gas. The session is an HttpOnly cookie, so the API
must be served from the same site as the app (the dev proxy does this); a session only counts for the wallet that is
connected, and disconnecting signs out.

## Proposing to a market maker

1. In `/launch` step 5 (or from a market maker's page, which opens it with `?mm=`), pick a market maker, set the
   terms and **Send proposal** (signed-in Safe owner).
2. The market maker accepts in its Desk inbox by signing the exact terms (EIP-712; no gas), after reading them back
   field by field with the Safe's balance.
3. Any owner opens the proposal (wizard or `/issuer`): one approves, another executes `createMandate`; the app then
   links the new mandate to the proposal. It re-checks for an existing match first, so a retry never creates a second
   mandate from the same terms.

## Wallet demo on Base (live deployment)

`pnpm base:web` (with `pnpm base:worker` and `pnpm base:server` running). Wallets on Base mainnet:

| Role | Address | Can |
|---|---|---|
| Safe Owner 1 | `0x54f75F0E0da2b43b3a6AC0a0e5c4f5Df6B73308e` | approve / execute issuer actions |
| Safe Owner 2 | `0x6a4fb4561051dD5B25619ab997152892008C7bF6` | approve / execute issuer actions |
| Market Maker | `0xbDafcA30260a4a5550cAD1F11928b26f1B063126` | reship within bounds, pause, claim fees on the MM desk |

Issuer actions need both owners: one clicks **Approve as owner**, the other **Execute**. The connected wallet's role
is shown next to its address in the header.

## Self-serve launch (`/launch`)

Five steps, each read back from the chain; choices live in the URL (`?safe=…&base=…&quote=…`), so every owner can
open the same link and continue.

1. **Treasury Safe:** create a Safe 1.4.1 (owners, threshold) or use an existing one.
2. **Token pair:** base by address (or, on demo deployments, mint a "Demo …" token straight into the Safe); quote from
   the chain's canonical USDC/WETH, the demo quote, or any address. Look-alike symbols are flagged.
3. **Enable Mandate:** the owners enable the module through the Safe.
4. **Price anchor:** one `AnchorLauncher` transaction creates the Uniswap v4 pool (if missing) with the oracle hook and
   deploys the anchor. The step shows the pool price, its depth (or a no-liquidity warning) and a countdown until the
   30-minute TWAP window is covered. Liquidity is added with Uniswap's own tools.
5. **Create the mandate:** market maker, amounts and floor start blank. The form refuses what the module or the
   market would refuse (spread outside the anchor band, inventory above the allotment or the Safe's balance) and
   checks the **starting price**: fills are priced over the shipped balances, so `shippedQuote / shippedBase` must sit
   inside the anchor tolerance of the pool price and above the floor. The review lists every value that will be signed.
   The reviewed terms are added to the URL; Safes with several owners get a **Copy link** prompt so co-owners approve
   the same transaction. Release start is a UTC date, so approvals on different days still match.

An owner whose key lives in a local `.env` (not a browser wallet) can approve shared terms from the CLI. It rebuilds
the call through the same terms module and prints every term; `--broadcast` sends `approveHash`:

```sh
node apps/web/scripts/approve-terms.ts --rpc "$BASE_RPC_URL" --link '<wizard url>' [--nonce <n>] [--key-env BASE_DEPLOYER_PRIVATE_KEY] [--broadcast]
```

On the local fork, the recorded deployment has no launcher: deploy `AnchorLauncher` on the fork and set
`VITE_ANCHOR_LAUNCHER` in `apps/web/.env` (ignored on live chains, which read it from the manifest).

## Wallet demo on the local fork (Issuer console → MM desk)

1. Add a network to MetaMask/Rabby: RPC `http://127.0.0.1:8547`, chain id `31337`, currency ETH.
2. Import Anvil's **public development** accounts (never use them elsewhere):
   - #0 `0xf39F…2266` and #1 `0x7099…79C8`: the two owners of every demo Safe (2-of-2)
   - #2 `0x3C44…93BC`: the market maker of the mandate you create
   Their private keys are printed by `anvil` at startup and listed in the Foundry book.
3. `/issuer` as #0: **Review terms** → **Approve as owner** (sends `approveHash`).
4. Switch to #1: **Review terms** → **Execute** (sends `execTransaction` with both approvals).
5. Switch to #2, open `/desk`: try **Try to exceed the issuer's cap** (refused, nothing sent), move the spread
   slider, **Re-ship strategy**.

Every action is simulated first; a refusal shows the BLOCKED stamp and its reason and sends nothing. After a
confirmation the app waits for the indexer before refreshing. Release start is entered as a UTC date, so both
owners build the same Safe transaction hash.

`pnpm web:test` runs the terms unit tests and, against the live fork with Anvil's unlocked accounts, the Safe and MM
flows and every onboarding step up to a taker fill on a new mandate, using the app's own `safeTx` and terms helpers.
Each fork file snapshots and restores the fork, so the files run one at a time.

## Data flow

`src/lib/api.ts` (typed client) → React Query hooks in `src/lib/hooks.ts`. `useMandateStream` opens the
indexer's SSE stream and invalidates the mandate's queries on `change`; the stream itself carries no data.
Amounts and prices stay bigint until formatted (`src/lib/format.ts`).

## Conventions

- Every synthetic or simulated value carries a visible tag (`SyntheticTag`); hovering a gauge figure names
  the contract function and block it came from (`Source`).
- Refusals always show the plain-language reason from the indexer next to the stamp; raw reverts are never shown.
- Layouts are checked at 375px width with no horizontal scroll.
