import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";

import { buildLaunchTokenCall, tokenFactoryAbi } from "@mandate/sdk";
import { createPublicClient, createWalletClient, encodeDeployData, http, type Address, type Hex } from "viem";

import { createApp } from "../src/api/app.ts";
import { Cache } from "../src/cache/cache.ts";
import { keys } from "../src/cache/keys.ts";
import { indexDemoChain, rpc, skip, testConfig } from "./helpers.ts";

/**
 * TokenFactory launches on the local fork: a factory is deployed for the test (the recorded fork has none), two
 * tokens are launched, and the indexer, pointed at the factory, lists them. Snapshotted and restored.
 */
const CREATOR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address; // Anvil #0, public development key
const SAFE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;

describe("token launches", { skip }, () => {
  const rpcUrl = testConfig().INDEXER_RPC_URL;
  const publicClient = createPublicClient({ transport: http(rpcUrl), cacheTime: 0 });
  const wallet = createWalletClient({ transport: http(rpcUrl) });
  const send = async (data: Hex, to?: Address) =>
    publicClient.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ account: CREATOR, data, chain: null, ...(to ? { to } : {}) }) });
  let snapshot: string;
  let factory: Address;
  const tokens: Address[] = [];
  let indexed: Awaited<ReturnType<typeof indexDemoChain>>;
  let cache: Cache;
  let config: ReturnType<typeof testConfig>;

  before(async () => {
    snapshot = await rpc<string>(rpcUrl, "evm_snapshot");
    const artifact = JSON.parse(await readFile(new URL("../../../contracts/out/TokenFactory.sol/TokenFactory.json", import.meta.url), "utf8"));
    factory = (await send(encodeDeployData({ abi: tokenFactoryAbi, bytecode: artifact.bytecode.object }))).contractAddress!;
    for (const [name, symbol] of [["Nova", "NOVA"], ["Comet Coin", "COMET"]] as const) {
      const salt = `0x${"0".repeat(63)}${symbol.length}` as Hex;
      const input = { name, symbol, supply: 10n ** 27n, recipient: SAFE, salt };
      const predicted = await publicClient.readContract({ address: factory, abi: tokenFactoryAbi, functionName: "predict", args: [CREATOR, name, symbol, input.supply, SAFE, salt] });
      const call = buildLaunchTokenCall(31337, factory, input);
      assert.equal((await send(call.data, call.to)).status, "success");
      tokens.push(predicted);
    }
    config = testConfig({ INDEXER_TOKEN_FACTORY: factory });
    indexed = await indexDemoChain(config);
    cache = await Cache.connect(config.REDIS_URL);
  });
  after(async () => {
    await rpc(rpcUrl, "evm_revert", [snapshot]);
    await cache.delete(keys.head(config.INDEXER_CHAIN_ID));
    await cache.close();
    await indexed.close();
  });

  test("launches from the configured factory are indexed with token metadata", async () => {
    const app = createApp({ db: indexed.db, cache, config, log: () => {} });
    const head = await publicClient.getBlock();
    await cache.setHead(config.INDEXER_CHAIN_ID, { number: head.number.toString(), hash: head.hash });
    const response = await app.request(`/v1/chains/${config.INDEXER_CHAIN_ID}/tokens/launched?recipient=${SAFE}`);
    assert.equal(response.status, 200);
    const rows = ((await response.json()) as { data: any[] }).data;
    assert.deepEqual(rows.map((r) => r.symbol), ["COMET", "NOVA"], "newest first");
    for (const row of rows) {
      assert.ok(tokens.map((t) => t.toLowerCase()).includes(row.token));
      assert.equal(row.creator, CREATOR.toLowerCase());
      assert.equal(row.factory, factory.toLowerCase());
      assert.equal(row.supply, (10n ** 27n).toString());
    }
    const meta = await app.request(`/v1/chains/${config.INDEXER_CHAIN_ID}/tokens/launched?creator=0x000000000000000000000000000000000000beef`);
    assert.deepEqual(((await meta.json()) as { data: unknown[] }).data, []);
  });
});
