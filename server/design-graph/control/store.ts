import type { ActiveControlKind } from "../events";
import type { RecordedControlResult } from "./commands";

export type ClaimResult =
  | { kind: "created"; result: Promise<RecordedControlResult> }
  | { kind: "replay"; result: Promise<RecordedControlResult> }
  | { kind: "conflict" };

// Unique on (runId, idempotencyKey). `create` runs at most once per key; a repeat gets
// the original result, and a repeat with a different kind is a conflict.
export interface ControlCommandStore {
  claim(runId: string, idempotencyKey: string, kind: ActiveControlKind, create: () => RecordedControlResult): ClaimResult;
  has(runId: string, idempotencyKey: string): boolean;
  size(): number;
}

interface ControlRecord {
  kind: ActiveControlKind;
  result: Promise<RecordedControlResult>;
}

// Stand-in for the jarvis_control_commands table. The record is written before `create`
// returns, so two concurrent calls with the same key cannot both run it.
export class InMemoryControlCommandStore implements ControlCommandStore {
  private readonly records = new Map<string, ControlRecord>();

  claim(runId: string, idempotencyKey: string, kind: ActiveControlKind, create: () => RecordedControlResult): ClaimResult {
    const id = recordId(runId, idempotencyKey);
    const existing = this.records.get(id);
    if (existing) return existing.kind === kind ? { kind: "replay", result: existing.result } : { kind: "conflict" };
    let settle!: (result: RecordedControlResult) => void;
    const result = new Promise<RecordedControlResult>((resolve) => {
      settle = resolve;
    });
    this.records.set(id, { kind, result });
    try {
      settle(create());
    } catch (error) {
      this.records.delete(id);
      throw error;
    }
    return { kind: "created", result };
  }

  has(runId: string, idempotencyKey: string): boolean {
    return this.records.has(recordId(runId, idempotencyKey));
  }

  size(): number {
    return this.records.size;
  }
}

const recordId = (runId: string, idempotencyKey: string) => JSON.stringify([runId, idempotencyKey]);
