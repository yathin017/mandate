import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getAddress, type Hash } from "viem";
import { chains, getChainConfig, getDeployment, getLocalForkDeployment, getTransactionUrl,
  parseChainConfig, parseLocalForkDeployment } from "@mandate/chains";

const config = JSON.parse(await readFile(new URL("../../../config/chains/1.json", import.meta.url), "utf8"));
const baseConfig = JSON.parse(await readFile(new URL("../../../config/chains/8453.json", import.meta.url), "utf8"));
const manifest = JSON.parse(await readFile(new URL("../../../deployments/1.json", import.meta.url), "utf8"));

test("chain registry is sourced from the checked-in chain config", () => {
  assert.deepEqual(chains.map((c) => c.chainId), [1, 8453]);
  const base = getChainConfig(8453);
  assert.equal(base.uniswapV4.poolManager, getAddress(baseConfig.uniswapV4.poolManager));
  assert.equal(base.rpcEnv, "BASE_RPC_URL");
  const chain = getChainConfig(1);
  assert.equal(chain.chainId, config.chainId);
  assert.equal(chain.forkBlock, config.forkBlock);
  assert.equal(chain.aqua.aqua, getAddress(config.aqua.aqua));
  assert.equal(chain.aqua.swapVmRouter, getAddress(config.aqua.swapVmRouter));
  assert.equal(chain.safe.singletonL2, getAddress(config.safe.singletonL2));
  assert.ok(Object.isFrozen(chain) && Object.isFrozen(chain.aqua));
});

test("source-chain filename never registers a deployment on mainnet", () => {
  assert.throws(() => getDeployment(1), /No Mandate deployment/);
  assert.throws(() => getChainConfig(31337), /Unsupported source chain/);
  const fork = getDeployment(31337);
  assert.equal(fork.sourceChainId, 1);
  assert.equal(fork.environment, "local-mainnet-fork");
  assert.equal(fork.module, getAddress(manifest.module));
  assert.deepEqual(fork, getLocalForkDeployment(1));
  assert.throws(() => getLocalForkDeployment(8453), /No local fork/);
});

test("local transaction hashes never receive an Etherscan link", () => {
  const hash = `0x${"11".repeat(32)}` as Hash;
  assert.equal(getTransactionUrl(31337, hash), undefined);
  assert.equal(getTransactionUrl(999, hash), undefined);
  assert.equal(getTransactionUrl(1, hash), `https://etherscan.io/tx/${hash}`);
  assert.throws(() => getTransactionUrl(1, "0x1234" as Hash), /Invalid/);
});

test("invalid addresses, RPC secrets and unsafe explorer URLs are rejected", () => {
  const zero = structuredClone(config);
  zero.aqua.aqua = `0x${"0".repeat(40)}`;
  assert.throws(() => parseChainConfig(zero), /Zero address/);
  assert.throws(() => parseChainConfig({ ...config, rpcEnv: "https://secret.example/api-key" }), /environment variable/);
  assert.throws(() => parseChainConfig({ ...config, explorer: "javascript:alert(1)" }), /HTTPS/);
  assert.throws(() => parseChainConfig({ ...config, chainId: Number.MAX_SAFE_INTEGER + 1 }), /Invalid chainId/);
});

test("fork parser preserves runtime identity and synthetic-data disclosures", () => {
  assert.deepEqual(parseLocalForkDeployment(manifest), getLocalForkDeployment());
  assert.throws(() => parseLocalForkDeployment({ ...manifest, chainId: 1 }), /runtime chain/);
  assert.throws(() => parseLocalForkDeployment({ ...manifest, syntheticTokens: false }), /synthetic labels/);
  assert.throws(() => parseLocalForkDeployment({ ...manifest, forkBlockHash: "0xabc" }), /forkBlockHash/);
});
