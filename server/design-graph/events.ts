// Typed design-graph events plus a hand-written runtime validator. Every event the
// graph emits passes validateDesignGraphEvent before it reaches a listener.

export const NODE_IDS = ["intake", "concept_picks", "domain_agent", "verify", "result"] as const;
export type NodeId = (typeof NODE_IDS)[number];

export const DOMAIN_IDS = ["cad", "optics", "electronics", "analysis"] as const;
export type DomainId = (typeof DOMAIN_IDS)[number];

export const ARTIFACT_KINDS = ["png", "glb", "step"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const STATUS_STATES = ["started", "completed", "info"] as const;
export type StatusState = (typeof STATUS_STATES)[number];

export const DECISION_OUTCOMES = ["chosen", "skipped_best_guess"] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export const SKIP_CAUSES = ["skip", "timeout"] as const;
export type SkipCause = (typeof SKIP_CAUSES)[number];

export const ERROR_CODES = ["agent_not_enabled", "no_agent", "agent_failed", "verify_failed", "internal_error"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

// Every control kind the API names; slice 1 applies only ACTIVE_CONTROL_KINDS.
export const CONTROL_KINDS = ["pause", "resume", "steer", "cancel"] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];

export const ACTIVE_CONTROL_KINDS = ["pause", "cancel"] as const;
export type ActiveControlKind = (typeof ACTIVE_CONTROL_KINDS)[number];

// Where a control command took effect: between nodes, at an agent's ctx.checkpoint(),
// or while the run was waiting on a decision.
export const CHECKPOINT_KINDS = ["node_boundary", "agent", "decision"] as const;
export type CheckpointKind = (typeof CHECKPOINT_KINDS)[number];

export const CONTROL_REJECT_REASONS = ["terminal", "duplicate", "cancel_pending", "superseded"] as const;
export type ControlRejectReason = (typeof CONTROL_REJECT_REASONS)[number];

export interface EventEnvelope {
  runId: string;
  seq: number;
  at: number;
}

export interface StatusEvent extends EventEnvelope {
  type: "status";
  nodeId: NodeId;
  state: StatusState;
  message: string;
}

export interface DecisionRequestedEvent extends EventEnvelope {
  type: "decision_requested";
  decisionId: string;
  nodeId: NodeId;
  question: string;
  options: string[];
  recommended: string;
  bestGuess: string;
  timeoutMs: number;
}

export type DecisionResolvedEvent = EventEnvelope & {
  type: "decision_resolved";
  decisionId: string;
  nodeId: NodeId;
  choice: string;
  rationale: string;
} & ({ outcome: "chosen" } | { outcome: "skipped_best_guess"; cause: SkipCause });

export interface ArtifactDimensionsMm {
  x: number;
  y: number;
  z: number;
}

export interface ArtifactEvent extends EventEnvelope {
  type: "artifact";
  nodeId: NodeId;
  agentId: DomainId;
  kind: ArtifactKind;
  name: string;
  mimeType: string;
  uri: string;
  dimensionsMm?: ArtifactDimensionsMm;
}

export interface ResultArtifactRef {
  kind: ArtifactKind;
  uri: string;
}

export interface ResultEvent extends EventEnvelope {
  type: "result";
  nodeId: "result";
  agentId: DomainId;
  summary: string;
  picks: Record<string, string>;
  artifacts: ResultArtifactRef[];
}

export interface ErrorEvent extends EventEnvelope {
  type: "error";
  nodeId: NodeId;
  code: ErrorCode;
  message: string;
  agentId?: DomainId;
}

export interface ControlRequestedEvent extends EventEnvelope {
  type: "control_requested";
  commandId: string;
  nodeId: NodeId;
  kind: ActiveControlKind;
  actorId: string;
  idempotencyKey: string;
}

export type ControlAppliedEvent = EventEnvelope & {
  type: "control_applied";
  commandId: string;
  nodeId: NodeId;
  checkpoint: CheckpointKind;
} & ({ kind: "pause"; state: "paused" } | { kind: "cancel"; state: "cancelled"; kept: ResultArtifactRef[] });

export interface ControlRejectedEvent extends EventEnvelope {
  type: "control_rejected";
  commandId: string;
  nodeId: NodeId;
  kind: ActiveControlKind;
  reason: ControlRejectReason;
}

export type DesignGraphEvent =
  | StatusEvent
  | DecisionRequestedEvent
  | DecisionResolvedEvent
  | ArtifactEvent
  | ResultEvent
  | ErrorEvent
  | ControlRequestedEvent
  | ControlAppliedEvent
  | ControlRejectedEvent;

export const CONTROL_EVENT_TYPES = ["control_requested", "control_applied", "control_rejected"] as const;

export const isControlEventType = (type: unknown): boolean =>
  typeof type === "string" && (CONTROL_EVENT_TYPES as readonly string[]).includes(type);

export type DesignGraphEventType = DesignGraphEvent["type"];

export type ValidationResult = { ok: true; event: DesignGraphEvent } | { ok: false; errors: string[] };

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function requireString(event: Rec, key: string, errors: string[]) {
  if (!isNonEmptyString(event[key])) errors.push(`${key} must be a non-empty string`);
}

function requireEnum<T extends string>(event: Rec, key: string, values: readonly T[], errors: string[]) {
  if (!isOneOf(values, event[key])) errors.push(`${key} must be one of ${values.join("|")}`);
}

function validateArtifactRef(value: unknown, path: string, errors: string[]) {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!isOneOf(ARTIFACT_KINDS, value.kind)) errors.push(`${path}.kind must be one of ${ARTIFACT_KINDS.join("|")}`);
  if (!isNonEmptyString(value.uri)) errors.push(`${path}.uri must be a non-empty string`);
}

function validateBody(event: Rec, errors: string[]) {
  switch (event.type) {
    case "status":
      requireEnum(event, "nodeId", NODE_IDS, errors);
      requireEnum(event, "state", STATUS_STATES, errors);
      requireString(event, "message", errors);
      return;
    case "decision_requested": {
      requireString(event, "decisionId", errors);
      requireEnum(event, "nodeId", NODE_IDS, errors);
      requireString(event, "question", errors);
      requireString(event, "recommended", errors);
      requireString(event, "bestGuess", errors);
      if (!isFiniteNonNegative(event.timeoutMs)) errors.push("timeoutMs must be a finite non-negative number");
      const options = event.options;
      if (!Array.isArray(options) || options.length < 2 || !options.every(isNonEmptyString)) {
        errors.push("options must be an array of at least two non-empty strings");
        return;
      }
      if (new Set(options).size !== options.length) errors.push("options must be unique");
      if (isNonEmptyString(event.recommended) && !options.includes(event.recommended)) {
        errors.push("recommended must be one of options");
      }
      if (isNonEmptyString(event.bestGuess) && !options.includes(event.bestGuess)) {
        errors.push("bestGuess must be one of options");
      }
      return;
    }
    case "decision_resolved":
      requireString(event, "decisionId", errors);
      requireEnum(event, "nodeId", NODE_IDS, errors);
      requireString(event, "choice", errors);
      requireString(event, "rationale", errors);
      requireEnum(event, "outcome", DECISION_OUTCOMES, errors);
      if (event.outcome === "skipped_best_guess") requireEnum(event, "cause", SKIP_CAUSES, errors);
      if (event.outcome === "chosen" && "cause" in event) errors.push("cause is only allowed when outcome is skipped_best_guess");
      return;
    case "artifact":
      requireEnum(event, "nodeId", NODE_IDS, errors);
      requireEnum(event, "agentId", DOMAIN_IDS, errors);
      requireEnum(event, "kind", ARTIFACT_KINDS, errors);
      requireString(event, "name", errors);
      requireString(event, "mimeType", errors);
      requireString(event, "uri", errors);
      if (event.dimensionsMm !== undefined) {
        const dims = event.dimensionsMm;
        if (!isRecord(dims) || !["x", "y", "z"].every((axis) => typeof dims[axis] === "number" && (dims[axis] as number) > 0)) {
          errors.push("dimensionsMm must have positive numeric x, y, z");
        }
      }
      return;
    case "result":
      if (event.nodeId !== "result") errors.push("nodeId must be result");
      requireEnum(event, "agentId", DOMAIN_IDS, errors);
      requireString(event, "summary", errors);
      if (!isRecord(event.picks) || !Object.values(event.picks).every(isNonEmptyString)) {
        errors.push("picks must be a record of non-empty strings");
      }
      if (!Array.isArray(event.artifacts)) {
        errors.push("artifacts must be an array");
      } else {
        event.artifacts.forEach((ref, index) => validateArtifactRef(ref, `artifacts[${index}]`, errors));
      }
      return;
    case "error":
      requireEnum(event, "nodeId", NODE_IDS, errors);
      requireEnum(event, "code", ERROR_CODES, errors);
      requireString(event, "message", errors);
      if (event.agentId !== undefined) requireEnum(event, "agentId", DOMAIN_IDS, errors);
      return;
    case "control_requested":
      requireString(event, "commandId", errors);
      requireEnum(event, "nodeId", NODE_IDS, errors);
      requireEnum(event, "kind", ACTIVE_CONTROL_KINDS, errors);
      requireString(event, "actorId", errors);
      requireString(event, "idempotencyKey", errors);
      return;
    case "control_applied":
      requireString(event, "commandId", errors);
      requireEnum(event, "nodeId", NODE_IDS, errors);
      requireEnum(event, "checkpoint", CHECKPOINT_KINDS, errors);
      if (event.kind === "pause") {
        if (event.state !== "paused") errors.push("state must be paused when kind is pause");
        if ("kept" in event) errors.push("kept is only allowed when kind is cancel");
      } else if (event.kind === "cancel") {
        if (event.state !== "cancelled") errors.push("state must be cancelled when kind is cancel");
        if (!Array.isArray(event.kept)) {
          errors.push("kept must be an array");
        } else {
          event.kept.forEach((ref, index) => validateArtifactRef(ref, `kept[${index}]`, errors));
        }
      } else {
        errors.push(`kind must be one of ${ACTIVE_CONTROL_KINDS.join("|")}`);
      }
      return;
    case "control_rejected":
      requireString(event, "commandId", errors);
      requireEnum(event, "nodeId", NODE_IDS, errors);
      requireEnum(event, "kind", ACTIVE_CONTROL_KINDS, errors);
      requireEnum(event, "reason", CONTROL_REJECT_REASONS, errors);
      return;
    default:
      errors.push(`unknown event type: ${String(event.type)}`);
  }
}

export function validateDesignGraphEvent(value: unknown): ValidationResult {
  if (!isRecord(value)) return { ok: false, errors: ["event must be an object"] };
  const errors: string[] = [];
  requireString(value, "runId", errors);
  if (typeof value.seq !== "number" || !Number.isInteger(value.seq) || value.seq < 0) {
    errors.push("seq must be a non-negative integer");
  }
  if (!isFiniteNonNegative(value.at)) errors.push("at must be a finite non-negative number");
  validateBody(value, errors);
  return errors.length === 0 ? { ok: true, event: value as unknown as DesignGraphEvent } : { ok: false, errors };
}

export class InvalidDesignGraphEventError extends Error {
  constructor(readonly errors: string[]) {
    super(`invalid design-graph event: ${errors.join("; ")}`);
    this.name = "InvalidDesignGraphEventError";
  }
}

export function assertValidDesignGraphEvent(value: unknown): DesignGraphEvent {
  const result = validateDesignGraphEvent(value);
  if (!result.ok) throw new InvalidDesignGraphEventError(result.errors);
  return result.event;
}
