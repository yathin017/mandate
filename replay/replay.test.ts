import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertLocalRpc, decodeAttempt, decodeFailure, decodeSnapshot, ERROR_SIGNATURES, words } from "./codec.ts";
import { stepDescription } from "./scenarios.ts";
import { verifyReplay } from "./verify.ts";

test("mutating replay RPCs accept only explicit loopback ports", () => {
  for (const value of ["http://127.0.0.1:8547", "http://localhost:8547", "http://[::1]:8547"]) assertLocalRpc(value);
  for (const value of ["https://eth.drpc.org", "http://example.org:8547", "http://127.0.0.1", "http://127.0.0.1:80", "http://user:secret@localhost:8547", "http://localhost:8547/path"]) {
    assert.throws(() => assertLocalRpc(value));
  }
});

test("snapshot decoding rejects truncated or malformed evidence", () => {
  assert.throws(() => decodeSnapshot("0x01"));
  assert.throws(() => decodeSnapshot(`0x${"00".repeat(32 * 21)}`));
  assert.throws(() => decodeSnapshot(`0x${"gg".repeat(32 * 22)}`));
  assert.equal(decodeSnapshot(`0x${"00".repeat(32 * 22)}`).safeBase, "0");
});

test("attempt decoder rejects invalid flags and unsafe offsets", () => {
  const word = (n: bigint) => n.toString(16).padStart(64, "0");
  assert.throws(() => decodeAttempt(`0x${word(1n)}${word(2n)}${word(96n)}${word(0n)}`));
  assert.throws(() => decodeAttempt(`0x${word(1n)}${word(0n)}${word(2n ** 255n)}${word(0n)}`));
  assert.throws(() => decodeAttempt(`0x${word(1n)}${word(0n)}${word(96n)}${word(1n)}`));
});

test("scenario descriptions reject unmapped acts and steps", () => {
  assert.throws(() => stepDescription(4, 0));
  assert.throws(() => stepDescription(2, 151));
  assert.match(stepDescription(2, 211).label, /stale-price/);
  assert.match(stepDescription(3, 2).label, /no longer holds/);
  assert.throws(() => stepDescription(3, 13));
});

test("every expected scenario revert signature exists in compiled contract ABIs", async () => {
  const names = ["MandateModule.sol/MandateModule", "MandateQuoter.sol/MandateQuoter"];
  const signatures = new Set<string>();
  for (const name of names) {
    const artifact = JSON.parse(await readFile(new URL(`../contracts/out/${name}.json`, import.meta.url), "utf8"));
    for (const item of artifact.abi.filter((entry: any) => entry.type === "error")) {
      signatures.add(`${item.name}(${item.inputs.map((input: any) => input.type).join(",")})`);
    }
  }
  for (const [name, signature] of Object.entries(ERROR_SIGNATURES)) {
    if (name !== "SafeError") assert.ok(signatures.has(signature), `Contract ABI drifted: ${signature}`);
  }
  assert.throws(() => decodeFailure("0xdeadbeef", {}));
});

test("exported replay is complete and verified, with actual token-transfer receipts", async () => {
  const replay = JSON.parse(await readFile(new URL("./data/acts.json", import.meta.url), "utf8"));
  const receipts = JSON.parse(await readFile(new URL("./data/receipts.json", import.meta.url), "utf8"));
  const summary = verifyReplay(replay);
  assert.deepEqual(summary, { steps: 179, blocked: 157 });
  const transferTopic = execFileSync("cast", ["keccak", "Transfer(address,address,uint256)"], { encoding: "utf8" }).trim();
  const attemptTopic = execFileSync("cast", ["keccak", "Attempted(uint256,uint256,address,bool,bytes)"], { encoding: "utf8" }).trim();
  const filledTopic = execFileSync("cast", ["keccak", "Filled(bytes32,bytes32,address,bytes32,bool,uint256,uint256,uint256,uint8)"], { encoding: "utf8" }).trim();
  const byHash = new Map(receipts.map((receipt: any) => [receipt.transactionHash, receipt]));
  for (const act of replay.acts) {
    let previous = act.initialState;
    for (const step of act.steps) {
      const receipt: any = byHash.get(step.transactionHash);
      assert.ok(receipt);
      assert.equal(receipt.status, "0x1");
      assert.equal(receipt.blockHash, step.blockHash);
      const attempted = receipt.logs.find((log: any) => log.topics[0] === attemptTopic);
      assert.equal(Number(BigInt(attempted.topics[1])), act.act);
      assert.equal(Number(BigInt(attempted.topics[2])), step.step);
      const decoded = decodeAttempt(attempted.data);
      assert.equal(decoded.success, step.outcome === "executed");
      assert.equal(decoded.result, step.returnData);
      assert.equal(decoded.target.toLowerCase(), step.target.toLowerCase());
      for (const transfer of step.transfers) {
        const log = receipt.logs.find((log: any) => Number(BigInt(log.logIndex)) === transfer.logIndex);
        assert.equal(log.address.toLowerCase(), transfer.token.toLowerCase());
        assert.equal(log.topics[0], transferTopic);
        assert.equal(BigInt(log.data).toString(), transfer.amount);
        assert.equal(`0x${log.topics[1].slice(-40)}`.toLowerCase(), transfer.from.toLowerCase());
        assert.equal(`0x${log.topics[2].slice(-40)}`.toLowerCase(), transfer.to.toLowerCase());
      }
      for (const [field, token] of [["safeBase", replay.tokens.base.address], ["safeQuote", replay.tokens.quote.address]]) {
        let expected = BigInt(previous[field]);
        for (const transfer of step.transfers.filter((transfer: any) => transfer.token.toLowerCase() === token.toLowerCase())) {
          if (transfer.from.toLowerCase() === act.safe.toLowerCase()) expected -= BigInt(transfer.amount);
          if (transfer.to.toLowerCase() === act.safe.toLowerCase()) expected += BigInt(transfer.amount);
        }
        assert.equal(BigInt(step.state[field]), expected, `Safe balance disagrees with transfers at ${act.act}/${step.step}`);
      }
      if (step.outcome === "executed" && ["treasury-sell", "treasury-buyback"].includes(step.kind)) {
        const filled = receipt.logs.find((log: any) => log.topics[0] === filledTopic);
        assert.equal(filled.topics[1], act.policyId);
        assert.equal(filled.topics[2], act.strategyId);
        const values = words(filled.data);
        assert.equal(values[1], step.kind === "treasury-sell" ? 1n : 0n, "isSell matches the step");
        assert.equal(values[5].toString(), step.state.riskMode, "the fill ran in the recorded risk mode");
      }
      previous = step.state;
    }
  }
});

test("replay validation rejects missing transfer evidence or false provenance", async () => {
  const replay = JSON.parse(await readFile(new URL("./data/acts.json", import.meta.url), "utf8"));
  const missingTransfer = structuredClone(replay);
  missingTransfer.acts[0].steps.find((step: any) => step.kind === "treasury-sell").transfers = [];
  assert.throws(() => verifyReplay(missingTransfer), /Missing token-transfer/);
  const wrongSource = structuredClone(replay);
  wrongSource.acts[0].steps[0].source.blockNumber++;
  assert.throws(() => verifyReplay(wrongSource));
  const unlabelled = structuredClone(replay);
  unlabelled.syntheticOracleHistory = false;
  assert.throws(() => verifyReplay(unlabelled));
});
