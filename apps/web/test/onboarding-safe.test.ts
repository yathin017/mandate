import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { getLocalForkDeployment } from "@mandate/chains";
import { buildCreateSafeCall, buildEnableModuleCall, safeAbi } from "@mandate/sdk";
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, type Address, type Hex } from "viem";

import { approvalSignatures, execTxArgs, safeTxArgs } from "../src/wallet/safeTx.ts";

/**
 * The onboarding wizard's Safe step against the canonical Safe 1.4.1 factory on the local fork: predict the address by
 * simulation (as the UI does), create the Safe, then enable the Mandate module with two owner approvals.
 * The fork is snapshotted and restored.
 */
const RPC = process.env.VITE_RPC_URL ?? "http://127.0.0.1:8547";
const deployment = getLocalForkDeployment();
const OWNER_1 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const OWNER_2 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;

const reachable = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
  body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).then((r) => r.ok).catch(() => false);

describe("onboarding: create a Safe and enable the module", { skip: reachable ? false : "start the fork with `pnpm replay:serve`" }, () => {
  const publicClient = createPublicClient({ transport: http(RPC), cacheTime: 0 });
  const wallet = createWalletClient({ transport: http(RPC) });
  const rpc = (method: string, params: unknown[] = []) => publicClient.request({ method: method as never, params: params as never });
  const send = async (from: Address, to: Address, data: Hex) =>
    publicClient.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ account: from, to, data, chain: null }) });
  let snapshot: string;
  let safe: Address;

  before(async () => {
    snapshot = (await rpc("evm_snapshot")) as string;
  });
  after(async () => {
    await rpc("evm_revert", [snapshot]);
  });

  test("predicted address from simulation is where the factory deploys the Safe", async () => {
    // The fork runs the source chain's (mainnet's) canonical factory, so its config applies.
    const call = buildCreateSafeCall(deployment.sourceChainId, { owners: [OWNER_1, OWNER_2], threshold: 2, saltNonce: 424242n });
    const simulated = await publicClient.call({ account: OWNER_1, to: call.to, data: call.data });
    safe = getAddress(`0x${simulated.data!.slice(-40)}`);

    const receipt = await send(OWNER_1, call.to, call.data);
    assert.equal(receipt.status, "success");
    assert.notEqual(await publicClient.getCode({ address: safe }), undefined);
    assert.deepEqual(await publicClient.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" }), [OWNER_1, OWNER_2]);
    assert.equal(await publicClient.readContract({ address: safe, abi: safeAbi, functionName: "getThreshold" }), 2n);
    assert.equal(await publicClient.readContract({ address: safe, abi: safeAbi, functionName: "VERSION" }), "1.4.1");

    // Same settings and salt again: the factory refuses (CREATE2 collision), so a double click cannot make two Safes.
    await assert.rejects(publicClient.call({ account: OWNER_1, to: call.to, data: call.data }));
  });

  test("owners enable the Mandate module with approveHash + execute", async () => {
    const call = buildEnableModuleCall(deployment.sourceChainId, safe, deployment.module);
    assert.equal(call.to, safe);
    const nonce = await publicClient.readContract({ address: safe, abi: safeAbi, functionName: "nonce" });
    const hash = await publicClient.readContract({ address: safe, abi: safeAbi, functionName: "getTransactionHash", args: safeTxArgs(call.to, call.data, nonce) });
    assert.equal((await send(OWNER_1, safe, encodeFunctionData({ abi: safeAbi, functionName: "approveHash", args: [hash] }))).status, "success");
    const exec = await send(OWNER_2, safe, encodeFunctionData({ abi: safeAbi, functionName: "execTransaction",
      args: execTxArgs(call.to, call.data, approvalSignatures([OWNER_1, OWNER_2])) }));
    assert.equal(exec.status, "success");
    assert.equal(await publicClient.readContract({ address: safe, abi: safeAbi, functionName: "isModuleEnabled", args: [deployment.module] }), true);
  });
});
