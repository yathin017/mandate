import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Draft export contract for Segment 5. SDK types are defined at the next segment gate.
export function verifyReplay(replay: any) {
  assert.equal(replay.schemaVersion, 1);
  assert.equal(replay.environment, "local-mainnet-fork");
  assert.equal(replay.chainId, 31337);
  assert.equal(replay.sourceChainId, 1);
  assert.equal(replay.syntheticTokens, true);
  assert.equal(replay.syntheticOracleHistory, true);
  assert.equal(replay.acts.length, 3);
  const seen = new Set();
  for (const act of replay.acts) {
    assert.match(act.label, /SYNTHETIC/);
    assert.ok(act.disclosure.length > 0);
    assert.ok(act.initialState);
    assert.equal(act.initialSource.method, "DemoState.snapshot(bytes32)");
    assert.match(act.initialSource.blockHash, /^0x[0-9a-f]{64}$/i);
    let previous = act.initialState;
    for (const step of act.steps) {
      const key = `${act.act}/${step.step}`;
      assert.ok(!seen.has(key), `Duplicate step ${key}`);
      seen.add(key);
      assert.match(step.transactionHash, /^0x[0-9a-f]{64}$/i);
      assert.match(step.blockHash, /^0x[0-9a-f]{64}$/i);
      assert.equal(step.outerReceiptStatus, "success");
      assert.equal(step.source.blockNumber, step.blockNumber);
      assert.equal(step.source.blockHash, step.blockHash);
      assert.equal(step.source.method, "DemoState.snapshot(bytes32)");
      assert.ok(BigInt(step.state.totalNetSold) <= BigInt(step.state.released), `Release exceeded at ${key}`);
      assert.ok(BigInt(step.state.epochNetSold) <= BigInt(act.epochCap), `Epoch cap exceeded at ${key}`);
      assert.ok(BigInt(step.state.epochCap) <= BigInt(act.epochCap), `Live cap exceeds issuer bounds at ${key}`);
      assert.ok(BigInt(step.state.epochNetSold) <= BigInt(step.state.epochCap), `Live cap exceeded at ${key}`);
      if (step.outcome === "blocked") {
        assert.ok(step.error?.message && step.returnData.startsWith(step.error.selector));
        assert.equal(step.transfers.length, 0, `Blocked attempt moved tokens at ${key}`);
        assert.equal(step.state.totalNetSold, previous.totalNetSold);
        assert.equal(step.state.epochNetSold, previous.epochNetSold);
        assert.equal(step.state.safeBase, previous.safeBase);
        assert.equal(step.state.safeQuote, previous.safeQuote);
      } else {
        assert.equal(step.outcome, "executed");
        assert.equal(step.error, null);
        if (["treasury-sell", "treasury-buyback", "traditional-sell", "fee-claim"].includes(step.kind)) {
          assert.ok(step.transfers.length > 0, `Missing token-transfer evidence at ${key}`);
        }
      }
      for (const transfer of step.transfers) {
        assert.ok(BigInt(transfer.amount) > 0n);
        assert.match(transfer.token, /^0x[0-9a-f]{40}$/i);
        assert.match(transfer.from, /^0x[0-9a-f]{40}$/i);
        assert.match(transfer.to, /^0x[0-9a-f]{40}$/i);
      }
      previous = step.state;
    }
  }
  const [loan, burst, work] = replay.acts;
  assert.equal(loan.steps.length, 8);
  assert.equal(loan.steps.at(-1).error.name, "EpochCapReached");
  assert.equal(loan.steps.at(-1).state.safeBase, "9950000000000000000000000");
  assert.equal(loan.steps.find((s: any) => s.kind === "traditional-sell").state.traditionalBase, "0");
  const intents = burst.steps.filter((s: any) => s.step >= 1 && s.step <= 150);
  assert.equal(intents.length, 150);
  assert.equal(intents.reduce((sum: bigint, s: any) => sum + BigInt(s.requestedBase), 0n), 134_100_000n * 10n ** 18n);
  assert.equal(intents.filter((s: any) => s.outcome === "executed").length, 1);
  assert.equal(intents.filter((s: any) => s.error?.name === "EpochCapReached").length, 149);
  assert.equal(burst.steps.find((s: any) => s.step === 201).error.name, "SpotTwapDivergence");
  assert.equal(burst.steps.find((s: any) => s.step === 211).error.name, "AnchorDeviation");
  for (const step of [203, 213]) assert.equal(burst.steps.find((s: any) => s.step === step).outcome, "executed");
  assert.equal(work.steps.length, 12);
  assert.equal(work.initialState.spreadBps, "80");
  assert.equal(work.steps[0].state.spreadBps, "30");
  assert.equal(work.steps[0].state.strategyNonce, "2");
  assert.equal(work.steps.find((s: any) => s.step === 9).state.status, "3");
  assert.equal(work.steps.find((s: any) => s.step === 2).error.name, "ParamsOutOfBounds");
  assert.deepEqual(work.steps.find((s: any) => s.step === 3).error.args, ["GS104"]);
  assert.ok(BigInt(work.steps.find((s: any) => s.step === 10).state.claimedQuote) > BigInt(work.steps.find((s: any) => s.step === 4).state.claimedQuote));
  assert.equal(work.steps.at(-1).error.name, "MandateIsRevoked");
  return { steps: seen.size, blocked: replay.acts.flatMap((a: any) => a.steps).filter((s: any) => s.outcome === "blocked").length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2] ?? new URL("./data/acts.json", import.meta.url);
  console.log(verifyReplay(JSON.parse(await readFile(file, "utf8"))));
}
