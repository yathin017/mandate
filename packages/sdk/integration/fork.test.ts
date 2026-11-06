import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createPublicClient, http, type Hash } from "viem";
import { parseLocalForkDeployment } from "@mandate/chains";
import { createMandateClient, explainError, buildReshipCall, buildRevokeCall, buildClaimFeesCall,
  mandateModuleAbi, hashAquaOrder } from "@mandate/sdk";

if (!process.env.SDK_RPC_URL || !process.env.SDK_MANIFEST_PATH) throw new Error("Run through pnpm sdk:test:fork");
const deployment = parseLocalForkDeployment(JSON.parse(await readFile(process.env.SDK_MANIFEST_PATH, "utf8")));
const client = createPublicClient({ transport: http(process.env.SDK_RPC_URL) });
const sdk = await createMandateClient(client, deployment);

test("SDK reads canonical fork state with correct block provenance and active order identity", async () => {
  const snapshot = await sdk.readSnapshot(deployment.mandates.act1);
  assert.equal(snapshot.mandate.safe.toLowerCase(), deployment.safe1.toLowerCase());
  assert.equal(snapshot.mandate.status, 1);
  assert.equal(snapshot.epoch.netSold, 50_000n * 10n ** 18n);
  assert.equal(snapshot.remainingThisEpoch, 0n);
  assert.equal(snapshot.mandate.activeStrategyHash, hashAquaOrder(snapshot.activeOrder));
  assert.equal(snapshot.anchor.status, "within-spot-band");
  const block = await client.getBlock({ blockNumber: snapshot.source.blockNumber });
  assert.equal(block.hash, snapshot.source.blockHash);
  const again = await sdk.readSnapshot(deployment.mandates.act1, snapshot.source.blockNumber);
  assert.deepEqual(again, snapshot);
  const list = await sdk.mandatesOf(deployment.safe1);
  assert.deepEqual(list.ids, [deployment.mandates.act1]);
});

test("SDK quotes and decodes actual cap and docked-strategy errors from the deployed router", async () => {
  const input = { taker: deployment.deployer, tokenIn: deployment.quote, tokenOut: deployment.base,
    amount: 100n * 10n ** 6n, isExactIn: true };
  const blocked = await sdk.quote(deployment.mandates.act1, input);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.error.errorName, "EpochCapReached");
  const fill = await sdk.quote(deployment.mandates.act2, input);
  assert.equal(fill.ok, true);
  if (fill.ok) { assert.equal(fill.amountIn, input.amount); assert.ok(fill.amountOut > 0n); }
  const revoked = await sdk.quote(deployment.mandates.act3, input);
  assert.equal(revoked.ok, false);
  if (!revoked.ok) {
    assert.equal(revoked.error.errorName, "SafeBalancesForTokenNotInActiveStrategy");
    assert.match(revoked.error.message, /docked/);
  }
});

test("SDK prepares role-specific calldata accepted or rejected by the real module permissions", async () => {
  const snapshot = await sdk.readSnapshot(deployment.mandates.act3);
  assert.equal(snapshot.mandate.status, 3);
  assert.equal(snapshot.mandate.params.spreadBps, 30);
  assert.ok(snapshot.claimed[1] > 0n);
  const reship = buildReshipCall(deployment, deployment.mandates.act1, snapshot.mandate.params);
  await assert.rejects(client.call({ to: reship.to, data: reship.data, account: deployment.deployer }), (error) => {
    assert.equal(explainError(error).errorName, "NotMarketMaker"); return true;
  });
  const revoke = buildRevokeCall(deployment, deployment.mandates.act1);
  await assert.rejects(client.call({ to: revoke.to, data: revoke.data, account: deployment.deployer }), (error) => {
    assert.equal(explainError(error).errorName, "NotIssuer"); return true;
  });
  const claim = buildClaimFeesCall(deployment, deployment.mandates.act3);
  await assert.rejects(client.call({ to: claim.to, data: claim.data, account: deployment.mm }), (error) => {
    assert.equal(explainError(error).errorName, "NothingToClaim"); return true;
  });
  // These checks are eth_call simulations. Status and nonce stay unchanged.
  const after = await client.readContract({ address: deployment.module, abi: mandateModuleAbi,
    functionName: "getMandate", args: [deployment.mandates.act3] });
  assert.equal(after.status, 3);
});

test("unknown ids do not produce a fabricated mandate snapshot", async () => {
  await assert.rejects(sdk.readSnapshot(`0x${"ff".repeat(32)}` as Hash), /not found/);
});
