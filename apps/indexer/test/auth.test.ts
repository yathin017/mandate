import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { createSiweMessage } from "viem/siwe";
import { privateKeyToAccount } from "viem/accounts";
import postgres from "postgres";

import { createApp } from "../src/api/app.ts";
import { SIWE_STATEMENT } from "../src/auth/routes.ts";
import { hashToken } from "../src/auth/sessions.ts";
import { Cache } from "../src/cache/cache.ts";
import { createChainContext } from "../src/chain.ts";
import { createDb } from "../src/db/client.ts";
import { resetDatabase, skip, testConfig } from "./helpers.ts";

/**
 * Sign-In with Ethereum against the API, with signatures verified through the local fork's RPC. Uses Anvil's
 * public development keys only. The test database is wiped.
 */
const WEB = "http://localhost:5173";
// Anvil accounts #0 and #1: well-known public development keys, never funded anywhere real.
const alice = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const mallory = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

describe("sign-in with Ethereum", { skip }, () => {
  const config = testConfig({ API_AUTH_ORIGINS: WEB, API_AUTH_PER_MINUTE: "50" });
  let cache: Cache;
  let handle: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  /** Each test signs in from its own client address so rate-limit windows never leak between tests. */
  let client = randomUUID();

  before(async () => {
    await resetDatabase(config.DATABASE_URL);
    handle = createDb(config.DATABASE_URL);
    cache = await Cache.connect(config.REDIS_URL);
    const chain = createChainContext(config);
    app = createApp({ db: handle.db, cache, config, log: () => {}, chain: () => chain, clientIp: () => client });
  });
  after(async () => {
    await cache.close();
    await handle.close();
  });

  const nonce = async () => ((await (await app.request("/v1/auth/nonce")).json()) as { nonce: string }).nonce;
  const message = async (overrides: Partial<Parameters<typeof createSiweMessage>[0]> = {}) =>
    createSiweMessage({
      address: alice.address,
      chainId: config.INDEXER_CHAIN_ID,
      domain: new URL(WEB).host,
      uri: WEB,
      nonce: await nonce(),
      statement: SIWE_STATEMENT,
      version: "1",
      issuedAt: new Date(),
      ...overrides,
    });
  const verify = (body: { message: string; signature: string }, origin = WEB) =>
    app.request("/v1/auth/verify", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
  const cookieOf = (response: Response) => response.headers.get("set-cookie")!.split(";")[0]!;

  test("a signed message opens a hardened cookie session that only stores the token hash", async () => {
    client = randomUUID();
    const text = await message();
    const response = await verify({ message: text, signature: await alice.signMessage({ message: text }) });
    assert.equal(response.status, 200);
    const setCookie = response.headers.get("set-cookie")!;
    assert.match(setCookie, /^__Host-mandate_session=/);
    for (const flag of [/HttpOnly/, /Secure/, /SameSite=Strict/, /Path=\//]) assert.match(setCookie, flag);

    const session = (await (await app.request("/v1/auth/session", { headers: { cookie: cookieOf(response) } })).json()) as { data: { address: string } };
    assert.equal(session.data.address, alice.address.toLowerCase());

    const token = cookieOf(response).split("=")[1]!;
    const sql = postgres(config.DATABASE_URL, { max: 1 });
    const rows = await sql`SELECT token_hash FROM auth_sessions`;
    await sql.end();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.token_hash, hashToken(token));
    assert.notEqual(rows[0]!.token_hash, token);
  });

  test("a message works once: replaying it is refused", async () => {
    client = randomUUID();
    const text = await message();
    const signature = await alice.signMessage({ message: text });
    assert.equal((await verify({ message: text, signature })).status, 200);
    const replay = await verify({ message: text, signature });
    assert.equal(replay.status, 401);
    assert.deepEqual(await replay.json(), { error: "unknown or used nonce" });
  });

  test("wrong site, chain, statement, age or signer are refused", async () => {
    client = randomUUID();
    const cases: [string, string, string?][] = [
      ["message is for another site", await message({ domain: "evil.example", uri: "https://evil.example" })],
      ["message is for another chain", await message({ chainId: 8453 })],
      ["unexpected statement", await message({ statement: "Approve everything" })],
      ["message expired", await message({ issuedAt: new Date(Date.now() - 11 * 60_000) })],
    ];
    for (const [reason, text] of cases) {
      const response = await verify({ message: text, signature: await alice.signMessage({ message: text }) });
      assert.equal(response.status, 401, reason);
      assert.deepEqual(await response.json(), { error: reason });
    }
    // Mallory signs a message claiming Alice's address.
    const text = await message();
    const forged = await verify({ message: text, signature: await mallory.signMessage({ message: text }) });
    assert.deepEqual([forged.status, await forged.json()], [401, { error: "invalid signature" }]);
  });

  test("state-changing requests need an allowed Origin", async () => {
    client = randomUUID();
    const text = await message();
    const signature = await alice.signMessage({ message: text });
    assert.equal((await verify({ message: text, signature }, "https://evil.example")).status, 403);
    assert.equal((await app.request("/v1/auth/logout", { method: "POST" })).status, 403);
  });

  test("sign-out revokes the session immediately, cache included", async () => {
    client = randomUUID();
    const text = await message();
    const cookie = cookieOf(await verify({ message: text, signature: await alice.signMessage({ message: text }) }));
    assert.equal((await app.request("/v1/auth/session", { headers: { cookie } })).status, 200); // now cached
    const out = await app.request("/v1/auth/logout", { method: "POST", headers: { cookie, origin: WEB } });
    assert.equal(out.status, 204);
    assert.match(out.headers.get("set-cookie")!, /Max-Age=0/);
    assert.equal((await app.request("/v1/auth/session", { headers: { cookie } })).status, 401);
  });

  test("sign-in steps are rate limited per client", async () => {
    client = randomUUID();
    const statuses: number[] = [];
    for (let i = 0; i < 52; i++) statuses.push((await app.request("/v1/auth/nonce")).status);
    assert.equal(statuses.filter((s) => s === 200).length, 50);
    assert.equal(statuses.at(-1), 429);
    // Session reads are not throttled.
    assert.equal((await app.request("/v1/auth/session")).status, 401);
  });

  test("without configured origins sign-in is off", async () => {
    const off = createApp({ db: handle.db, cache, config: testConfig({ API_AUTH_ORIGINS: "" }), log: () => {} });
    assert.equal((await off.request("/v1/auth/nonce")).status, 503);
  });
});
