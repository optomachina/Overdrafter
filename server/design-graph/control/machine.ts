import type { ActiveControlKind, ControlRejectReason } from "../events";

// awaiting_decision is a running sub-state; pausing and cancelling mean a command is
// queued and waits for the next safe checkpoint.
export type RunState =
  | "running"
  | "awaiting_decision"
  | "pausing"
  | "paused"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed";

export const TERMINAL_RUN_STATES = ["completed", "cancelled", "failed"] as const;
export type TerminalRunState = (typeof TERMINAL_RUN_STATES)[number];

export const isTerminalRunState = (state: RunState): boolean =>
  (TERMINAL_RUN_STATES as readonly RunState[]).includes(state);

export type ControlTransition = { kind: "queue"; next: "pausing" | "cancelling" } | { kind: "reject"; reason: ControlRejectReason };

// running -> pausing -> paused; running | pausing | paused -> cancelling -> cancelled.
// Terminal runs reject every command. The second half of each arrow (pausing -> paused,
// cancelling -> cancelled) happens only at a checkpoint, never here.
export function requestTransition(state: RunState, kind: ActiveControlKind): ControlTransition {
  if (isTerminalRunState(state)) return { kind: "reject", reason: "terminal" };
  if (state === "cancelling") return { kind: "reject", reason: kind === "cancel" ? "duplicate" : "cancel_pending" };
  if (kind === "cancel") return { kind: "queue", next: "cancelling" };
  if (state === "pausing" || state === "paused") return { kind: "reject", reason: "duplicate" };
  return { kind: "queue", next: "pausing" };
}
