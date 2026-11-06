import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";

import { getChainConfig, getLocalForkDeployment } from "@mandate/chains";
import {
  anchorLauncherAbi, buildApproveRouterCall, buildCreateMandateCall, buildCreateSafeCall, buildEnableModuleCall, buildLaunchAnchorCall, buildMintCall,
  buildSwapCall, createMandateClient, erc20Abi, mandateModuleAbi, mockTokenDeployment, parsePriceX36, readAnchorStatus, safeAbi, type PreparedCall,
} from "@mandate/sdk";
import { createPublicClient, createWalletClient, encodeDeployData, encodeFunctionData, getAddress, http, type Address, type Hex, type PublicClient } from "viem";

import { buildTerms, decodeTerms, encodeTerms, STANDARD_RAILS, utcDate, type Terms, type TokenRef } from "../src/issuer/terms.ts";
import { approvalSignatures, execTxArgs, safeTxArgs } from "../src/wallet/safeTx.ts";

/**
 * The onboarding wizard end to end on the local fork, for a brand-new pair: a 2-of-2 Safe enables the module, two demo
 * tokens are minted into it, the launcher creates the pool and anchor, and the owners create the mandate from typed
 * terms. The second owner rebuilds the call from the shared link and must get the same calldata. Once the anchor has
 * its 30-minute history, a taker buys from the new mandate through the SwapVM router. Snapshotted and restored.
 */
const RPC = process.env.VITE_RPC_URL ?? "http://127.0.0.1:8547";
const deployment = getLocalForkDeployment();
const OWNER_1 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const OWNER_2 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const MM = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;
const TAKER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as Address;

const reachable = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
  body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).then((r) => r.ok).catch(() => false);

describe("onboarding: create a mandate for a new pair", { skip: reachable ? false : "start the fork with `pnpm replay:serve`" }, () => {
  const publicClient = createPublicClient({ transport: http(RPC), cacheTime: 0 }) as PublicClient;
  const wallet = createWalletClient({ transport: http(RPC) });
  const rpc = (method: string, params: unknown[] = []) => publicClient.request({ method: method as never, params: params as never });
  const send = async (from: Address, data: Hex, to?: Address) => publicClient.waitForTransactionReceipt({
    hash: await wallet.sendTransaction({ account: from, data, chain: null, ...(to ? { to } : {}) }) });
  /** Both owners approve onchain, then owner 2 executes, as the Safe action panel does. */
  const execBySafe = async (safe: Address, call: PreparedCall) => {
    const nonce = await publicClient.readContract({ address: safe, abi: safeAbi, functionName: "nonce" });
    const hash = await publicClient.readContract({ address: safe, abi: safeAbi, functionName: "getTransactionHash", args: safeTxArgs(call.to, call.data, nonce) });
    await send(OWNER_1, encodeFunctionData({ abi: safeAbi, functionName: "approveHash", args: [hash] }), safe);
    return send(OWNER_2, encodeFunctionData({ abi: safeAbi, functionName: "execTransaction",
      args: execTxArgs(call.to, call.data, approvalSignatures([OWNER_1, OWNER_2])) }), safe);
  };
  const chainId = deployment.sourceChainId;
  let snapshot: string;
  let launcher: Address;

  before(async () => {
    snapshot = (await rpc("evm_snapshot")) as string;
    const artifact = JSON.parse(await readFile(new URL("../../../contracts/out/AnchorLauncher.sol/AnchorLauncher.json", import.meta.url), "utf8"));
    launcher = (await send(OWNER_1, encodeDeployData({ abi: anchorLauncherAbi, bytecode: artifact.bytecode.object,
      args: [getChainConfig(chainId).uniswapV4.poolManager, deployment.hook] }))).contractAddress!;
  });
  after(async () => {
    await rpc("evm_revert", [snapshot]);
  });

  test("owners create the mandate before the anchor is ready; a taker fills once it is", async () => {
    // Safe + module.
    const create = buildCreateSafeCall(chainId, { owners: [OWNER_1, OWNER_2], threshold: 2, saltNonce: 909090n });
    const safe = getAddress(`0x${(await publicClient.call({ account: OWNER_1, to: create.to, data: create.data })).data!.slice(-40)}`);
    assert.equal((await send(OWNER_1, create.data, create.to)).status, "success");
    assert.equal((await execBySafe(safe, buildEnableModuleCall(chainId, safe, deployment.module))).status, "success");

    // Demo pair minted into the Safe.
    const deploy = async (name: string, symbol: string, decimals: number, supply: bigint): Promise<TokenRef> => {
      const t = mockTokenDeployment(`Demo ${name}`, symbol, decimals);
      const address = (await send(OWNER_1, encodeDeployData({ abi: t.abi, bytecode: t.bytecode, args: t.args }))).contractAddress!;
      const mint = buildMintCall(chainId, address, safe, supply * 10n ** BigInt(decimals));
      assert.equal((await send(OWNER_1, mint.data, mint.to)).status, "success");
      return { address: getAddress(address), symbol, decimals };
    };
    const base = await deploy("Launch", "dLAUNCH", 18, 1_000_000n);
    const quote = await deploy("Dollar", "dUSD", 6, 10_000n);

    // Anchor launched; its 30-minute history has not built up yet.
    const launch = buildLaunchAnchorCall(chainId, launcher, { base: base.address, quote: quote.address, initialPriceX36: parsePriceX36("0.40", 18, 6) });
    assert.equal((await send(OWNER_1, launch.data, launch.to)).status, "success");
    const status = await readAnchorStatus(publicClient, { chainId, launcher, base: base.address, quote: quote.address });
    assert.ok(status.anchor);
    assert.equal(status.ready, false);

    // Owner 1 types the terms; owner 2 opens the shared link and rebuilds them.
    const now = (await publicClient.getBlock()).timestamp;
    const holdings = {
      base: await publicClient.readContract({ address: base.address, abi: erc20Abi, functionName: "balanceOf", args: [safe] }),
      quote: await publicClient.readContract({ address: quote.address, abi: erc20Abi, functionName: "balanceOf", args: [safe] }),
    };
    // 25,000 base against 10,000 quote starts trading at the pool's 0.40; release began 10 days ago.
    const terms: Terms = { ...STANDARD_RAILS, mm: MM, allotment: "1000000", releaseStart: utcDate(now - 10n * 86_400n),
      dailyCap: "50000", floor: "0.30", shippedBase: "25000", shippedQuote: "10000" };
    const ctx = { safe, owners: [OWNER_1, OWNER_2], base, quote, anchor: status.anchor, holdings, anchorPriceX36: status.spotPriceX36 };
    const toCall = (t: Terms) => {
      const built = buildTerms(t, ctx);
      assert.ok(!("error" in built), "error" in built ? built.error : "");
      return buildCreateMandateCall(deployment, { marketMaker: built.marketMaker, base: base.address, quote: quote.address,
        bounds: built.bounds, params: built.params });
    };
    const call = toCall(terms);
    const shared = decodeTerms(encodeTerms(terms));
    assert.equal(toCall({ ...STANDARD_RAILS, ...shared } as Terms).data, call.data, "co-owner builds identical calldata");

    // Refused before anyone approves: one unit more than the Safe holds, or a ratio that would start at 0.01.
    assert.ok("error" in buildTerms({ ...terms, shippedQuote: "10000.000001" }, ctx));
    assert.ok("error" in buildTerms({ ...terms, shippedBase: "1000000" }, ctx));

    assert.equal((await execBySafe(safe, call)).status, "success");
    const ids = await publicClient.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "mandatesOf", args: [safe] });
    assert.equal(ids.length, 1);
    const mandate = await publicClient.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "getMandate", args: [ids[0]!] });
    assert.equal(mandate.mm, MM);
    assert.equal(mandate.base, base.address);
    assert.equal(mandate.quote, quote.address);
    assert.equal(mandate.bounds.anchor, status.anchor);
    assert.equal(mandate.status, 1);
    assert.notEqual(mandate.activeStrategyHash, `0x${"0".repeat(64)}`, "first strategy shipped");

    // A taker buys 100 base (the Safe sells), paying quote. Refused until the anchor has its history. (1,000 would move
    // the 25,000-token curve ~4% and, with the spread, leave the 3% anchor band.)
    const id = ids[0]!;
    const sdk = await createMandateClient(publicClient, deployment);
    const buy = { taker: TAKER, tokenIn: quote.address, tokenOut: base.address, amount: 100n * 10n ** 18n, isExactIn: false };
    assert.equal((await sdk.quote(id, buy)).ok, false, "no fills before the TWAP window has passed");
    await rpc("evm_mine", [`0x${(status.readyAt! + 1).toString(16)}`]);
    const quoted = await sdk.quote(id, buy);
    assert.ok(quoted.ok, quoted.ok ? "" : quoted.error.message);
    // Exact-out at ~0.40 plus the 0.8% spread and 0.4% price impact: about 40.5 quote.
    assert.ok(quoted.amountIn > 40n * 10n ** 6n && quoted.amountIn < 41n * 10n ** 6n, `paid ${quoted.amountIn}`);

    const mint = buildMintCall(chainId, quote.address, TAKER, 1_000n * 10n ** 6n);
    await send(OWNER_1, mint.data, mint.to);
    const approve = buildApproveRouterCall(deployment, quote.address, quoted.amountIn);
    await send(TAKER, approve.data, approve.to);
    const order = await publicClient.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "activeOrder", args: [id] });
    const block = await publicClient.getBlock();
    const swap = buildSwapCall(deployment, { order, tokenIn: quote.address, tokenOut: base.address, amount: buy.amount,
      isExactIn: false, threshold: quoted.amountIn, deadline: block.timestamp + 600n });
    assert.equal((await send(TAKER, swap.data, swap.to)).status, "success");
    assert.equal(await publicClient.readContract({ address: base.address, abi: erc20Abi, functionName: "balanceOf", args: [TAKER] }), buy.amount);
    assert.equal(await publicClient.readContract({ address: base.address, abi: erc20Abi, functionName: "balanceOf", args: [safe] }),
      holdings.base - buy.amount, "tokens left the Safe only through the fill");
  });
});
