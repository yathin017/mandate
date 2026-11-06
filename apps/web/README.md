# @mandate/web

Mandate's dashboard: Vite 8 + React 19 + TypeScript, Tailwind 4 and [shadcn/ui](https://ui.shadcn.com) (Radix,
Nova preset) with the project's [tweakcn theme](https://tweakcn.com/themes/cmmea3qbd000004jvb99v39cd). Mandate
status colours (`filled`, `blocked`, `warning`) are added on top of the theme in `src/index.css`.

**Dashboards read only the indexer API.** The chain RPC is used only inside wallet flows (Issuer console and MM
desk): Safe owners/nonce/approvals, pre-send simulation and receipts. Contract addresses for anything a user signs
come from the build-time `@mandate/chains` registry, never from API responses.

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

| Route | What it shows |
|---|---|
| `/` | The old deal vs Mandate, honest limits |
| `/replay` | Replay theater: receipt-backed acts from `/v1/replay`, split view, damage counter, BLOCKED stamps |
| `/mandates` | Indexed mandates |
| `/issuer` | Issuer console: pick a Safe, see owners/threshold/module, pause/unpause/revoke, create-mandate wizard; every action is a Safe transaction approved onchain by its owners |
| `/desk` | MM desk: mandates where the connected wallet is the MM; spread and daily-cap sliders clamped to the issuer's bounds, inventory caps, live vs new preview, re-ship, pause, claim fees, and a simulate-only "exceed the cap" probe |
| `/mandates/:id` | Public mandate page: sell-limit ring, release curve vs sold, spot/TWAP band and floor, anchor health, MM pay, live activity feed, server-simulated "try a trade", numbered term sheet |

## Wallet demo (Issuer console → MM desk)

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
confirmation the app waits for the indexer before refreshing. The create payload rounds release start to the UTC
day so both owners sign the same Safe transaction hash.

`pnpm web:test` runs the same Safe and MM flows against the live fork with Anvil's unlocked accounts, using the
app's own `safeTx` helpers, and restores the fork afterwards.

## Data flow

`src/lib/api.ts` (typed client) → React Query hooks in `src/lib/hooks.ts`. `useMandateStream` opens the
indexer's SSE stream and invalidates the mandate's queries on `change`; the stream itself carries no data.
Amounts and prices stay bigint until formatted (`src/lib/format.ts`).

## Conventions

- Every synthetic or simulated value carries a visible tag (`SyntheticTag`); hovering a gauge figure names
  the contract function and block it came from (`Source`).
- Refusals always show the plain-language reason from the indexer next to the stamp; raw reverts are never shown.
- Layouts are checked at 375px width with no horizontal scroll.
