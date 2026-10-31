import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, vi } from "vitest";

/** Shared harness for the claim-fenced acceptance route tests on both worker routes. */
export type AcceptanceScenario = {
  name: string;
  replies: unknown[];
  drain: boolean;
  failed?: boolean;
  attempts?: number;
  drainError?: boolean;
};

export const ACCEPTANCE_SCENARIOS: AcceptanceScenario[] = [
  { name: "accepted", replies: [{ outcome: "accepted" }], drain: true },
  { name: "request_canceled", replies: [{ outcome: "request_canceled" }], drain: true },
  { name: "stale", replies: [{ outcome: "stale" }], drain: false },
  { name: "fenced", replies: [{ outcome: "fenced" }], drain: false, failed: true },
  { name: "payload_mismatch", replies: [{ outcome: "payload_mismatch" }], drain: false, failed: true },
  { name: "busy then accepted", replies: [{ outcome: "busy" }, { outcome: "accepted" }], drain: true },
  { name: "busy exhausted", replies: [{ outcome: "busy" }], drain: false, failed: true, attempts: 10 },
  { name: "lost response then replayed", replies: [new Error("lost response"), { outcome: "replayed", original_outcome: "accepted" }], drain: true },
  { name: "replayed cancellation", replies: [{ outcome: "replayed", original_outcome: "request_canceled" }], drain: true },
  { name: "drain failure", replies: [{ outcome: "accepted" }], drain: true, drainError: true },
];

/** Upper bound of the worst-case busy backoff (about 18 s) with Math.random pinned to 1. */
export const ACCEPTANCE_BACKOFF_MS = 18000;

export const CLAIMED_LOCKED_AT = "2026-10-29T12:34:56.123456+00:00";

export function prepareAcceptanceScenario() {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(1);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
}

/** Replaces the acceptance and drain RPCs; every other RPC reaches the original client. */
export function stubAcceptanceRpc(client: SupabaseClient, scenario: AcceptanceScenario) {
  const rpc = client.rpc.bind(client);
  const acceptanceArgs: Record<string, unknown>[] = [];
  const counts = { drains: 0 };
  (client as unknown as { rpc: typeof rpc }).rpc = ((name: string, args: Record<string, unknown>) => {
    if (name === "accept_vendor_quote_result") {
      return (async () => {
        const reply = scenario.replies[Math.min(acceptanceArgs.length, scenario.replies.length - 1)];
        acceptanceArgs.push(structuredClone(args));
        if (reply instanceof Error) throw reply;
        return { data: reply, error: null };
      })();
    }
    if (name === "drain_quote_run_rollup_followups") {
      return (async () => {
        counts.drains += 1;
        if (scenario.drainError) throw new Error("drain failed");
        return { data: {}, error: null };
      })();
    }
    return rpc(name, args);
  }) as typeof rpc;
  return { acceptanceArgs, counts };
}

export function expectClaimBoundary(input: {
  scenario: AcceptanceScenario;
  stub: ReturnType<typeof stubAcceptanceRpc>;
  claimed: { id: string; locked_by: string | null; locked_at: string | null; attempts: number };
  taskPayloadPatch: Record<string, unknown>;
  writes: Record<string, unknown>[];
}) {
  const { scenario, stub: { acceptanceArgs, counts }, claimed, writes } = input;
  expect(acceptanceArgs).toHaveLength(scenario.attempts ?? scenario.replies.length);
  expect(acceptanceArgs[0]).toMatchObject({
    p_task_id: claimed.id, p_locked_by: claimed.locked_by, p_locked_at: claimed.locked_at,
    p_attempts: claimed.attempts, p_task_payload_patch: input.taskPayloadPatch,
  });
  for (const args of acceptanceArgs) expect(args).toEqual(acceptanceArgs[0]);
  expect(counts.drains).toBe(scenario.drain ? 1 : 0);
  if (!scenario.failed) {
    expect(writes.filter((write) => write.table === "work_queue")).toEqual([]);
  }
  if (scenario.name === "stale") {
    expect(writes.filter((write) => write.table === "vendor_quote_results" &&
      (write.update as { status?: string })?.status !== "running")).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("claim lost"));
  }
}
