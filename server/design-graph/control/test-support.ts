// Shared fixtures for the control tests. Not exported from the package entry.
import { DesignGraph } from "../graph";
import { DomainAgentRegistry, PLATE_EDGE_MM, PLATE_THICKNESS_MM, type AgentContext, type AgentEmit, type DomainAgent } from "../agents";
import type { DesignGraphEvent } from "../events";
import type { ControlActor } from "./commands";
import { InMemoryControlCommandStore } from "./store";

export const OWNER: ControlActor = { userId: "owner-1", isAdmin: false, aal: "aal1" };
export const STRANGER: ControlActor = { userId: "user-2", isAdmin: false, aal: "aal1" };
export const STRANGER_AAL2: ControlActor = { userId: "user-2", isAdmin: false, aal: "aal2" };
export const ADMIN_AAL1: ControlActor = { userId: "admin-1", isAdmin: true, aal: "aal1" };
export const ADMIN_AAL2: ControlActor = { userId: "admin-1", isAdmin: true, aal: "aal2" };

// Names the material so the run asks no concept question.
export const PLATE_PROMPT = "Make me a 4-inch aluminum mounting plate";

export function setup(registry?: DomainAgentRegistry) {
  let n = 0;
  let time = 0;
  const store = new InMemoryControlCommandStore();
  const graph = new DesignGraph({
    registry,
    controlStore: store,
    createRunId: () => `run-${++n}`,
    // A clock that ticks once per read keeps event times ordered without real waits.
    clock: { now: () => time++, setTimeout: () => 0, clearTimeout: () => {} },
  });
  return { graph, store };
}

export const singleAgent = (agent: DomainAgent) => new DomainAgentRegistry().register(agent, { enabled: true });

export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function waitUntil(predicate: () => boolean, label = "condition"): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(`timed out waiting for ${label}`);
}

export const types = (events: DesignGraphEvent[]) => events.map((e) => e.type);
export const controlEvents = (events: DesignGraphEvent[]) => events.filter((e) => e.type.startsWith("control_"));
export const artifactKinds = (events: DesignGraphEvent[]) =>
  events.flatMap((e) => (e.type === "artifact" ? [e.kind] : []));

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const dims = { x: PLATE_EDGE_MM, y: PLATE_EDGE_MM, z: PLATE_THICKNESS_MM };

// Emits step, then holds until `gate` opens, then glb and png, with a checkpoint
// between each artifact. Lets a test issue commands while the CAD node is running.
export class GatedCadAgent implements DomainAgent {
  readonly id = "cad" as const;
  readonly gate = deferred();

  canHandle() {
    return true;
  }

  async run(ctx: AgentContext, emit: AgentEmit) {
    const base = `stub://gated/${ctx.runId}/plate`;
    emit({ type: "artifact", kind: "step", name: "plate.step", mimeType: "model/step", uri: `${base}.step`, dimensionsMm: dims });
    await this.gate.promise;
    await ctx.checkpoint();
    emit({ type: "artifact", kind: "glb", name: "plate.glb", mimeType: "model/gltf-binary", uri: `${base}.glb`, dimensionsMm: dims });
    await ctx.checkpoint();
    emit({ type: "artifact", kind: "png", name: "plate.png", mimeType: "image/png", uri: `${base}.png` });
    return { summary: "gated plate" };
  }
}

// A minimal but structurally complete AP214 file for the 4-inch plate, one line per record.
export function plateStepLines(runId: string): string[] {
  return [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('Overdrafter 4-inch plate'),'2;1');",
    `FILE_NAME('plate-101.6mm.step','2026-10-15T00:00:00',('Overdrafter'),(''),'design-graph','${runId}','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    "ENDSEC;",
    "DATA;",
    "#1=CARTESIAN_POINT('',(0.,0.,0.));",
    `#2=CARTESIAN_POINT('',(${PLATE_EDGE_MM},${PLATE_EDGE_MM},${PLATE_THICKNESS_MM}));`,
    "#3=DIRECTION('',(0.,0.,1.));",
    "#4=DIRECTION('',(1.,0.,0.));",
    "#5=AXIS2_PLACEMENT_3D('',#1,#3,#4);",
    "#6=PRODUCT('plate','4-inch plate','',());",
    "ENDSEC;",
    "END-ISO-10303-21;",
  ];
}

// Writes the STEP file a few lines at a time, yielding the event loop between chunks
// with no checkpoint inside the write. It calls ctx.checkpoint() only once the file is
// whole, then would go on to write a GLB.
export class StepWriterAgent implements DomainAgent {
  readonly id = "cad" as const;
  readonly files = new Map<string, string>();
  readonly onChunk: (index: number, ctx: AgentContext) => void;

  constructor(onChunk: (index: number, ctx: AgentContext) => void) {
    this.onChunk = onChunk;
  }

  canHandle() {
    return true;
  }

  async run(ctx: AgentContext, emit: AgentEmit) {
    const stepUri = `mem://${ctx.runId}/plate.step`;
    const lines = plateStepLines(ctx.runId);
    this.files.set(stepUri, "");
    for (let i = 0; i < lines.length; i += 3) {
      this.files.set(stepUri, this.files.get(stepUri) + lines.slice(i, i + 3).join("\n") + "\n");
      this.onChunk(i / 3, ctx);
      await flush();
    }
    emit({ type: "artifact", kind: "step", name: "plate.step", mimeType: "model/step", uri: stepUri, dimensionsMm: dims });
    await ctx.checkpoint();
    const glbUri = `mem://${ctx.runId}/plate.glb`;
    this.files.set(glbUri, "glTF");
    emit({ type: "artifact", kind: "glb", name: "plate.glb", mimeType: "model/gltf-binary", uri: glbUri, dimensionsMm: dims });
    return { summary: "plate written" };
  }
}
