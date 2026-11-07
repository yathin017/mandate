import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { getChainConfig, getLocalForkDeployment } from "@mandate/chains";
import { buildMintCall, erc20Abi, labelToken, mockTokenDeployment, readTokenInfo } from "@mandate/sdk";
import { createPublicClient, createWalletClient, encodeDeployData, http, type Address, type PublicClient } from "viem";

/**
 * The token step's demo helper on the local fork: deploy a mock token from the connected wallet (which becomes its
 * owner), mint the supply into the Safe, and read it back as the UI does. The fork is snapshotted and restored.
 */
const RPC = process.env.VITE_RPC_URL ?? "http://127.0.0.1:8547";
const deployment = getLocalForkDeployment();
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const STRANGER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;

const reachable = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
  body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).then((r) => r.ok).catch(() => false);

describe("onboarding: demo token deploy and mint", { skip: reachable ? false : "start the fork with `pnpm replay:serve`" }, () => {
  const publicClient = createPublicClient({ transport: http(RPC), cacheTime: 0 }) as PublicClient;
  const wallet = createWalletClient({ transport: http(RPC) });
  const rpc = (method: string, params: unknown[] = []) => publicClient.request({ method: method as never, params: params as never });
  let snapshot: string;

  before(async () => {
    snapshot = (await rpc("evm_snapshot")) as string;
  });
  after(async () => {
    await rpc("evm_revert", [snapshot]);
  });

  test("deployed demo token is a labelled ERC20 owned by its deployer, minted into the Safe", async () => {
    const request = mockTokenDeployment("Demo Launch", "dLAUNCH", 18);
    const data = encodeDeployData({ abi: request.abi, bytecode: request.bytecode, args: request.args });
    const hash = await wallet.sendTransaction({ account: OWNER, data, chain: null });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const token = receipt.contractAddress!;
    assert.ok(token);

    const info = await readTokenInfo(publicClient, token);
    assert.ok(info.ok && info.name === "Demo Launch" && info.symbol === "dLAUNCH" && info.decimals === 18);
    assert.equal(labelToken(deployment.sourceChainId, token, info.symbol).warning, null);

    const supply = 1_000_000n * 10n ** 18n;
    const mint = buildMintCall(deployment.sourceChainId, token, deployment.safe1, supply);
    // Only the deployer may mint.
    await assert.rejects(publicClient.call({ account: STRANGER, to: mint.to, data: mint.data }));
    const minted = await publicClient.waitForTransactionReceipt({
      hash: await wallet.sendTransaction({ account: OWNER, to: mint.to, data: mint.data, chain: null }),
    });
    assert.equal(minted.status, "success");
    assert.equal(await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [deployment.safe1] }), supply);
  });

  test("the fork's canonical USDC is labelled and a look-alike is flagged", async () => {
    const usdc = getChainConfig(deployment.sourceChainId).tokens.usdc;
    const info = await readTokenInfo(publicClient, usdc);
    assert.ok(info.ok);
    assert.equal(labelToken(deployment.sourceChainId, usdc, info.symbol).canonical, "USDC");
    assert.match(labelToken(deployment.sourceChainId, deployment.base, "USDC").warning ?? "", /not the canonical/);
  });
});
