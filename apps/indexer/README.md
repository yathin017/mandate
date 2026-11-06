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
pnpm infra:up                        # docker compose: Postgres 16 + Redis 7 on loopback (needs Docker running)
cp .env.example .env                 # DATABASE_URL, REDIS_URL, INDEXER_* and API_* settings
pnpm install --frozen-lockfile
pnpm replay:serve                    # terminal 1: verified demo fork on 127.0.0.1:8547, kept alive
pnpm indexer:worker                  # terminal 2: migrates, then follows the chain
pnpm indexer:server                  # terminal 3: API on 127.0.0.1:8787 (start after the worker has migrated)
```

Both processes check their dependencies first and exit with one actionable line if Postgres, the schema or the
chain RPC is missing. Redis being down is only a warning.

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
| TokenFactory (manifest `tokenFactory`, or `INDEXER_TOKEN_FACTORY` on a fork) | `TokenLaunched` | `launched_tokens`, `tokens` |
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
| GET | `/v1/auth/nonce` | One-time sign-in nonce, plus the chain id and statement the message must use |
| POST | `/v1/auth/verify` | `{ message, signature }` (EIP-4361) → session cookie |
| GET | `/v1/auth/session` | The caller's session (`address`, `chainId`, `expiresAt`) or 401 |
| POST | `/v1/auth/logout` | Revokes the session, clears the cookie |
| GET | `/v1/chains/:chainId/mms/scores` | Score and evidence for every market maker with a mandate on the chain |
| GET | `/v1/chains/:chainId/mms/:address/score` | One market maker's score (404 without mandates) |
| GET | `/v1/chains/:chainId/tokens/launched?creator=&recipient=` | Tokens launched through the chain's TokenFactory, newest first |
| GET | `/v1/mms` | Listed market-maker profiles (public) |
| GET | `/v1/mms/:address` | One profile, listed or not |
| PUT | `/v1/mms/me` | Create/replace the signed-in wallet's profile |
| POST | `/v1/proposals` | A Safe owner drafts terms for a market maker (`send: true` sends at once) |
| GET | `/v1/proposals?safe=` / `?as=mm` | A Safe's proposals (owners) / those addressed to the caller (no drafts) |
| GET | `/v1/proposals/:id` | One proposal, for its Safe's owners or its market maker |
| POST | `/v1/proposals/:id/send` · `withdraw` · `accept` · `decline` · `executed` | Lifecycle transitions (see below) |

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
| `mandate:v1:auth:nonce:{nonce}` | unused sign-in nonce | consumed by `GETDEL`; 10 min TTL |
| `mandate:v1:auth:session:{tokenHash}` | session lookup | deleted on sign-out; TTL ≤ 60s and ≤ session expiry |
| `mandate:v1:rl:auth:{ip}:{minute}` | sign-in request count | 60s TTL |
| `mandate:v1:safe-owners:{chain}:{safe}` | a Safe's owners, from the chain | 60s TTL (a removed owner keeps access ≤ 60s) |
| `mandate:v1:mms:list` | public market-maker list | deleted on every profile write; 30s TTL |
| `mandate:v1:rl:{profile,proposals}:{ip}:{minute}` | marketplace write count | 60s TTL |

Redis calls fail fast. When Redis is down, reads come from Postgres, streams return 503 and simulations return 503.
Sign-in returns 503 (nonces live only in Redis); existing sessions keep working from Postgres.

## Sign-in (EIP-4361)

Wallet sign-in for the platform's off-chain features (market-maker profiles, proposals). The client fetches a
nonce, has the wallet sign a SIWE message and posts it to `/v1/auth/verify`. The server accepts it only if:

- its domain and URI are an `API_AUTH_ORIGINS` web origin, and that origin sent the request (`Origin` header);
- it names the indexed chain, the fixed statement, and was issued within the last 10 minutes;
- its nonce was issued here and is unused (consumed before the signature check, so a message works once);
- the signature verifies through the chain RPC (EOAs, ERC-1271 smart wallets and ERC-6492 counterfactual ones).

The session is a random 256-bit token in an HttpOnly, SameSite=Strict cookie (Secure with the `__Host-` prefix
unless `API_SESSION_COOKIE_SECURE=false`). Postgres stores only its SHA-256, in `auth_sessions`, next to the
`accounts` row for the wallet. Sessions last `API_SESSION_TTL_HOURS` (default 7 days) and are not extended by use.
`requireSession` (in `src/auth/routes.ts`) guards future routes that act for a wallet; `requireAllowedOrigin` is
the CSRF check for their state-changing requests. The web app must reach the API on the same site (in development
the Vite proxy does this) for the SameSite cookie to be sent.

## Marketplace

**Profiles** (`mm_profiles`) are written only by the signed-in wallet they describe. Text fields are stripped of
control and bidi characters and length-capped; the website must be `https`. Profiles never carry performance: the
market-maker score is computed from indexed chain data.

**Proposals** are how an issuer Safe and a market maker agree before anything happens onchain:

```
draft ──send──▶ sent ──accept──▶ accepted ──executed──▶ executed
  │               │──decline──▶ declined
  └──withdraw─────┴──────────────┴──▶ withdrawn            (any of draft/sent/accepted past expiry ▶ expired)
```

- Owner actions (create, send, withdraw, executed) need a signed-in wallet that is a **current owner of the Safe**,
  read from the Safe itself. Any owner may act, not only the creator.
- Sending simulates `createMandate` from the Safe (`eth_call`), so terms the module would refuse are rejected with
  its reason before the market maker is asked.
- Accepting needs the market maker's EIP-712 signature over `MandateTerms` (proposal id, Safe, parties, bounds,
  params, expiry; domain = chain + module). It is verified through the RPC (EOA, ERC-1271, ERC-6492) and stored.
- `executed` is recorded only if the module's mandate has the proposal's Safe, market maker, pair and every bound;
  params may already differ (the market maker can reship). A mandate links to at most one proposal.
- Each transition is one conditional `UPDATE … WHERE status IN (…) AND expires_at > now()`, so concurrent
  requests cannot skip states. Expiry is 1 hour to 30 days after creation.

## Market-maker score

0-100 from onchain evidence only, over the trailing 30 days of chain time, computed at the indexed head and served
from the head-scoped response cache. Each component is returned with the evidence behind it.

| Component | Weight | Measure |
|---|---|---|
| Availability | 35% | Probe rounds that would fill ÷ rounds that would fill or failed for the market maker's reason |
| Price quality | 20% | 1 − volume-weighted (\|fill price − TWAP\| ÷ the mandate's anchor tolerance), TWAP from the snapshot at the fill's block |
| Volume | 20% | Quote volume (whole tokens), log-scaled against the busiest market maker on the chain |
| Reliability | 15% | Share of mandates not revoked × min(1, days under management ÷ 30) |
| Responsiveness | 10% | 1 − min(1, median minutes ÷ 120) to recover from a fault, or to reship after an issuer bounds change |

**Probes.** The worker runs `Prober` beside the indexer: every `INDEXER_PROBE_INTERVAL_S` (default 600, 0 = off) it
quotes each live mandate at the indexed head, one small buy and one small sell (0.1% of the shipped inventory),
through the SwapVM router with `eth_call`. Nothing is sent. `AnchorDeviation`, `InsufficientLiquidity` and
`ZeroBalance`, and a pause by the market maker itself, count against it; issuer rails (floor, daily cap, release),
the anchor's breakers and RPC errors are neutral. Probes reference `blocks`, so reorgs remove them; rows older than
35 days are deleted.

A component without evidence is shown as such and the other weights are rescaled. A market maker with fewer than
six probe rounds and no fills is **new** (no score, never 0). Volume is in quote-token units: comparable across
stablecoin-quoted mandates only (USD conversion is future work).

## Schema

`src/db/schema.ts` is a **draft** and will change with client requirements. Change it only through new
migrations: edit the schema, then `pnpm --filter @mandate/indexer db:generate --name <change>`.
