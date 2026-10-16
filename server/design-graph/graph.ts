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
  assertValidDesignGraphEvent,
  type ArtifactEvent,
  type DesignGraphEvent,
  type ErrorCode,
  type NodeId,
  type SkipCause,
  type StatusState,
} from "./events";

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

export type RunState = "running" | "awaiting_decision" | "completed" | "failed";

export interface RunSnapshot {
  runId: string;
  state: RunState;
  agentId?: DomainAgent["id"];
  picks: Record<string, string>;
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
}

type DecisionSettlement = { kind: "choose"; choice: string } | { kind: "skip"; cause: SkipCause };

interface PendingDecision {
  spec: DecisionSpec;
  settle(settlement: DecisionSettlement): void;
}

interface Run {
  runId: string;
  request: DesignRequest;
  state: RunState;
  agentId?: DomainAgent["id"];
  picks: Record<string, string>;
  events: DesignGraphEvent[];
  listeners: Set<DesignGraphListener>;
  pending: Map<string, PendingDecision>;
  terminal: Promise<void>;
  markTerminal(): void;
}

type EventBody = DesignGraphEvent extends infer E ? (E extends DesignGraphEvent ? Omit<E, "runId" | "seq" | "at"> : never) : never;

const isTerminal = (state: RunState) => state === "completed" || state === "failed";

export class DesignGraph {
  private readonly registry: DomainAgentRegistry;
  private readonly clock: GraphClock;
  private readonly decisionTimeoutMs: number;
  private readonly createRunId: () => string;
  private readonly onEvent?: DesignGraphListener;
  private readonly runs = new Map<string, Run>();

  constructor(options: DesignGraphOptions = {}) {
    this.registry = options.registry ?? createDefaultRegistry();
    this.clock = options.clock ?? systemClock;
    this.decisionTimeoutMs = options.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
    this.createRunId = options.createRunId ?? randomUUID;
    this.onEvent = options.onEvent;
  }

  // Returns immediately; the run starts on the next microtask so callers can subscribe first.
  submit(request: DesignRequest): string {
    const runId = this.createRunId();
    let markTerminal = () => {};
    const terminal = new Promise<void>((resolve) => {
      markTerminal = resolve;
    });
    const run: Run = {
      runId,
      request: { ...request },
      state: "running",
      picks: {},
      events: [],
      listeners: new Set(),
      pending: new Map(),
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
    return { runId, state: run.state, agentId: run.agentId, picks: { ...run.picks } };
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

  private emit(run: Run, body: EventBody): DesignGraphEvent | undefined {
    if (isTerminal(run.state)) return undefined;
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

  private finish(run: Run, state: "completed" | "failed"): void {
    run.state = state;
    run.markTerminal();
  }

  private fail(run: Run, nodeId: NodeId, code: ErrorCode, message: string): void {
    this.emit(run, { type: "error", nodeId, code, message, ...(run.agentId ? { agentId: run.agentId } : {}) });
    this.finish(run, "failed");
  }

  private async execute(run: Run): Promise<void> {
    let nodeId: NodeId = "intake";
    try {
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
      this.status(run, nodeId, "started", "Choosing concept");
      for (const spec of agent.conceptPicks?.(run.request) ?? []) {
        run.picks[spec.key] = await this.decide(run, nodeId, spec);
      }
      this.status(run, nodeId, "completed", "Concept chosen");

      nodeId = "domain_agent";
      this.status(run, nodeId, "started", `Running ${agent.id} agent`);
      const artifacts: ArtifactEvent[] = [];
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
        summary = (await agent.run({ runId: run.runId, request: { ...run.request }, picks: { ...run.picks } }, agentEmit)).summary;
      } catch (error) {
        return this.fail(run, nodeId, "agent_failed", `${agent.id} agent failed: ${errorMessage(error)}`);
      } finally {
        open = false;
      }
      this.status(run, nodeId, "completed", `${agent.id} agent finished`);

      nodeId = "verify";
      this.status(run, nodeId, "started", "Verifying artifacts");
      if (artifacts.length === 0) return this.fail(run, nodeId, "verify_failed", `${agent.id} agent produced no artifacts`);
      this.status(run, nodeId, "completed", `${artifacts.length} artifacts verified`);

      this.emit(run, {
        type: "result",
        nodeId: "result",
        agentId: agent.id,
        summary: summary || `${agent.id} run complete`,
        picks: { ...run.picks },
        artifacts: artifacts.map(({ kind, uri }) => ({ kind, uri })),
      });
      this.finish(run, "completed");
    } catch (error) {
      if (!isTerminal(run.state)) this.fail(run, nodeId, "internal_error", errorMessage(error));
    }
  }

  // "Let it cook": every decision carries a best guess, and skip or timeout proceeds with it.
  private decide(run: Run, nodeId: NodeId, spec: DecisionSpec): Promise<string> {
    const decisionId = `${run.runId}:${spec.key}`;
    return new Promise<string>((resolve) => {
      const settle = (settlement: DecisionSettlement) => {
        if (!run.pending.delete(decisionId)) return;
        this.clock.clearTimeout(timer);
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
      run.state = "awaiting_decision";
      const timer = this.clock.setTimeout(() => settle({ kind: "skip", cause: "timeout" }), this.decisionTimeoutMs);
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
