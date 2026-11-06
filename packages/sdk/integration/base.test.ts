import assert from "node:assert/strict";
import test from "node:test";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { getDeployment, isLiveDeployment } from "@mandate/chains";
import { ANCHOR_POOL_FEE, ANCHOR_POOL_TICK_SPACING, anchorLauncherAbi, readAnchorStatus, readTokenInfo } from "@mandate/sdk";

/**
 * Read-only checks against the live Base deployment. Skipped when the RPC is unreachable.
 * Run with `pnpm sdk:test:base` (uses BASE_RPC_URL, default https://mainnet.base.org).
 */
const RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const reachable = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
  body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).then((r) => r.ok).catch(() => false);
const deployment = getDeployment(8453);
const client = createPublicClient({ transport: http(RPC, { retryCount: 3, retryDelay: 1000 }) }) as PublicClient;

test("live Base onboarding reads", { skip: reachable ? false : `RPC ${RPC} unreachable` }, async (t) => {
  assert.ok(isLiveDeployment(deployment) && deployment.anchorLauncher, "launcher recorded in the manifest");
  const launcher = deployment.anchorLauncher as Address;

  await t.test("launcher constants match the SDK's pool parameters", async () => {
    assert.equal(await client.readContract({ address: launcher, abi: anchorLauncherAbi, functionName: "FEE" }), ANCHOR_POOL_FEE);
    assert.equal(await client.readContract({ address: launcher, abi: anchorLauncherAbi, functionName: "TICK_SPACING" }), ANCHOR_POOL_TICK_SPACING);
    assert.equal(await client.readContract({ address: launcher, abi: anchorLauncherAbi, functionName: "HOOK" }), deployment.hook);
  });

  await t.test("demo pair: existing pool, deep buffer, ready, priced near 0.40", async () => {
    const status = await readAnchorStatus(client, { chainId: 8453, launcher, base: deployment.base, quote: deployment.quote });
    assert.equal(status.poolId, "0x5c3b24653373b7140cb57a53a28d5ab38cb5eb5c3c18dc3cc28fc5c214eea83c");
    assert.ok(status.poolExists);
    assert.equal(status.anchor, null, "this pool predates the launcher");
    assert.equal(status.liquidity, 600_000_000_000_000_000n);
    assert.equal(status.cardinalityNext, 300);
    assert.ok(status.ready && status.oldestObservation !== null);
    const price = Number(status.spotPriceX36) / 1e24;
    assert.ok(price > 0.3 && price < 0.5, `spot ${price}`);
  });

  await t.test("token checks: mock token ok, hook and empty account rejected", async () => {
    const launch = await readTokenInfo(client, deployment.base);
    assert.ok(launch.ok && launch.symbol === "mLAUNCH" && launch.decimals === 18);
    assert.equal((await readTokenInfo(client, deployment.hook)).ok, false);
    assert.equal((await readTokenInfo(client, "0x000000000000000000000000000000000000dEaD")).ok, false);
  });
});
