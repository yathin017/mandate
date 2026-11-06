# @mandate/indexer

Indexes Mandate's onchain history into Postgres, caches reads in Redis and serves a public JSON API with a live
change stream. Postgres is the source of truth; Redis is disposable.

```
 chain RPC ──▶ worker ──(one tx per block range)──▶ Postgres ◀── API (Hono) ──▶ clients
                  │                                                │  ▲
                  └── head + change events ──▶ Redis ──────────────┘  └── SSE stream
```

## Run it

```sh
docker compose up -d                 # Postgres 16 + Redis 7 on loopback (see compose.yaml)
cp .env.example .env                 # DATABASE_URL, REDIS_URL, INDEXER_* and API_* settings
pnpm install --frozen-lockfile
pnpm replay:serve                    # terminal 1: verified demo fork on 127.0.0.1:8547, kept alive
pnpm indexer:worker                  # terminal 2: migrates, then follows the chain
pnpm indexer:server                  # terminal 3: API on 127.0.0.1:8787
```

Tests need a disposable database and the live demo node. They **wipe** `INDEXER_TEST_DATABASE_URL`:

```sh
INDEXER_TEST_DATABASE_URL=postgres://mandate:mandate@127.0.0.1:5432/mandate_test \
INDEXER_TEST_REDIS_URL=redis://127.0.0.1:6379 pnpm indexer:test
```

Without `INDEXER_TEST_DATABASE_URL` the chain-backed suites are skipped. `pnpm indexer:typecheck` checks types.

## What gets indexed

| Source | Events | Rows |
|---|---|---|
| MandateModule | create, ship/dock, params, bounds, pause, revoke, fee claims | `raw_events`, `mandates` |
| MandateQuoter | `Filled`, `FeeAccrued` | `fills` (fee merged in) |
| ERC20 `symbol`/`decimals` of each mandate's tokens | — | `tokens` (symbols sanitised to 32 printable chars) |
| Demo ScenarioActor (MM) | `Attempted` | `attempts` with `source = onchain_actor` |
| SDK `readSnapshot` at each touched block | counters, release, fees, anchor | `snapshots` |

Logs are accepted only from the contract that defines the event. Actor attempts map to mandates by act number;
v4 market moves and token approvals are skipped.

**Reorgs.** Each range is written in one transaction, and every evidence row references `blocks` with
`ON DELETE CASCADE`. The worker checks that its cursor block is still canonical before anything else (a
replacement chain may be shorter), rolls back to the newest stored block that is canonical, and re-indexes.
Log block hashes and the range end are re-verified after reading.

## API

All amounts are decimal strings in raw token units; prices are `quoteRaw * 1e36 / baseRaw`. Every response
includes `head: { number, hash }`, the block it reflects.

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | DB, Redis and head |
| GET | `/v1/replay` | Committed demo evidence (`replay/data/acts.json`, both sides of each act; `REPLAY_PATH` overrides) |
| GET | `/v1/chains/:chainId/mandates?safe=&mm=` | Mandate projections with token symbol/decimals |
| GET | `/v1/chains/:chainId/mandates/:id` | Terms, latest snapshot, environment disclosure |
| GET | `/v1/chains/:chainId/mandates/:id/activity?limit=&before=` | Fills + blocked/simulated attempts, newest first, keyset cursor in `next` |
| GET | `/v1/chains/:chainId/mandates/:id/series?fromBlock=&toBlock=&limit=` | Snapshots for charts, block order |
| GET | `/v1/chains/:chainId/mandates/:id/stream` | SSE: `ready`, `change`, `heartbeat`; refetch on `change` |
| POST | `/v1/chains/:chainId/mandates/:id/attempts` | `{ taker, tokenIn, tokenOut, amount, isExactIn }` → server-simulated outcome |

`POST …/attempts` never accepts an outcome. The server re-runs the router quote via `eth_call` at the indexed
head and stores the decoded result labeled `simulated`. Repeats in the same block are deduped by the table's
unique key. It is rate limited per socket address (`API_ATTEMPTS_PER_MINUTE`) and fails closed (503) if Redis is
down. Proxy headers are not trusted; put the API behind a proxy only after adding explicit trusted-proxy config.

## Caching

| Key | Contents | Invalidation |
|---|---|---|
| `mandate:v1:head:{chain}` | latest committed head | overwritten by the worker after each commit |
| `mandate:v1:api:{chain}:{headHash}:{route}` | response body | new head → new key; 30s TTL |
| `mandate:v1:ver:{chain}:{id}` | write counter | bumped by simulations; part of feed keys |
| `mandate:v1:rl:attempts:{ip}:{minute}` | request count | 60s TTL |
| `mandate:v1:events:{chain}:{id}` | pub/sub channel | — |

Redis calls fail fast. When Redis is down, reads come from Postgres, streams return 503 and simulations return 503.

## Schema

`src/db/schema.ts` is a **draft** and will change with client requirements. Change it only through new
migrations: edit the schema, then `pnpm --filter @mandate/indexer db:generate --name <change>`.
