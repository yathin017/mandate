import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createPublicClient, http, type Hash } from "viem";
import { parseLocalForkDeployment } from "@mandate/chains";
import { createMandateClient, explainError, buildReshipCall, buildRevokePolicyCall, buildClaimFeesCall,
  mandateModuleAbi, hashAquaOrder } from "@mandate/sdk";

if (!process.env.SDK_RPC_URL || !process.env.SDK_MANIFEST_PATH) throw new Error("Run through pnpm sdk:test:fork");
const deployment = parseLocalForkDeployment(JSON.parse(await readFile(process.env.SDK_MANIFEST_PATH, "utf8")));
const client = createPublicClient({ transport: http(process.env.SDK_RPC_URL) });
const sdk = await createMandateClient(client, deployment);

const { policies, strategies } = deployment;

test("SDK reads canonical fork state with correct block provenance and active order identity", async () => {
  const policy = await sdk.readPolicy(policies.act1);
  assert.equal(policy.policy.safe.toLowerCase(), deployment.safe1.toLowerCase());
  assert.equal(policy.policy.status, 1);
  assert.equal(policy.counters.netSold, 50_000n * 10n ** 18n);
  assert.equal(policy.risk.mode, 0);
  assert.equal(policy.risk.health.priced, true);
  assert.deepEqual(policy.strategyIds, [strategies.act1]);
  const strategy = await sdk.readStrategy(strategies.act1, policy.source.blockNumber);
  assert.equal(strategy.strategy.activeStrategyHash, hashAquaOrder(strategy.activeOrder));
  const block = await client.getBlock({ blockNumber: policy.source.blockNumber });
  assert.equal(block.hash, policy.source.blockHash);
  assert.deepEqual(await sdk.readPolicy(policies.act1, policy.source.blockNumber), policy);
  const list = await sdk.policiesOf(deployment.safe1);
  assert.deepEqual(list.ids, [policies.act1]);
  assert.equal((await sdk.activePolicyOf(deployment.safe1, deployment.base)).id, policies.act1);
  assert.equal((await sdk.activePolicyOf(deployment.safe3, deployment.base)).id, null, "act 3's policy was revoked");
});

test("SDK quotes and decodes actual cap and docked-strategy errors from the deployed router", async () => {
  const input = { taker: deployment.deployer, tokenIn: deployment.quote, tokenOut: deployment.base,
    amount: 100n * 10n ** 6n, isExactIn: true };
  const blocked = await sdk.quote(strategies.act1, input);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.error.errorName, "NetSellCapReached");
  const fill = await sdk.quote(strategies.act2, input);
  assert.equal(fill.ok, true);
  if (fill.ok) { assert.equal(fill.amountIn, input.amount); assert.ok(fill.amountOut > 0n); }
  const revoked = await sdk.quote(strategies.act3, input);
  assert.equal(revoked.ok, false);
  if (!revoked.ok) {
    assert.equal(revoked.error.errorName, "SafeBalancesForTokenNotInActiveStrategy");
    assert.match(revoked.error.message, /docked/);
  }
});

test("SDK prepares role-specific calldata accepted or rejected by the real module permissions", async () => {
  const snapshot = await sdk.readStrategy(strategies.act3);
  assert.equal(snapshot.strategy.status, 3);
  assert.equal(snapshot.strategy.params.spreadBps, 30);
  assert.ok(snapshot.claimed[1] > 0n);
  const reship = buildReshipCall(deployment, strategies.act1, snapshot.strategy.params);
  await assert.rejects(client.call({ to: reship.to, data: reship.data, account: deployment.deployer }), (error) => {
    assert.equal(explainError(error).errorName, "NotMarketMaker"); return true;
  });
  const revoke = buildRevokePolicyCall(deployment, policies.act1);
  await assert.rejects(client.call({ to: revoke.to, data: revoke.data, account: deployment.deployer }), (error) => {
    assert.equal(explainError(error).errorName, "NotIssuer"); return true;
  });
  const claim = buildClaimFeesCall(deployment, strategies.act3);
  await assert.rejects(client.call({ to: claim.to, data: claim.data, account: deployment.mm }), (error) => {
    assert.equal(explainError(error).errorName, "NothingToClaim"); return true;
  });
  // These checks are eth_call simulations. Status and nonce stay unchanged.
  const after = await client.readContract({ address: deployment.module, abi: mandateModuleAbi,
    functionName: "getStrategy", args: [strategies.act3] });
  assert.equal(after.status, 3);
});

test("unknown ids do not produce fabricated snapshots", async () => {
  await assert.rejects(sdk.readPolicy(`0x${"ff".repeat(32)}` as Hash), /not found/);
  await assert.rejects(sdk.readStrategy(`0x${"ff".repeat(32)}` as Hash), /not found/);
});
