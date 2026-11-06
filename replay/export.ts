import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { assertLocalRpc, decodeAttempt, decodeFailure, decodeSnapshot, ERROR_SIGNATURES } from "./codec.ts";
import { SCENARIOS, stepDescription } from "./scenarios.ts";
import { verifyReplay } from "./verify.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cfg = JSON.parse(await readFile(join(root, "config/chains/1.json"), "utf8"));
const local = assertLocalRpc(process.env.LOCAL_RPC_URL ?? "http://127.0.0.1:8547");
const archive = process.env.MAINNET_RPC_URL ?? "https://eth.drpc.org";
const manifestPath = join(root, "deployments/1.json");
const localDir = join(root, ".local/replay");
let requestId = 0;

async function rpc(method: string, params: unknown[] = [], timeoutMs = 60_000) {
  const response = await fetch(local, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Local RPC HTTP ${response.status}`);
  const body = await response.json() as any;
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function command(program: string, args: string[], cwd = root, env: NodeJS.ProcessEnv = process.env) {
  const child = spawn(program, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const [code] = await once(child, "close");
  if (code !== 0) throw new Error(`${program} failed (${code}):\n${output.slice(-18_000)}`);
  if (args.includes("--test")) process.stdout.write(output);
  for (const line of output.split("\n")) if (/Act [123]:|Created 3 policies/.test(line)) console.log(line.trim());
  return output.trim();
}

async function script(file: string, phase?: number) {
  const args = ["script", `script/${file}.s.sol:${file}`, "--rpc-url", local.href,
    "--broadcast", "--unlocked", "--sender", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "--non-interactive", "--slow"];
  if (phase !== undefined) args.push("--sig", "run(uint256)", String(phase));
  console.log(`Running ${file}${phase === undefined ? "" : ` phase ${phase}`}…`);
  await command("forge", args, join(root, "contracts"));
}

async function advance(seconds: number) {
  const before = await rpc("eth_getBlockByNumber", ["latest", false]);
  // Anvil's fixed interval overrides evm_increaseTime; change the interval for this one mined block.
  await rpc("anvil_setBlockTimestampInterval", [seconds]);
  await rpc("evm_mine");
  await rpc("anvil_setBlockTimestampInterval", [1]);
  const after = await rpc("eth_getBlockByNumber", ["latest", false]);
  if (BigInt(after.timestamp) - BigInt(before.timestamp) < BigInt(seconds)) throw new Error("Synthetic time advance failed");
}

async function buildReplay(manifest: any, initial: any, initialBlock: any, setupReceipts: any[], snapshotSig: string) {
  const attemptTopic = await command("cast", ["keccak", "Attempted(uint256,uint256,address,bool,bytes)"]);
  const transferTopic = await command("cast", ["keccak", "Transfer(address,address,uint256)"]);
  const selectors: Record<string, string> = {};
  for (const [name, signature] of Object.entries(ERROR_SIGNATURES)) selectors[await command("cast", ["sig", signature])] = name;
  const logs = await rpc("eth_getLogs", [{ address: [manifest.mm, manifest.traditionalMm],
    fromBlock: `0x${(cfg.forkBlock + 1).toString(16)}`, toBlock: "latest", topics: [attemptTopic] }]);
  const acts = SCENARIOS.map((scenario) => ({ ...scenario, policyId: manifest.policies[`act${scenario.act}`],
    strategyId: manifest.strategies[`act${scenario.act}`],
    safe: manifest[`safe${scenario.act}`], initialState: initial[scenario.act],
    initialSource: { contract: manifest.stateReader, method: "DemoState.snapshot(bytes32)",
      blockNumber: Number(BigInt(initialBlock.number)), blockHash: initialBlock.hash }, steps: [] as any[] }));
  const receipts = [...setupReceipts];
  for (const log of logs) {
    const actNumber = Number(BigInt(log.topics[1]));
    if (actNumber === 0) continue; // Setup approvals are not replay actions.
    const step = Number(BigInt(log.topics[2]));
    const act = acts[actNumber - 1];
    if (!act) throw new Error(`Unknown act ${actNumber}`);
    const [receipt, block, rawState] = await Promise.all([
      rpc("eth_getTransactionReceipt", [log.transactionHash]),
      rpc("eth_getBlockByNumber", [log.blockNumber, false]),
      rpc("eth_call", [{ to: manifest.stateReader, data: snapshotSig + act.strategyId.slice(2) }, log.blockNumber]),
    ]);
    if (receipt.status !== "0x1" || receipt.blockHash !== log.blockHash || block.hash !== log.blockHash) {
      throw new Error(`Unconfirmed or inconsistent receipt ${log.transactionHash}`);
    }
    const attempt = decodeAttempt(log.data);
    const tokenAddresses = [manifest.base.toLowerCase(), manifest.quote.toLowerCase()];
    const transfers = receipt.logs.filter((event: any) => tokenAddresses.includes(event.address.toLowerCase()) && event.topics[0] === transferTopic)
      .map((event: any) => ({ token: event.address, from: `0x${event.topics[1].slice(-40)}`,
        to: `0x${event.topics[2].slice(-40)}`, amount: BigInt(event.data).toString(), logIndex: Number(BigInt(event.logIndex)) }));
    act.steps.push({ step, ...stepDescription(actNumber, step), ...attempt,
      outcome: attempt.success ? "executed" : "blocked", error: attempt.success ? null : decodeFailure(attempt.result, selectors),
      returnData: attempt.result, transactionHash: log.transactionHash, blockHash: log.blockHash,
      blockNumber: Number(BigInt(log.blockNumber)), timestamp: Number(BigInt(block.timestamp)),
      outerReceiptStatus: "success", state: decodeSnapshot(rawState), transfers,
      source: { contract: manifest.stateReader, method: "DemoState.snapshot(bytes32)",
        blockNumber: Number(BigInt(log.blockNumber)), blockHash: log.blockHash },
    });
    receipts.push(receipt);
  }
  const replay = { schemaVersion: 2, environment: "local-mainnet-fork", chainId: 31337, sourceChainId: 1,
    forkBlock: cfg.forkBlock, forkBlockHash: manifest.forkBlockHash, syntheticTokens: true, syntheticOracleHistory: true,
    transactionScope: "local-fork", blockedAttemptSemantics: "Successful outer ScenarioActor transaction containing a caught, reverted inner call.",
    setupTransactions: setupReceipts.map((receipt: any) => ({ transactionHash: receipt.transactionHash,
      blockHash: receipt.blockHash, blockNumber: Number(BigInt(receipt.blockNumber)) })),
    tokens: { base: { address: manifest.base, symbol: "LAUNCH", decimals: 18 }, quote: { address: manifest.quote, symbol: "sUSDC", decimals: 6 } }, acts };
  return { replay, receipts };
}

async function main() {
  await mkdir(localDir, { recursive: true });
  const lock = await open(join(localDir, "run.lock"), "wx");
  const previousManifest = await readFile(manifestPath).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  let node: ReturnType<typeof spawn> | undefined;
  let nodeClosed: Promise<void> | undefined;
  let startupError: Error | undefined;
  let committed = false;
  const logFile = createWriteStream(join(localDir, "anvil.log"));
  const stop = () => { node?.kill("SIGTERM"); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    let occupied = false;
    try { await rpc("eth_chainId", [], 1000); occupied = true; } catch { /* No existing JSON-RPC service. */ }
    if (occupied) throw new Error("Local RPC port is already in use; choose another LOCAL_RPC_URL. Existing nodes are never reset.");
    node = spawn("anvil", ["--fork-url", archive, "--fork-block-number", String(cfg.forkBlock), "--chain-id", "31337",
      "--host", local.hostname === "[::1]" ? "::1" : local.hostname, "--port", local.port, "--timestamp", "1800000000"],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    node.once("error", (error) => { startupError = error; });
    nodeClosed = new Promise((resolve) => { node!.once("close", () => resolve()); });
    node.stdout?.pipe(logFile, { end: false });
    node.stderr?.pipe(logFile, { end: false });
    let ready = false;
    const startupDeadline = Date.now() + 60_000;
    while (Date.now() < startupDeadline) {
      if (startupError) throw startupError;
      if (node.exitCode !== null || node.signalCode !== null) throw new Error("Anvil exited; inspect .local/replay/anvil.log");
      try { ready = await rpc("eth_chainId", [], 2000) === "0x7a69"; } catch { /* Startup can fetch archive state. */ }
      if (ready) break;
      await delay(500);
    }
    if (!ready) throw new Error("Anvil did not become ready within 60 seconds");
    if (Number(BigInt(await rpc("eth_blockNumber"))) !== cfg.forkBlock) throw new Error("Fork block mismatch");
    const forkBlock = await rpc("eth_getBlockByNumber", [`0x${cfg.forkBlock.toString(16)}`, false]);
    await rpc("anvil_setBlockTimestampInterval", [1]);
    await script("DeployFork");
    await script("SeedV4Pool");
    await advance(3600);
    await script("RunActs", 0);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.forkBlockHash = forkBlock.hash;
    manifest.syntheticTokens = true;
    manifest.syntheticOracleHistory = true;
    const snapshotSig = await command("cast", ["sig", "snapshot(bytes32)"]);
    const initialBlock = await rpc("eth_getBlockByNumber", ["latest", false]);
    const setupReceipts = [];
    for (let block = cfg.forkBlock + 1; block <= Number(BigInt(initialBlock.number)); ++block) {
      const info = await rpc("eth_getBlockByNumber", [`0x${block.toString(16)}`, false]);
      for (const hash of info.transactions) {
        const receipt = await rpc("eth_getTransactionReceipt", [hash]);
        if (receipt.status !== "0x1" || receipt.blockHash !== info.hash) throw new Error(`Failed setup transaction: ${hash}`);
        setupReceipts.push(receipt);
      }
    }
    const initial: Record<number, any> = {};
    for (const scenario of SCENARIOS) {
      const id = manifest.strategies[`act${scenario.act}`];
      initial[scenario.act] = decodeSnapshot(await rpc("eth_call", [{ to: manifest.stateReader, data: snapshotSig + id.slice(2) }, initialBlock.number]));
    }
    for (const field of ["module", "quoter", "hook", "anchor", "traditionalAnchor", "safe1", "safe2", "safe3", "traditionalSafe", "base", "quote", "stateReader"]) {
      if (await rpc("eth_getCode", [manifest[field], "latest"]) === "0x") throw new Error(`Missing deployment bytecode: ${field}`);
    }
    for (let phase = 1; phase <= 11; ++phase) {
      await script("RunActs", phase);
      if (phase === 7 || phase === 9) await advance(1801);
    }
    const { replay, receipts } = await buildReplay(manifest, initial, initialBlock, setupReceipts, snapshotSig);
    const summary = verifyReplay(replay);
    manifest.lastBlock = Number(BigInt(await rpc("eth_blockNumber")));
    manifest.replay = "replay/data/acts.json";
    if (process.argv.includes("--test-sdk")) {
      const sdkManifest = join(localDir, "sdk-manifest.json");
      await writeFile(sdkManifest, JSON.stringify(manifest));
      await command(process.execPath, ["--test", "packages/sdk/integration/fork.test.ts"], root,
        { ...process.env, SDK_RPC_URL: local.href, SDK_MANIFEST_PATH: sdkManifest });
    }
    await mkdir(join(root, "replay/data"), { recursive: true });
    // Publish only after receipt checks and scenario invariants succeed. Previous output survives a failed run.
    await writeFile(join(localDir, "acts.json"), JSON.stringify(replay, null, 2) + "\n");
    await writeFile(join(localDir, "receipts.json"), JSON.stringify(receipts, null, 2) + "\n");
    await rename(join(localDir, "acts.json"), join(root, "replay/data/acts.json"));
    await rename(join(localDir, "receipts.json"), join(root, "replay/data/receipts.json"));
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    committed = true;
    console.log(`Replay verified: ${summary.steps} steps, ${summary.blocked} blocked inner calls. Exported replay/data/acts.json.`);
    if (process.argv.includes("--keep-alive")) {
      // Serve the verified demo chain to the indexer and web app. The SIGINT/SIGTERM handler stops the node.
      console.log(`Keeping the fork alive at ${local.href} (chain 31337). Press Ctrl+C to stop.`);
      await nodeClosed;
    }
  } finally {
    stop();
    if (nodeClosed) await nodeClosed;
    logFile.end();
    if (!committed) {
      if (previousManifest) await writeFile(manifestPath, previousManifest);
      else await rm(manifestPath, { force: true });
    }
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await lock.close();
    await rm(join(localDir, "run.lock"), { force: true });
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
