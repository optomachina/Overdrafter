import { CadAgent, isCadAgentEnabled, type CadWorkerRunner, type Env } from "./cad-agent";
import type { ArtifactDimensionsMm, ArtifactKind, DomainId, StatusState } from "./events";

export interface DesignRequest {
  prompt: string;
  // Explicit routing hint; when absent the registry asks each agent's canHandle.
  domain?: DomainId;
}

// A key choice an agent wants made before it runs. The graph asks only when the
// request leaves the choice open, and always proceeds with bestGuess on skip/timeout.
export interface DecisionSpec {
  key: string;
  question: string;
  options: string[];
  recommended: string;
  bestGuess: string;
  bestGuessRationale: string;
}

export type AgentEmission =
  | {
      type: "artifact";
      kind: ArtifactKind;
      name: string;
      mimeType: string;
      uri: string;
      dimensionsMm?: ArtifactDimensionsMm;
    }
  | { type: "status"; state: StatusState; message: string };

export type AgentEmit = (emission: AgentEmission) => void;

export interface AgentContext {
  runId: string;
  request: DesignRequest;
  picks: Readonly<Record<string, string>>;
}

export interface AgentOutput {
  summary: string;
}

export interface DomainAgent {
  id: DomainId;
  canHandle(request: DesignRequest): boolean;
  conceptPicks?(request: DesignRequest): DecisionSpec[];
  run(ctx: AgentContext, emit: AgentEmit): Promise<AgentOutput>;
}

interface RegistryEntry {
  agent: DomainAgent;
  enabled: boolean;
}

export type RouteResult =
  | { kind: "routed"; agent: DomainAgent }
  | { kind: "disabled"; agentId: DomainId }
  | { kind: "unrouted" };

// Insertion order is routing priority: specialist domains are checked before cad.
export class DomainAgentRegistry {
  private readonly entries = new Map<DomainId, RegistryEntry>();

  register(agent: DomainAgent, options: { enabled: boolean }): this {
    this.entries.set(agent.id, { agent, enabled: options.enabled });
    return this;
  }

  setEnabled(id: DomainId, enabled: boolean): void {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`unknown domain agent: ${id}`);
    entry.enabled = enabled;
  }

  isEnabled(id: DomainId): boolean {
    return this.entries.get(id)?.enabled ?? false;
  }

  ids(): DomainId[] {
    return [...this.entries.keys()];
  }

  route(request: DesignRequest): RouteResult {
    const entry = request.domain
      ? this.entries.get(request.domain)
      : [...this.entries.values()].find(({ agent }) => agent.canHandle(request));
    if (!entry) return { kind: "unrouted" };
    if (!entry.enabled) return { kind: "disabled", agentId: entry.agent.id };
    return { kind: "routed", agent: entry.agent };
  }
}

const matchesAny = (prompt: string, patterns: RegExp[]) => patterns.some((pattern) => pattern.test(prompt));

// Placeholder for domains that are registered but not yet implemented. Routing can
// reach them; the graph refuses to run them while they are disabled.
export class DisabledStubAgent implements DomainAgent {
  constructor(
    readonly id: DomainId,
    private readonly patterns: RegExp[],
  ) {}

  canHandle(request: DesignRequest): boolean {
    return matchesAny(request.prompt, this.patterns);
  }

  async run(): Promise<AgentOutput> {
    throw new Error(`${this.id} agent is a stub and is not implemented`);
  }
}

export const PLATE_EDGE_MM = 101.6;
export const PLATE_THICKNESS_MM = 6.35;

const PLATE_MATERIALS = ["6061-T6 aluminum", "304 stainless steel", "acetal (Delrin)"];

// Slice-1 CAD agent: no worker calls, it emits stub artifacts for a 4-inch plate.
export class StubCadAgent implements DomainAgent {
  readonly id = "cad" as const;

  canHandle(request: DesignRequest): boolean {
    return matchesAny(request.prompt, [/\bplate\b/i, /\bbracket\b/i, /\bpart\b/i, /\bcad\b/i, /\bstep\b/i]);
  }

  conceptPicks(request: DesignRequest): DecisionSpec[] {
    if (/aluminum|aluminium|stainless|steel|acetal|delrin/i.test(request.prompt)) return [];
    return [
      {
        key: "material",
        question: "Which material should the plate be?",
        options: PLATE_MATERIALS,
        recommended: "6061-T6 aluminum",
        bestGuess: "6061-T6 aluminum",
        bestGuessRationale: "6061-T6 is the cheapest, most machinable default for a general-purpose flat plate.",
      },
    ];
  }

  async run(ctx: AgentContext, emit: AgentEmit): Promise<AgentOutput> {
    const material = ctx.picks.material ?? "6061-T6 aluminum";
    const dimensionsMm = { x: PLATE_EDGE_MM, y: PLATE_EDGE_MM, z: PLATE_THICKNESS_MM };
    const base = `stub://design-graph/${ctx.runId}/plate-101.6mm`;
    emit({ type: "status", state: "info", message: `Modeling ${PLATE_EDGE_MM} mm square plate in ${material}` });
    emit({ type: "artifact", kind: "step", name: "plate-101.6mm.step", mimeType: "model/step", uri: `${base}.step`, dimensionsMm });
    emit({ type: "artifact", kind: "glb", name: "plate-101.6mm.glb", mimeType: "model/gltf-binary", uri: `${base}.glb`, dimensionsMm });
    emit({ type: "artifact", kind: "png", name: "plate-101.6mm.png", mimeType: "image/png", uri: `${base}.png` });
    return { summary: `4-inch (${PLATE_EDGE_MM} mm) square plate, ${PLATE_THICKNESS_MM} mm thick, ${material}` };
  }
}

export interface DefaultRegistryOptions {
  // Read for JARVIS_CAD_AGENT_ENABLED and the worker's JARVIS_DEMO_* settings.
  env?: Env;
  cadRunner?: CadWorkerRunner;
}

// cad is the real build123d CadAgent only when JARVIS_CAD_AGENT_ENABLED=1; otherwise
// the slice-1 stub stays, so nothing reaches the worker by default.
export function createDefaultRegistry(options: DefaultRegistryOptions = {}): DomainAgentRegistry {
  const env = options.env ?? process.env;
  const cad = isCadAgentEnabled(env) ? new CadAgent({ env, enabled: true, runner: options.cadRunner }) : new StubCadAgent();
  return new DomainAgentRegistry()
    .register(new DisabledStubAgent("optics", [/\blens\b/i, /\boptic/i, /\bmirror\b/i, /\blaser\b/i]), { enabled: false })
    .register(new DisabledStubAgent("electronics", [/\bpcb\b/i, /\bcircuit\b/i, /\bresistor\b/i, /\bschematic\b/i]), {
      enabled: false,
    })
    .register(new DisabledStubAgent("analysis", [/\bfea\b/i, /\bstress analysis\b/i, /\bthermal analysis\b/i]), {
      enabled: false,
    })
    .register(cad, { enabled: true });
}
