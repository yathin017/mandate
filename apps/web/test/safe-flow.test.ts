import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { getLocalForkDeployment } from "@mandate/chains";
import { buildAddStrategyCall, buildMintCall, buildReshipCall, explainError, mandateModuleAbi, safeAbi } from "@mandate/sdk";
import { createPublicClient, createWalletClient, encodeFunctionData, http, type Address, type Hash, type Hex } from "viem";

import { approvalSignatures, execTxArgs, safeTxArgs } from "../src/wallet/safeTx.ts";

/**
 * End-to-end check of the wallet flows the web app uses, against the live demo fork (`pnpm replay:serve`).
 * Uses Anvil's unlocked public dev accounts. The fork is snapshotted and restored, so the demo is unchanged.
 */
const RPC = process.env.VITE_RPC_URL ?? "http://127.0.0.1:8547";
const deployment = getLocalForkDeployment();
const OWNER_1 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const OWNER_2 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const MM = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;

const reachable = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' })
  .then((r) => r.ok)
  .catch(() => false);

describe("issuer and MM wallet flows on the demo fork", { skip: reachable ? false : "start the fork with `pnpm replay:serve`" }, () => {
  const publicClient = createPublicClient({ transport: http(RPC), cacheTime: 0 });
  const wallet = createWalletClient({ transport: http(RPC) });
  const rpc = (method: string, params: unknown[] = []) => publicClient.request({ method: method as never, params: params as never });
  let snapshot: string;
  const safe = deployment.safe1 as Address;

  const send = async (from: Address, to: Address, data: Hex) => {
    const hash = await wallet.sendTransaction({ account: from, to, data, chain: null });
    return publicClient.waitForTransactionReceipt({ hash });
  };

  before(async () => {
    snapshot = (await rpc("evm_snapshot")) as string;
    // The demo Safe's live strategy already uses all its tokens; owner 1 (the demo tokens' owner) mints more so a
    // second strategy is backed.
    for (const [token, amount] of [[deployment.base, 1_000_000n * 10n ** 18n], [deployment.quote, 400_000n * 10n ** 6n]] as const) {
      const mint = buildMintCall(31337, token, safe, amount);
      await send(OWNER_1, mint.to, mint.data);
    }
  });
  after(async () => {
    await rpc("evm_revert", [snapshot]);
  });

  let strategyId: Hash;
  const policyId = deployment.policies.act1;

  test("two owners approve and execute addStrategy through the Safe", async () => {
    // Test inputs: a second market maker under the demo Safe's existing policy.
    const call = buildAddStrategyCall(deployment, {
      policyId,
      marketMaker: MM,
      kind: 0,
      bounds: { spreadBpsMin: 10, spreadBpsMax: 200, maxShippedBase: 1_000_000n * 10n ** 18n, maxShippedQuote: 400_000n * 10n ** 6n, mmFeeShareBps: 5000, maxBuyPriceX36: 0n },
      params: { spreadBps: 80, shippedBase: 1_000_000n * 10n ** 18n, shippedQuote: 400_000n * 10n ** 6n },
    });

    // Pre-check exactly as the app does: the module call from the Safe must succeed.
    await publicClient.call({ account: safe, to: call.to, data: call.data });

    const before = await publicClient.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "strategiesOf", args: [policyId] });
    const nonce = await publicClient.readContract({ address: safe, abi: safeAbi, functionName: "nonce" });
    const safeTxHash = await publicClient.readContract({ address: safe, abi: safeAbi, functionName: "getTransactionHash", args: safeTxArgs(call.to, call.data, nonce) });

    // Owner 2 alone cannot execute: one signature is below the 2-of-2 threshold.
    await assert.rejects(
      publicClient.call({ account: OWNER_2, to: safe, data: encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args: execTxArgs(call.to, call.data, approvalSignatures([OWNER_2])) }) }),
    );

    const approval = await send(OWNER_1, safe, encodeFunctionData({ abi: safeAbi, functionName: "approveHash", args: [safeTxHash] }));
    assert.equal(approval.status, "success");
    assert.equal(await publicClient.readContract({ address: safe, abi: safeAbi, functionName: "approvedHashes", args: [OWNER_1, safeTxHash] }), 1n);

    const exec = await send(OWNER_2, safe, encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args: execTxArgs(call.to, call.data, approvalSignatures([OWNER_1, OWNER_2])) }));
    assert.equal(exec.status, "success");

    const afterIds = await publicClient.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "strategiesOf", args: [policyId] });
    assert.equal(afterIds.length, before.length + 1);
    strategyId = afterIds.at(-1)!;
    const strategy = await publicClient.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "getStrategy", args: [strategyId] });
    assert.equal(strategy.mm.toLowerCase(), MM.toLowerCase());
    assert.equal(strategy.status, 1);
    assert.equal(strategy.policyId, policyId);
  });

  test("a strategy the Safe cannot back is refused before anyone signs", async () => {
    const call = buildAddStrategyCall(deployment, {
      policyId,
      marketMaker: MM,
      kind: 0,
      bounds: { spreadBpsMin: 10, spreadBpsMax: 200, maxShippedBase: 10n ** 30n, maxShippedQuote: 10n ** 12n, mmFeeShareBps: 5000, maxBuyPriceX36: 0n },
      params: { spreadBps: 80, shippedBase: 10n ** 24n, shippedQuote: 4n * 10n ** 11n },
    });
    const refused = await publicClient.call({ account: safe, to: call.to, data: call.data }).then(() => null, (e: unknown) => e);
    assert.equal(explainError(refused).errorName, "InsufficientBacking");
  });

  test("the new MM reships inside bounds; outside bounds is refused in simulation", async () => {
    const strategy = await publicClient.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "getStrategy", args: [strategyId] });
    const inside = buildReshipCall(deployment, strategyId, { ...strategy.params, spreadBps: 30 });
    const ok = await send(MM, inside.to, inside.data);
    assert.equal(ok.status, "success");

    const outside = buildReshipCall(deployment, strategyId, { ...strategy.params, spreadBps: 500 });
    const refused = await publicClient.call({ account: MM, to: outside.to, data: outside.data }).then(() => null, (e: unknown) => e);
    assert.ok(refused, "out-of-bounds reship must revert");
    const explained = explainError(refused);
    assert.equal(explained.errorName, "ParamsOutOfBounds");
    assert.match(explained.message, /spread/i);
  });

  test("an owner cannot reship: only the MM can", async () => {
    const strategy = await publicClient.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "getStrategy", args: [strategyId] });
    const reship = buildReshipCall(deployment, strategyId, strategy.params);
    const refused = await publicClient.call({ account: OWNER_1, to: reship.to, data: reship.data }).then(() => null, (e: unknown) => e);
    assert.equal(explainError(refused).errorName, "NotMarketMaker");
  });
});
