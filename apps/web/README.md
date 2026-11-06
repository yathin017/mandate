# @mandate/web

Mandate's dashboard: Vite 8 + React 19 + TypeScript, Tailwind 4 and [shadcn/ui](https://ui.shadcn.com) (Radix,
Nova preset) with the project's [tweakcn theme](https://tweakcn.com/themes/cmmea3qbd000004jvb99v39cd). Mandate
status colours (`filled`, `blocked`, `warning`) are added on top of the theme in `src/index.css`.

**The indexer API is the only data source.** The browser never talks to an RPC, a wallet or the chain directly.

## Run it

```sh
pnpm replay:serve      # demo fork (127.0.0.1:8547)
pnpm indexer:worker    # indexes it
pnpm indexer:server    # API on 127.0.0.1:8787
pnpm web:dev           # http://localhost:5173, /api proxied to the API
```

Production: `VITE_API_URL=https://api.example pnpm web:build`, then serve `apps/web/dist` and add the site's
origin to the API's `API_CORS_ORIGINS`. `MANDATE_API_PROXY` changes the dev proxy target.

## Pages

| Route | What it shows |
|---|---|
| `/` | The old deal vs Mandate, honest limits |
| `/replay` | Replay theater: receipt-backed acts from `/v1/replay`, split view, damage counter, BLOCKED stamps |
| `/mandates` | Indexed mandates |
| `/mandates/:id` | Public mandate page: sell-limit ring, release curve vs sold, spot/TWAP band and floor, anchor health, MM pay, live activity feed, server-simulated "try a trade", numbered term sheet |

## Data flow

`src/lib/api.ts` (typed client) → React Query hooks in `src/lib/hooks.ts`. `useMandateStream` opens the
indexer's SSE stream and invalidates the mandate's queries on `change`; the stream itself carries no data.
Amounts and prices stay bigint until formatted (`src/lib/format.ts`).

## Conventions

- Every synthetic or simulated value carries a visible tag (`SyntheticTag`); hovering a gauge figure names
  the contract function and block it came from (`Source`).
- Refusals always show the plain-language reason from the indexer next to the stamp; raw reverts are never shown.
- Layouts are checked at 375px width with no horizontal scroll.
