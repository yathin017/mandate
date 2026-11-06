import { mandateModuleAbi, mandateQuoterAbi, scenarioActorAbi } from "@mandate/sdk";
import { parseEventLogs, type Address, type Hash, type Hex, type Log } from "viem";

/** ABI fragments of every event we index. */
const eventAbi = [...mandateModuleAbi, ...mandateQuoterAbi, ...scenarioActorAbi].filter(
  (item) => item.type === "event",
);

export interface DecodedEvent {
  readonly eventName: string;
  readonly args: Record<string, unknown>;
  readonly address: Address;
  readonly blockNumber: bigint;
  readonly blockHash: Hash;
  readonly txHash: Hash;
  readonly logIndex: number;
}

export interface EventSources {
  readonly module: Address;
  readonly quoter: Address;
  readonly actor: Address;
}

const QUOTER_EVENTS = new Set(["Filled", "FeeAccrued"]);
const ACTOR_EVENTS = new Set(["Attempted"]);

/**
 * Decodes logs and drops any whose emitter is not the contract that defines the event: an attacker contract
 * emitting a look-alike `Filled` must never become history.
 */
export function decodeLogs(logs: readonly Log[], sources: EventSources): DecodedEvent[] {
  const parsed = parseEventLogs({ abi: eventAbi, logs: logs as Log[], strict: true });
  const out: DecodedEvent[] = [];
  for (const log of parsed) {
    if (log.blockNumber === null || log.blockHash === null || log.transactionHash === null || log.logIndex === null) {
      continue; // pending logs are never indexed
    }
    const emitter = log.address.toLowerCase();
    const expected = QUOTER_EVENTS.has(log.eventName)
      ? sources.quoter
      : ACTOR_EVENTS.has(log.eventName)
        ? sources.actor
        : sources.module;
    if (emitter !== expected.toLowerCase()) continue;
    out.push({
      eventName: log.eventName,
      args: log.args as Record<string, unknown>,
      address: log.address,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      txHash: log.transactionHash,
      logIndex: log.logIndex,
    });
  }
  return out.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
}

/** Mandate an event belongs to, if any. */
export function mandateIdOf(event: DecodedEvent): Hex | null {
  const id = event.args.mandateId;
  return typeof id === "string" ? (id.toLowerCase() as Hex) : null;
}
