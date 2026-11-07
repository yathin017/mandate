import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";

import { getChainConfig, getLocalForkDeployment } from "@mandate/chains";
import { anchorLauncherAbi, buildLaunchAnchorCall, mockTokenDeployment, parsePriceX36, readAnchorStatus } from "@mandate/sdk";
import { createPublicClient, createWalletClient, encodeDeployData, http, type Address, type Hex, type PublicClient } from "viem";

/**
 * The onboarding anchor step on the local fork: deploy an AnchorLauncher bound to the fork's oracle hook, then check
 * readAnchorStatus before and after launching a new pair and an existing (demo) pair. Snapshotted and restored.
 */
const RPC = process.env.VITE_RPC_URL ?? "http://127.0.0.1:8547";
const deployment = getLocalForkDeployment();
const DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;

const reachable = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
  body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).then((r) => r.ok).catch(() => false);

describe("onboarding: anchor launch and readiness", { skip: reachable ? false : "start the fork with `pnpm replay:serve`" }, () => {
  const publicClient = createPublicClient({ transport: http(RPC), cacheTime: 0 }) as PublicClient;
  const wallet = createWalletClient({ transport: http(RPC) });
  const rpc = (method: string, params: unknown[] = []) => publicClient.request({ method: method as never, params: params as never });
  const send = async (data: Hex, to?: Address) => publicClient.waitForTransactionReceipt({
    hash: await wallet.sendTransaction({ account: DEPLOYER, data, chain: null, ...(to ? { to } : {}) }) });
  let snapshot: string;
  let launcher: Address;
  const chainId = deployment.sourceChainId;

  before(async () => {
    snapshot = (await rpc("evm_snapshot")) as string;
    const artifact = JSON.parse(await readFile(new URL("../../../contracts/out/AnchorLauncher.sol/AnchorLauncher.json", import.meta.url), "utf8"));
    const poolManager = getChainConfig(chainId).uniswapV4.poolManager;
    launcher = (await send(encodeDeployData({ abi: anchorLauncherAbi, bytecode: artifact.bytecode.object, args: [poolManager, deployment.hook] }))).contractAddress!;
  });
  after(async () => {
    await rpc("evm_revert", [snapshot]);
  });

  test("new pair: no pool, then a priced empty pool that covers a policy's window once its history does", async () => {
    const token = mockTokenDeployment("Demo Launch", "dLAUNCH", 18);
    const base = (await send(encodeDeployData({ abi: token.abi, bytecode: token.bytecode, args: token.args }))).contractAddress!;
    const quote = getChainConfig(chainId).tokens.usdc;

    // The window is the issuer's (a test input here); without one readiness is not judged.
    const window = 1800;
    const before = await readAnchorStatus(publicClient, { chainId, launcher, base, quote, window });
    assert.equal(before.poolExists, false);
    assert.equal(before.anchor, null);
    assert.equal(before.ready, false);
    assert.equal((await readAnchorStatus(publicClient, { chainId, launcher, base, quote })).ready, null);

    const price = parsePriceX36("0.40", 18, 6);
    const call = buildLaunchAnchorCall(chainId, launcher, { base, quote, initialPriceX36: price });
    assert.equal((await send(call.data, call.to)).status, "success");

    const after = await readAnchorStatus(publicClient, { chainId, launcher, base, quote, window });
    assert.equal(after.anchor, before.predictedAnchor, "deployed where predicted");
    assert.ok(after.initializedAt !== null, "pool age starts at launch");
    assert.ok(after.poolExists);
    assert.equal(after.liquidity, 0n, "no liquidity until LPs add it");
    assert.ok(Math.abs(Number(after.spotPriceX36 - price)) / Number(price) < 1e-4, "starting price");
    assert.equal(after.cardinalityNext, 300);
    assert.equal(after.ready, false);
    assert.equal(after.readyAt, after.oldestObservation! + window);

    // Advance chain time past the window and mine.
    await rpc("evm_mine", [`0x${(after.readyAt! + 1).toString(16)}`]);
    const later = await readAnchorStatus(publicClient, { chainId, launcher, base, quote, window });
    assert.equal(later.ready, true);
    assert.ok(later.historySeconds >= window);
  });

  test("existing demo pair: the launch reuses the pool, keeps its price and is ready at once", async () => {
    const status = await readAnchorStatus(publicClient, { chainId, launcher, base: deployment.base, quote: deployment.quote, window: 1800 });
    assert.ok(status.poolExists);
    assert.equal(status.anchor, null);
    assert.ok(status.liquidity > 0n);
    assert.equal(status.trustedLiquidity, status.liquidity, "the demo seed has settled");

    const call = buildLaunchAnchorCall(chainId, launcher, { base: deployment.base, quote: deployment.quote, initialPriceX36: 1n });
    assert.equal((await send(call.data, call.to)).status, "success");
    const after = await readAnchorStatus(publicClient, { chainId, launcher, base: deployment.base, quote: deployment.quote, window: 1800 });
    assert.ok(after.anchor);
    assert.equal(after.sqrtPriceX96, status.sqrtPriceX96, "price untouched");
    assert.ok(after.ready);
  });
});
