import {
  ACTIVE_CONTROL_KINDS,
  CONTROL_KINDS,
  type ActiveControlKind,
  type ControlKind,
  type ControlRejectReason,
} from "../events";
import type { RunState } from "./machine";

export type ActorAal = "aal1" | "aal2";

// Who is asking. The run owner never comes from here; the graph reads it from the run.
export interface ControlActor {
  userId: string;
  isAdmin: boolean;
  aal: ActorAal;
}

export interface ControlCommand {
  kind: ControlKind;
  // Reserved for steer (OVD-812); pause and cancel ignore it.
  payload?: unknown;
  idempotencyKey: string;
}

export type ControlResult =
  | { status: 202; outcome: "accepted"; commandId: string; kind: ActiveControlKind; state: RunState }
  | { status: 200; outcome: "rejected"; commandId: string; kind: ActiveControlKind; reason: ControlRejectReason }
  | { status: 501; outcome: "not_yet"; kind: ControlKind }
  | { status: 400; outcome: "invalid"; errors: string[] }
  | { status: 403; outcome: "forbidden" }
  | { status: 404; outcome: "unknown_run" }
  | { status: 409; outcome: "idempotency_conflict" };

// The results recorded against (run_id, idempotency_key); everything else is not stored.
export type RecordedControlResult = Extract<ControlResult, { outcome: "accepted" | "rejected" }>;

export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

export function validateControlCommand(command: unknown): string[] {
  const errors: string[] = [];
  if (typeof command !== "object" || command === null) return ["command must be an object"];
  const { kind, idempotencyKey } = command as Record<string, unknown>;
  if (typeof kind !== "string" || !(CONTROL_KINDS as readonly string[]).includes(kind)) {
    errors.push(`kind must be one of ${CONTROL_KINDS.join("|")}`);
  }
  if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
    errors.push("idempotencyKey must be a non-empty string");
  } else if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    errors.push(`idempotencyKey must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
  }
  return errors;
}

export const isActiveControlKind = (kind: ControlKind): kind is ActiveControlKind =>
  (ACTIVE_CONTROL_KINDS as readonly string[]).includes(kind);

// Allowed for the run owner, or for an admin who has stepped up to AAL2.
export function canControlRun(actor: ControlActor, ownerId: string | undefined): boolean {
  if (typeof actor.userId !== "string" || actor.userId.length === 0) return false;
  if (ownerId !== undefined && actor.userId === ownerId) return true;
  return actor.isAdmin === true && actor.aal === "aal2";
}
