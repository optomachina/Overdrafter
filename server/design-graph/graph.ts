import { randomUUID } from "node:crypto";
import {
  createDefaultRegistry,
  type AgentEmission,
  type DecisionSpec,
  type DesignRequest,
  type DomainAgent,
  type DomainAgentRegistry,
} from "./agents";
import {
  InMemoryControlCommandStore,
  RunCancelledError,
  canControlRun,
  isActiveControlKind,
  isTerminalRunState,
  requestTransition,
  validateControlCommand,
  type ControlActor,
  type ControlCommand,
  type ControlCommandStore,
  type ControlResult,
  type RecordedControlResult,
  type RunState,
} from "./control";
import {
  assertValidDesignGraphEvent,
  isControlEventType,
  type ActiveControlKind,
  type ArtifactEvent,
  type CheckpointKind,
  type DesignGraphEvent,
  type ErrorCode,
  type NodeId,
  type ResultArtifactRef,
  type SkipCause,
  type StatusState,
} from "./events";

export type { RunState } from "./control";

export interface GraphClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: GraphClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const DEFAULT_DECISION_TIMEOUT_MS = 5 * 60 * 1000;

// The worker's hold on a run: taken when execution starts, released when the run ends.
export interface RunClaim {
  workerId: string;
  state: "held" | "released";
}

export interface RunSnapshot {
  runId: string;
  state: RunState;
  ownerId?: string;
  agentId?: DomainAgent["id"];
  picks: Record<string, string>;
  // Artifacts published so far; on a cancelled run these are what was kept.
  artifacts: ResultArtifactRef[];
  pendingControls: number;
  claim: RunClaim | null;
}

export interface SubmitOptions {
  // Recorded on the run; control() authorizes against this, never against the request.
  ownerId?: string;
}

export type DecisionAnswer = { kind: "choose"; choice: string } | { kind: "skip" };

export type ResolveDecisionResult =
  | { ok: true }
  | { ok: false; reason: "unknown_run" | "unknown_decision" | "invalid_choice" };

export type DesignGraphListener = (event: DesignGraphEvent) => void;

export interface DesignGraphOptions {
  registry?: DomainAgentRegistry;
  clock?: GraphClock;
  decisionTimeoutMs?: number;
  createRunId?: () => string;
  onEvent?: DesignGraphListener;
  controlStore?: ControlCommandStore;
  workerId?: string;
}

type DecisionSettlement = { kind: "choose"; choice: string } | { kind: "skip"; cause: SkipCause };

interface PendingDecision {
  spec: DecisionSpec;
  settle(settlement: DecisionSettlement): void;
}

interface PendingControl {
  commandId: string;
  kind: ActiveControlKind;
}

interface Run {
  runId: string;
  request: DesignRequest;
  ownerId?: string;
  state: RunState;
  nodeId: NodeId;
  agentId?: DomainAgent["id"];
  picks: Record<string, string>;
  artifacts: ArtifactEvent[];
  events: DesignGraphEvent[];
  listeners: Set<DesignGraphListener>;
  pending: Map<string, PendingDecision>;
  controls: PendingControl[];
  commandSeq: number;
  claim: RunClaim | null;
  // Set while the run is blocked (paused, or waiting on a decision); control() calls it.
  wake?: () => void;
  terminal: Promise<void>;
  markTerminal(): void;
}

type EventBody = DesignGraphEvent extends infer E ? (E extends DesignGraphEvent ? Omit<E, "runId" | "seq" | "at"> : never) : never;

const isTerminal = isTerminalRunState;

const artifactRefs = (artifacts: ArtifactEvent[]): ResultArtifactRef[] => artifacts.map(({ kind, uri }) => ({ kind, uri }));

export class DesignGraph {
  private readonly registry: DomainAgentRegistry;
  private readonly clock: GraphClock;
  private readonly decisionTimeoutMs: number;
  private readonly createRunId: () => string;
  private readonly onEvent?: DesignGraphListener;
  private readonly controlStore: ControlCommandStore;
  private readonly workerId: string;
  private readonly runs = new Map<string, Run>();

  constructor(options: DesignGraphOptions = {}) {
    this.registry = options.registry ?? createDefaultRegistry();
    this.clock = options.clock ?? systemClock;
    this.decisionTimeoutMs = options.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
    this.createRunId = options.createRunId ?? randomUUID;
    this.onEvent = options.onEvent;
    this.controlStore = options.controlStore ?? new InMemoryControlCommandStore();
    this.workerId = options.workerId ?? "design-graph-local";
  }

  // Returns immediately; the run starts on the next microtask so callers can subscribe first.
  submit(request: DesignRequest, options: SubmitOptions = {}): string {
    if (options.ownerId !== undefined && options.ownerId.trim().length === 0) throw new Error("ownerId must be non-empty");
    const runId = this.createRunId();
    let markTerminal = () => {};
    const terminal = new Promise<void>((resolve) => {
      markTerminal = resolve;
    });
    const run: Run = {
      runId,
      request: { ...request },
      ownerId: options.ownerId,
      state: "running",
      nodeId: "intake",
      picks: {},
      artifacts: [],
      events: [],
      listeners: new Set(),
      pending: new Map(),
      controls: [],
      commandSeq: 0,
      claim: null,
      terminal,
      markTerminal,
    };
    this.runs.set(runId, run);
    void Promise.resolve().then(() => this.execute(run));
    return runId;
  }

  resolveDecision(runId: string, decisionId: string, answer: DecisionAnswer): ResolveDecisionResult {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, reason: "unknown_run" };
    const pending = run.pending.get(decisionId);
    if (!pending) return { ok: false, reason: "unknown_decision" };
    if (answer.kind === "choose" && !pending.spec.options.includes(answer.choice)) {
      return { ok: false, reason: "invalid_choice" };
    }
    pending.settle(answer.kind === "choose" ? answer : { kind: "skip", cause: "skip" });
    return { ok: true };
  }

  // Pause or cancel a run. Order: unknown run (404), malformed (400), authorization (403),
  // not-yet kinds (501), then idempotency on (runId, idempotencyKey). Only accepted and
  // rejected outcomes are recorded and emit events; 400/403/501 change nothing.
  async control(runId: string, command: ControlCommand, actor: ControlActor): Promise<ControlResult> {
    const run = this.runs.get(runId);
    if (!run) return { status: 404, outcome: "unknown_run" };
    const errors = validateControlCommand(command);
    if (errors.length > 0) return { status: 400, outcome: "invalid", errors };
    if (!canControlRun(actor, run.ownerId)) return { status: 403, outcome: "forbidden" };
    const { kind, idempotencyKey } = command;
    if (!isActiveControlKind(kind)) return { status: 501, outcome: "not_yet", kind };
    const claim = this.controlStore.claim(runId, idempotencyKey, kind, () =>
      this.acceptControl(run, kind, actor, idempotencyKey),
    );
    if (claim.kind === "conflict") return { status: 409, outcome: "idempotency_conflict" };
    return claim.result;
  }

  subscribe(runId: string, listener: DesignGraphListener): () => void {
    const run = this.requireRun(runId);
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  getEvents(runId: string): DesignGraphEvent[] {
    return [...this.requireRun(runId).events];
  }

  getRun(runId: string): RunSnapshot {
    const run = this.requireRun(runId);
    return {
      runId,
      state: run.state,
      ...(run.ownerId ? { ownerId: run.ownerId } : {}),
      agentId: run.agentId,
      picks: { ...run.picks },
      artifacts: artifactRefs(run.artifacts),
      pendingControls: run.controls.length,
      claim: run.claim ? { ...run.claim } : null,
    };
  }

  async waitForTerminal(runId: string): Promise<RunSnapshot> {
    await this.requireRun(runId).terminal;
    return this.getRun(runId);
  }

  private requireRun(runId: string): Run {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown design-graph run: ${runId}`);
    return run;
  }

  // Terminal runs accept only control events (so a late command can still be rejected).
  private emit(run: Run, body: EventBody): DesignGraphEvent | undefined {
    if (isTerminal(run.state) && !isControlEventType(body.type)) return undefined;
    const event = assertValidDesignGraphEvent({ ...body, runId: run.runId, seq: run.events.length, at: this.clock.now() });
    run.events.push(event);
    for (const listener of [this.onEvent, ...run.listeners]) {
      try {
        listener?.(event);
      } catch {
        // A faulty listener must not break the run.
      }
    }
    return event;
  }

  private status(run: Run, nodeId: NodeId, state: StatusState, message: string): void {
    this.emit(run, { type: "status", nodeId, state, message });
  }

  private finish(run: Run, state: "completed" | "failed" | "cancelled"): void {
    if (isTerminal(run.state)) return;
    run.state = state;
    if (run.claim) run.claim = { ...run.claim, state: "released" };
    run.wake = undefined;
    // A run that fails with commands still queued answers each of them.
    for (const { commandId, kind } of run.controls.splice(0)) {
      this.emit(run, { type: "control_rejected", commandId, nodeId: run.nodeId, kind, reason: "terminal" });
    }
    run.markTerminal();
  }

  private acceptControl(run: Run, kind: ActiveControlKind, actor: ControlActor, idempotencyKey: string): RecordedControlResult {
    const commandId = `${run.runId}:cmd-${++run.commandSeq}`;
    this.emit(run, { type: "control_requested", commandId, nodeId: run.nodeId, kind, actorId: actor.userId, idempotencyKey });
    const transition = requestTransition(run.state, kind);
    if (transition.kind === "reject") {
      this.emit(run, { type: "control_rejected", commandId, nodeId: run.nodeId, kind, reason: transition.reason });
      return { status: 200, outcome: "rejected", commandId, kind, reason: transition.reason };
    }
    run.state = transition.next;
    run.controls.push({ commandId, kind });
    run.wake?.();
    return { status: 202, outcome: "accepted", commandId, kind, state: run.state };
  }

  // Applies queued commands. Called only where nothing is mid-write: node boundaries,
  // agent checkpoints, and decision waits.
  private applyControls(run: Run, checkpoint: CheckpointKind): "continue" | "paused" | "cancelled" {
    if (run.state === "cancelled") return "cancelled";
    if (run.state === "cancelling") {
      const kept = artifactRefs(run.artifacts);
      const commands = run.controls.splice(0);
      for (const { commandId, kind } of commands) {
        if (kind === "pause") this.emit(run, { type: "control_rejected", commandId, nodeId: run.nodeId, kind, reason: "superseded" });
      }
      for (const { commandId, kind } of commands) {
        if (kind === "cancel") {
          this.emit(run, { type: "control_applied", commandId, kind, nodeId: run.nodeId, checkpoint, state: "cancelled", kept });
        }
      }
      this.finish(run, "cancelled");
      return "cancelled";
    }
    if (run.state === "pausing") {
      for (const { commandId, kind } of run.controls.splice(0)) {
        if (kind === "pause") this.emit(run, { type: "control_applied", commandId, kind, nodeId: run.nodeId, checkpoint, state: "paused" });
      }
      run.state = "paused";
    }
    return run.state === "paused" ? "paused" : "continue";
  }

  // A safe checkpoint. A paused run blocks here until a command wakes it; slice 1 has no
  // resume, so the only way out is cancel.
  private async checkpoint(run: Run, checkpoint: CheckpointKind): Promise<void> {
    for (;;) {
      const outcome = this.applyControls(run, checkpoint);
      if (outcome === "cancelled") throw new RunCancelledError(run.runId);
      if (outcome === "continue") return;
      await new Promise<void>((resolve) => {
        run.wake = resolve;
      });
      run.wake = undefined;
    }
  }

  private enterNode(run: Run, nodeId: NodeId): Promise<void> {
    run.nodeId = nodeId;
    return this.checkpoint(run, "node_boundary");
  }

  private fail(run: Run, nodeId: NodeId, code: ErrorCode, message: string): void {
    this.emit(run, { type: "error", nodeId, code, message, ...(run.agentId ? { agentId: run.agentId } : {}) });
    this.finish(run, "failed");
  }

  private async execute(run: Run): Promise<void> {
    let nodeId: NodeId = "intake";
    run.claim = { workerId: this.workerId, state: "held" };
    try {
      await this.enterNode(run, nodeId);
      this.status(run, "intake", "started", "Reading request");
      const route = this.registry.route(run.request);
      if (route.kind === "unrouted") return this.fail(run, "intake", "no_agent", "no domain agent can handle this request");
      if (route.kind === "disabled") {
        run.agentId = route.agentId;
        return this.fail(run, "intake", "agent_not_enabled", `agent not enabled: ${route.agentId}`);
      }
      const agent = route.agent;
      run.agentId = agent.id;
      this.status(run, "intake", "completed", `Routed to ${agent.id} agent`);

      nodeId = "concept_picks";
      await this.enterNode(run, nodeId);
      this.status(run, nodeId, "started", "Choosing concept");
      for (const spec of agent.conceptPicks?.(run.request) ?? []) {
        run.picks[spec.key] = await this.decide(run, nodeId, spec);
        await this.checkpoint(run, "node_boundary");
      }
      this.status(run, nodeId, "completed", "Concept chosen");

      nodeId = "domain_agent";
      await this.enterNode(run, nodeId);
      this.status(run, nodeId, "started", `Running ${agent.id} agent`);
      const artifacts = run.artifacts;
      let open = true;
      const agentEmit = (emission: AgentEmission) => {
        if (!open) return;
        if (emission.type === "status") {
          this.status(run, "domain_agent", emission.state, emission.message);
          return;
        }
        const event = this.emit(run, { ...emission, nodeId: "domain_agent", agentId: agent.id });
        if (event?.type === "artifact") artifacts.push(event);
      };
      let summary: string;
      try {
        const checkpoint = () => (open ? this.checkpoint(run, "agent") : Promise.resolve());
        const ctx = { runId: run.runId, request: { ...run.request }, picks: { ...run.picks }, checkpoint };
        summary = (await agent.run(ctx, agentEmit)).summary;
      } catch (error) {
        if (isTerminal(run.state) || error instanceof RunCancelledError) return;
        return this.fail(run, nodeId, "agent_failed", `${agent.id} agent failed: ${errorMessage(error)}`);
      } finally {
        open = false;
      }
      // An agent that never calls ctx.checkpoint() is still stopped here.
      await this.checkpoint(run, "node_boundary");
      this.status(run, nodeId, "completed", `${agent.id} agent finished`);

      nodeId = "verify";
      await this.enterNode(run, nodeId);
      this.status(run, nodeId, "started", "Verifying artifacts");
      if (artifacts.length === 0) return this.fail(run, nodeId, "verify_failed", `${agent.id} agent produced no artifacts`);
      this.status(run, nodeId, "completed", `${artifacts.length} artifacts verified`);

      nodeId = "result";
      await this.enterNode(run, nodeId);
      this.emit(run, {
        type: "result",
        nodeId: "result",
        agentId: agent.id,
        summary: summary || `${agent.id} run complete`,
        picks: { ...run.picks },
        artifacts: artifactRefs(artifacts),
      });
      this.finish(run, "completed");
    } catch (error) {
      if (error instanceof RunCancelledError) return;
      if (!isTerminal(run.state)) this.fail(run, nodeId, "internal_error", errorMessage(error));
    }
  }

  // "Let it cook": every decision carries a best guess, and skip or timeout proceeds with it.
  private decide(run: Run, nodeId: NodeId, spec: DecisionSpec): Promise<string> {
    const decisionId = `${run.runId}:${spec.key}`;
    return new Promise<string>((resolve, reject) => {
      const settle = (settlement: DecisionSettlement) => {
        if (!run.pending.delete(decisionId)) return;
        this.clock.clearTimeout(timer);
        run.wake = undefined;
        if (run.state === "awaiting_decision") run.state = "running";
        if (settlement.kind === "choose") {
          this.emit(run, {
            type: "decision_resolved",
            decisionId,
            nodeId,
            outcome: "chosen",
            choice: settlement.choice,
            rationale: `User chose "${settlement.choice}".`,
          });
          resolve(settlement.choice);
          return;
        }
        const why = settlement.cause === "timeout" ? `No answer within ${this.decisionTimeoutMs} ms` : "User skipped";
        this.emit(run, {
          type: "decision_resolved",
          decisionId,
          nodeId,
          outcome: "skipped_best_guess",
          cause: settlement.cause,
          choice: spec.bestGuess,
          rationale: `${why}; proceeding with best guess "${spec.bestGuess}": ${spec.bestGuessRationale}`,
        });
        resolve(spec.bestGuess);
      };
      run.pending.set(decisionId, { spec, settle });
      if (run.state === "running") run.state = "awaiting_decision";
      const timer = this.clock.setTimeout(() => settle({ kind: "skip", cause: "timeout" }), this.decisionTimeoutMs);
      // Waiting on a decision is a safe checkpoint: a cancel applies at once and drops the
      // open decision. A pause waits for the next boundary after the decision settles.
      run.wake = () => {
        if (run.state !== "cancelling" || !run.pending.delete(decisionId)) return;
        this.clock.clearTimeout(timer);
        run.wake = undefined;
        this.applyControls(run, "decision");
        reject(new RunCancelledError(run.runId));
      };
      this.emit(run, {
        type: "decision_requested",
        decisionId,
        nodeId,
        question: spec.question,
        options: [...spec.options],
        recommended: spec.recommended,
        bestGuess: spec.bestGuess,
        timeoutMs: this.decisionTimeoutMs,
      });
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
