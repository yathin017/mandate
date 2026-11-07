import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";

import { getChainConfig, getLocalForkDeployment } from "@mandate/chains";
import {
  anchorLauncherAbi, buildAddLiquidityCall, buildCreateSafeCall, buildLaunchAnchorCall, buildMintCall, erc20Abi,
  mockTokenDeployment, parsePriceX36, planFullRangeLiquidity, readAnchorStatus, safeAbi,
} from "@mandate/sdk";
import { createPublicClient, createWalletClient, encodeDeployData, encodeFunctionData, getAddress, http, parseAbi, type Address, type Hex, type PublicClient } from "viem";

import { approvalSignatures, execTxArgs, safeOperation, safeTxArgs } from "../src/wallet/safeTx.ts";

/**
 * The launch wizard's liquidity step on the local fork, against the canonical Uniswap v4 PositionManager: a 2-of-2
 * Safe holding a new pair adds full-range liquidity to the pair's anchor pool in one batched Safe transaction
 * (delegatecall to MultiSendCallOnly). Snapshotted and restored.
 */
const RPC = process.env.VITE_RPC_URL ?? "http://127.0.0.1:8547";
const deployment = getLocalForkDeployment();
const chainId = deployment.sourceChainId;
const config = getChainConfig(chainId);
const OWNER_1 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const OWNER_2 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const positionsAbi = parseAbi(["function balanceOf(address owner) view returns (uint256)", "function nextTokenId() view returns (uint256)", "function ownerOf(uint256 id) view returns (address)"]);
const permit2Abi = parseAbi(["function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)"]);

const reachable = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
  body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).then((r) => r.ok).catch(() => false);

describe("onboarding: the Safe adds anchor-pool liquidity", { skip: reachable ? false : "start the fork with `pnpm replay:serve`" }, () => {
  const client = createPublicClient({ transport: http(RPC), cacheTime: 0 }) as PublicClient;
  const wallet = createWalletClient({ transport: http(RPC) });
  const rpc = (method: string, params: unknown[] = []) => client.request({ method: method as never, params: params as never });
  const send = async (from: Address, data: Hex, to?: Address) =>
    client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ account: from, data, chain: null, ...(to ? { to } : {}) }) });
  let snapshot: string;
  let launcher: Address;

  before(async () => {
    snapshot = (await rpc("evm_snapshot")) as string;
    const artifact = JSON.parse(await readFile(new URL("../../../contracts/out/AnchorLauncher.sol/AnchorLauncher.json", import.meta.url), "utf8"));
    launcher = (await send(OWNER_1, encodeDeployData({ abi: anchorLauncherAbi, bytecode: artifact.bytecode.object, args: [config.uniswapV4.poolManager, deployment.hook] }))).contractAddress!;
  });
  after(async () => {
    await rpc("evm_revert", [snapshot]);
  });

  test("only CALLs and MultiSendCallOnly batches pass the operation guard", () => {
    const ms = config.safe.multiSendCallOnly;
    assert.equal(safeOperation(OWNER_1, 0, ms), 0);
    assert.equal(safeOperation(ms, 1, ms), 1);
    assert.throws(() => safeOperation(OWNER_1, 1, ms), /Refusing Safe operation 1/);
    assert.throws(() => safeOperation(ms, 2, ms), /Refusing Safe operation 2/);
  });

  test("one batched Safe transaction mints a full-range position owned by the Safe and leaves no approvals", async () => {
    const create = buildCreateSafeCall(chainId, { owners: [OWNER_1, OWNER_2], threshold: 2, saltNonce: 515_151n });
    const safe = getAddress(`0x${(await client.call({ account: OWNER_1, to: create.to, data: create.data })).data!.slice(-40)}`);
    await send(OWNER_1, create.data, create.to);
    const token = async (name: string, symbol: string, decimals: number, supply: bigint) => {
      const t = mockTokenDeployment(name, symbol, decimals);
      const address = getAddress((await send(OWNER_1, encodeDeployData({ abi: t.abi, bytecode: t.bytecode, args: t.args }))).contractAddress!);
      const mint = buildMintCall(chainId, address, safe, supply * 10n ** BigInt(decimals));
      await send(OWNER_1, mint.data, mint.to);
      return address;
    };
    const base = await token("Demo Comet", "dCOMET", 18, 1_000_000n);
    const quote = await token("Demo Dollar", "dUSD", 6, 400_000n);
    const launch = buildLaunchAnchorCall(chainId, launcher, { base, quote, initialPriceX36: parsePriceX36("0.40", 18, 6) });
    await send(OWNER_1, launch.data, launch.to);
    const before = await readAnchorStatus(client, { chainId, launcher, base, quote });
    assert.equal(before.liquidity, 0n);

    const plan = planFullRangeLiquidity({ poolKey: before.poolKey, sqrtPriceX96: before.sqrtPriceX96, base, baseAmount: 100_000n * 10n ** 18n });
    const call = buildAddLiquidityCall(chainId, safe, plan);
    const operation = safeOperation(call.to, call.operation, config.safe.multiSendCallOnly);
    const balance = (t: Address, who: Address) => client.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [who] });
    const [baseBefore, quoteBefore] = await Promise.all([balance(base, safe), balance(quote, safe)]);
    const tokenId = await client.readContract({ address: config.uniswapV4.positionManager, abi: positionsAbi, functionName: "nextTokenId" });

    // Owner 1 approves the batch onchain; owner 2 executes it as the Safe's delegatecall.
    const nonce = await client.readContract({ address: safe, abi: safeAbi, functionName: "nonce" });
    const hash = await client.readContract({ address: safe, abi: safeAbi, functionName: "getTransactionHash", args: safeTxArgs(call.to, call.data, nonce, operation) });
    await send(OWNER_1, encodeFunctionData({ abi: safeAbi, functionName: "approveHash", args: [hash] }), safe);
    const exec = await send(OWNER_2, encodeFunctionData({ abi: safeAbi, functionName: "execTransaction",
      args: execTxArgs(call.to, call.data, approvalSignatures([OWNER_1, OWNER_2]), operation) }), safe);
    assert.equal(exec.status, "success");

    const after = await readAnchorStatus(client, { chainId, launcher, base, quote });
    assert.equal(after.liquidity, plan.liquidity, "the pool's in-range liquidity is the planned position");
    assert.equal(after.sqrtPriceX96, before.sqrtPriceX96, "adding liquidity does not move the price");
    assert.equal(await client.readContract({ address: config.uniswapV4.positionManager, abi: positionsAbi, functionName: "ownerOf", args: [tokenId] }), safe);

    // The Safe paid at most the caps, about 100,000 base and 40,000 quote.
    const [baseAfter, quoteAfter] = await Promise.all([balance(base, safe), balance(quote, safe)]);
    const baseIs0 = getAddress(before.poolKey.currency0) === base;
    const [baseCap, quoteCap] = baseIs0 ? [plan.amount0Max, plan.amount1Max] : [plan.amount1Max, plan.amount0Max];
    assert.ok(baseBefore - baseAfter <= baseCap && baseBefore - baseAfter >= 99_999n * 10n ** 18n);
    assert.ok(quoteBefore - quoteAfter <= quoteCap && Math.abs(Number(quoteBefore - quoteAfter) / 1e6 - 40_000) < 40);

    // Nothing stays approved: token allowances to Permit2 were reset in the same batch.
    for (const t of [base, quote]) {
      assert.equal(await client.readContract({ address: t, abi: erc20Abi, functionName: "allowance", args: [safe, config.uniswapV4.permit2] }), 0n);
    }
    const [pmAllowance] = await client.readContract({ address: config.uniswapV4.permit2, abi: permit2Abi, functionName: "allowance", args: [safe, base, config.uniswapV4.positionManager] });
    assert.ok(pmAllowance < plan.amount0Max + plan.amount1Max, "only the unused slippage margin remains in Permit2, unusable without a token approval");
  });
});
