// @vitest-environment node
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CadAgent,
  DesignGraph,
  DomainAgentRegistry,
  StubCadAgent,
  createDefaultRegistry,
  createJarvisWorkerRunner,
  validateDesignGraphEvent,
  type CadWorkerRunner,
  type DesignGraphEvent,
  type PlateJobParams,
  type PlateWorkerOutcome,
} from "./index";

// Real-worker tests need a Python with build123d (CI has none), so they skip cleanly
// unless JARVIS_DEMO_PYTHON is set. Everything else is hermetic.
const PYTHON = process.env.JARVIS_DEMO_PYTHON;
const realIt = it.skipIf(!PYTHON);
const REAL_TIMEOUT_MS = 180_000;
const GLB_CHECK = fileURLToPath(new URL("../../scripts/jarvis-demo/glb_check.py", import.meta.url));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "ovd-802-"));
  roots.push(root);
  return root;
}

function realEnv(root: string) {
  return { JARVIS_CAD_AGENT_ENABLED: "1", JARVIS_DEMO_ROOT: root, JARVIS_DEMO_PYTHON: PYTHON };
}

function graphWith(registry: DomainAgentRegistry) {
  let n = 0;
  return new DesignGraph({ registry, createRunId: () => `run-${++n}` });
}

function fakeOutcome(params: PlateJobParams): PlateWorkerOutcome {
  return {
    ok: true,
    state: "verified",
    id: "jd-fake",
    runDir: "/tmp/jd-fake",
    result: {
      stepBboxMm: { x: params.edgeMm, y: params.edgeMm, z: params.thicknessMm },
      allChecksPass: true,
      checks: [],
      files: { step: "plate.step", glb: "plate.glb", iso: "plate-iso.png", top: "plate-top.png" },
    },
  };
}

const plateParams = (): PlateJobParams => ({ recipe: "plate", edgeMm: 101.6, thicknessMm: 6.35, holePattern: "none", material: "6061-T6 aluminum" });

function cadOnly(agent: CadAgent) {
  return new DomainAgentRegistry().register(agent, { enabled: true });
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const artifactsOf = (events: DesignGraphEvent[]) => events.flatMap((e) => (e.type === "artifact" ? [e] : []));
const fileOf = (uri: string) => fileURLToPath(uri);

function measureStep(stepPath: string) {
  const code = [
    "import json, sys",
    "from build123d import import_step",
    "shape = import_step(sys.argv[1])",
    "size = shape.bounding_box().size",
    "print(json.dumps({'x': size.X, 'y': size.Y, 'z': size.Z, 'solids': len(shape.solids()), 'valid': shape.is_valid}))",
  ].join("\n");
  const run = spawnSync(PYTHON as string, ["-c", code, stepPath], { encoding: "utf8", cwd: tmpdir() });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as { x: number; y: number; z: number; solids: number; valid: boolean };
}

function runGlbCheck(root: string, glbPath: string) {
  const env = { ...process.env, JARVIS_DEMO_ROOT: root, PYTHONDONTWRITEBYTECODE: "1" };
  return spawnSync(PYTHON as string, [GLB_CHECK, glbPath], { encoding: "utf8", cwd: tmpdir(), env });
}

function checkGlb(root: string, glbPath: string) {
  const run = runGlbCheck(root, glbPath);
  return { status: run.status, report: JSON.parse(run.stdout) as Record<string, number | boolean> };
}

// Minimal non-indexed GLB writer for negative/positive controls of the watertight check.
function writeGlb(file: string, triangles: number[][][]) {
  const positions = new Float32Array(triangles.flat(2));
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: positions.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: "VEC3" }],
  };
  let text = JSON.stringify(json);
  while (text.length % 4) text += " ";
  const jsonChunk = Buffer.from(text, "utf8");
  const bin = Buffer.from(positions.buffer);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + bin.length, 8);
  const chunkHeader = (length: number, type: number) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(length, 0);
    b.writeUInt32LE(type, 4);
    return b;
  };
  writeFileSync(file, Buffer.concat([header, chunkHeader(jsonChunk.length, 0x4e4f534a), jsonChunk, chunkHeader(bin.length, 0x004e4942), bin]));
}

describe("OVD-802 CadAgent plate recipe", () => {
  it.each([undefined, null, "", "plate.usdz"])("publishes only supplied AR artifacts (%s) and preserves measured dimensions", async (usdz) => {
    const runner: CadWorkerRunner = async (params) => {
      const outcome = fakeOutcome(params);
      if (usdz !== undefined) outcome.result!.files.usdz = usdz;
      return outcome;
    };
    const graph = graphWith(cadOnly(new CadAgent({ env: { JARVIS_CAD_AGENT_ENABLED: "1" }, runner })));
    const runId = graph.submit({ prompt: "4 inch square plate, 0.25 in thick, no holes" });
    expect(await graph.waitForTerminal(runId)).toMatchObject({ state: "completed" });
    const events = graph.getEvents(runId);
    const artifacts = artifactsOf(events);
    expect(artifacts.map((a) => a.kind)).toEqual(usdz ? ["step", "glb", "usdz", "png", "png"] : ["step", "glb", "png", "png"]);
    for (const artifact of artifacts.filter((a) => a.kind === "glb" || a.kind === "usdz")) {
      expect(artifact.dimensionsMm).toEqual({ x: 101.6, y: 101.6, z: 6.35 });
      expect(validateDesignGraphEvent(artifact).ok).toBe(true);
    }
    if (usdz) expect(artifacts.find((a) => a.kind === "usdz")).toMatchObject({ mimeType: "model/vnd.usdz+zip", uri: "file:///tmp/jd-fake/plate.usdz" });
    expect(events.at(-1)).toMatchObject({ type: "result", artifacts: artifacts.map(({ kind, uri }) => ({ kind, uri })) });
  });

  it.each(["step", "glb", "usdz", "iso", "top"] as const)("rejects unsafe %s artifact names without emitting artifacts", async (kind) => {
    for (const file of ["../other/x.usdz", "/etc/passwd", "sub/plate.glb", ".", "..", ...(kind === "usdz" ? [] : [""])]) {
      const runner: CadWorkerRunner = async (params) => {
        const outcome = fakeOutcome(params);
        outcome.result!.files[kind] = file;
        return outcome;
      };
      const graph = graphWith(cadOnly(new CadAgent({ enabled: true, runner })));
      const runId = graph.submit({ prompt: "4 inch square plate, 0.25 in thick, no holes" });
      expect(await graph.waitForTerminal(runId)).toMatchObject({ state: "failed" });
      const events = graph.getEvents(runId);
      expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("artifact file must stay inside the run folder") });
      expect(artifactsOf(events)).toEqual([]);
    }
  });

  realIt(
    "P-1 '4 inch square plate' produces a 101.6 x 101.6 mm solid within 0.01 mm, measured from the STEP",
    async () => {
      const graph = graphWith(createDefaultRegistry({ env: realEnv(tempRoot()) }));
      const runId = graph.submit({ prompt: "4 inch square plate, 0.25 in thick, no holes" });
      const snapshot = await graph.waitForTerminal(runId);
      const events = graph.getEvents(runId);
      expect(snapshot.state, JSON.stringify(events.at(-1))).toBe("completed");
      expect(events.map((e) => e.type)).not.toContain("decision_requested");

      const step = artifactsOf(events).find((a) => a.kind === "step");
      expect(step?.uri).toMatch(/^file:\/\/.*\/plate\.step$/);
      const measured = measureStep(fileOf(step!.uri));
      console.log(`P-1 measured STEP bbox (mm): x=${measured.x} y=${measured.y} z=${measured.z} solids=${measured.solids}`);
      expect(Math.abs(measured.x - 101.6)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(measured.y - 101.6)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(measured.z - 6.35)).toBeLessThanOrEqual(0.01);
      expect(step!.dimensionsMm!.x).toBeCloseTo(101.6, 2);
      expect(step!.dimensionsMm!.y).toBeCloseTo(101.6, 2);
      expect(events.at(-1)).toMatchObject({ type: "result", agentId: "cad" });
    },
    REAL_TIMEOUT_MS,
  );

  realIt(
    "P-2 both decisions skipped -> best guesses recorded with rationale and artifacts produced",
    async () => {
      const graph = graphWith(createDefaultRegistry({ env: realEnv(tempRoot()) }));
      const runId = graph.submit({ prompt: "Make me a 4 inch square plate" });
      for (const key of ["thickness", "holePattern"]) {
        const requested = await waitFor(() =>
          graph.getEvents(runId).find((e) => e.type === "decision_requested" && e.decisionId === `${runId}:${key}`),
        );
        expect(graph.resolveDecision(runId, requested.type === "decision_requested" ? requested.decisionId : "", { kind: "skip" })).toEqual({ ok: true });
      }
      const snapshot = await graph.waitForTerminal(runId);
      const events = graph.getEvents(runId);
      for (const event of events) expect(validateDesignGraphEvent(event).ok).toBe(true);
      expect(snapshot.state, JSON.stringify(events.at(-1))).toBe("completed");

      const resolved = events.filter((e) => e.type === "decision_resolved");
      expect(resolved).toHaveLength(2);
      expect(resolved).toEqual([
        expect.objectContaining({ outcome: "skipped_best_guess", cause: "skip", choice: "0.25 in (6.35 mm)" }),
        expect.objectContaining({ outcome: "skipped_best_guess", cause: "skip", choice: "No holes" }),
      ]);
      for (const r of resolved) expect(r.type === "decision_resolved" && r.rationale).toMatch(/User skipped; proceeding with best guess/);
      expect(snapshot.picks).toEqual({ thickness: "0.25 in (6.35 mm)", holePattern: "No holes" });
      expect(events.at(-1)).toMatchObject({ type: "result", picks: snapshot.picks });

      const artifacts = artifactsOf(events);
      expect(artifacts.map((a) => `${a.kind}:${a.name}`)).toEqual(["step:plate.step", "glb:plate.glb", "png:plate-iso.png", "png:plate-top.png"]);
      const magic = { step: "ISO-10303-21", glb: "glTF", png: "\x89PNG", usdz: "PK\x03\x04" };
      for (const a of artifacts) {
        const head = readFileSync(fileOf(a.uri)).subarray(0, 12).toString("latin1");
        expect(head.startsWith(magic[a.kind]), a.name).toBe(true);
      }
      const result = JSON.parse(readFileSync(path.join(path.dirname(fileOf(artifacts[0].uri)), "result.json"), "utf8"));
      expect(result.params).toMatchObject({ thicknessMm: 6.35, holePattern: "none", material: "6061-T6 aluminum" });
      console.log(`P-2 best guesses: ${JSON.stringify(snapshot.picks)}; STEP bbox (mm): ${JSON.stringify(result.stepBboxMm)}`);
    },
    REAL_TIMEOUT_MS,
  );

  realIt(
    "P-3 exactly one valid solid and a watertight GLB (every edge shared by exactly two triangles)",
    async () => {
      const root = tempRoot();
      const graph = graphWith(createDefaultRegistry({ env: realEnv(root) }));
      const runId = graph.submit({ prompt: "4 inch square plate, 0.25 in thick, with M5 corner holes" });
      const snapshot = await graph.waitForTerminal(runId);
      const events = graph.getEvents(runId);
      expect(snapshot.state, JSON.stringify(events.at(-1))).toBe("completed");
      const artifacts = artifactsOf(events);

      const measured = measureStep(fileOf(artifacts.find((a) => a.kind === "step")!.uri));
      expect(measured).toMatchObject({ solids: 1, valid: true });

      const { status, report } = checkGlb(root, fileOf(artifacts.find((a) => a.kind === "glb")!.uri));
      console.log(`P-3 STEP solids=${measured.solids} valid=${measured.valid}; GLB ${JSON.stringify(report)}`);
      expect(status).toBe(0);
      expect(report).toMatchObject({ watertight: true, edgesNotShared2: 0, degenerateTriangles: 0 });
      // Euler characteristic V - E + F = 2 - 2g; four through holes make genus 4.
      expect((report.vertices as number) - (report.edges as number) + (report.triangles as number)).toBe(2 - 2 * 4);

      // Controls: the checker rejects an open mesh and merges split vertices of a closed one.
      const controlRoot = tempRoot();
      const dir = path.join(controlRoot, "runs", "jd-controls");
      mkdirSync(dir, { recursive: true });
      const [a, b, c, d] = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
      writeGlb(path.join(dir, "open.glb"), [[a, b, c]]);
      expect(checkGlb(controlRoot, path.join(dir, "open.glb"))).toMatchObject({ status: 1, report: { watertight: false, edgesNotShared2: 3 } });
      writeGlb(path.join(dir, "tetra.glb"), [[a, c, b], [a, b, d], [a, d, c], [b, c, d]]);
      expect(checkGlb(controlRoot, path.join(dir, "tetra.glb"))).toMatchObject({ status: 0, report: { watertight: true, vertices: 4, edges: 6 } });
      // The checker reads only .glb files inside the runs dir.
      const outside = tempRoot();
      writeGlb(path.join(outside, "tetra.glb"), [[a, c, b], [a, b, d], [a, d, c], [b, c, d]]);
      for (const target of [path.join(outside, "tetra.glb"), path.join(dir, "..", "..", "..", path.basename(outside), "tetra.glb")]) {
        const refused = runGlbCheck(controlRoot, target);
        expect(refused.status).toBe(1);
        expect(refused.stderr).toMatch(/must be an existing \.glb file under/);
      }
    },
    REAL_TIMEOUT_MS,
  );

  it("P-4 out-of-range thickness is refused with an error event before any job is filed", async () => {
    const runner = vi.fn<CadWorkerRunner>(async (params) => fakeOutcome(params));
    const graph = graphWith(cadOnly(new CadAgent({ enabled: true, runner })));
    for (const prompt of ["4 inch square plate, 60 mm thick", "4 inch square plate 0.1 mm thick", "4 inch square plate, -3 mm thick", "4 inch square plate, 2 in thick"]) {
      const runId = graph.submit({ prompt });
      expect(await graph.waitForTerminal(runId), prompt).toMatchObject({ state: "failed" });
      const events = graph.getEvents(runId);
      expect(events.filter((e) => e.type === "error")).toHaveLength(1);
      // Refused up front: no question is asked first.
      expect(events.map((e) => e.type)).not.toContain("decision_requested");
      expect(events.at(-1)).toMatchObject({ type: "error", code: "agent_failed", nodeId: "domain_agent", agentId: "cad" });
      expect(events.at(-1)?.type === "error" && events.at(-1)).toMatchObject({ message: expect.stringMatching(/plate thickness must be 0\.5 to 50 mm/) });
      expect(artifactsOf(events)).toEqual([]);
    }
    // A plate size other than 4.000 in is refused rather than silently built at 4 in.
    const wrongSize = graph.submit({ prompt: "6 inch square plate, 0.25 in thick" });
    await graph.waitForTerminal(wrongSize);
    expect(graph.getEvents(wrongSize).at(-1)).toMatchObject({ type: "error", code: "agent_failed", message: expect.stringMatching(/only a 4\.000 in/) });
    // The prompt text is not echoed into the reason.
    expect(graph.getEvents(wrongSize).at(-1)).toMatchObject({ message: expect.not.stringContaining("6 inch") });
    expect(runner).not.toHaveBeenCalled();

    // The bounds themselves are accepted.
    for (const [prompt, mm] of [["4 inch square plate, 0.5 mm thick, no holes", 0.5], ["4 inch square plate, 50 mm thick, no holes", 50]] as const) {
      const runId = graph.submit({ prompt });
      expect(await graph.waitForTerminal(runId)).toMatchObject({ state: "completed" });
      expect(runner).toHaveBeenLastCalledWith(expect.objectContaining({ thicknessMm: mm }));
    }
  });

  it("P-6 flag off -> the CAD agent refuses with an error event and never reaches the worker", async () => {
    const runner = vi.fn<CadWorkerRunner>(async (params) => fakeOutcome(params));
    for (const flag of [undefined, "", "0", "true"]) {
      const graph = graphWith(cadOnly(new CadAgent({ env: { JARVIS_CAD_AGENT_ENABLED: flag }, runner })));
      const runId = graph.submit({ prompt: "4 inch square plate, 0.25 in thick, no holes" });
      expect(await graph.waitForTerminal(runId)).toMatchObject({ state: "failed" });
      const events = graph.getEvents(runId);
      expect(events.at(-1)).toMatchObject({
        type: "error",
        code: "agent_failed",
        agentId: "cad",
        message: "cad agent failed: CAD agent is off; set JARVIS_CAD_AGENT_ENABLED=1 to run the build123d worker",
      });
      expect(artifactsOf(events)).toEqual([]);
    }
    expect(runner).not.toHaveBeenCalled();

    // Default registry: flag off keeps the slice-1 stub (no worker); flag on swaps in CadAgent.
    const plate = { prompt: "4 inch square plate" };
    const off = createDefaultRegistry({ env: {} }).route(plate);
    const on = createDefaultRegistry({ env: { JARVIS_CAD_AGENT_ENABLED: "1" }, cadRunner: runner }).route(plate);
    expect(off.kind === "routed" && off.agent).toBeInstanceOf(StubCadAgent);
    expect(on.kind === "routed" && on.agent).toBeInstanceOf(CadAgent);

    // The default runner never runs with the flag off: nothing lands in the queue root.
    const root = tempRoot();
    const graph = graphWith(cadOnly(new CadAgent({ env: { JARVIS_DEMO_ROOT: root } })));
    const runId = graph.submit({ prompt: "4 inch square plate, 0.25 in thick, no holes" });
    expect(await graph.waitForTerminal(runId)).toMatchObject({ state: "failed" });
    expect(existsSync(path.join(root, "queue"))).toBe(false);
  });

  it("the default runner's Python timeout fires inside its outer timeout: no claim and no process outlives a timed-out job", async () => {
    const root = tempRoot();
    const mark = path.join(root, "mark");
    const fakePython = path.join(root, "slow-python.sh");
    writeFileSync(fakePython, `#!/usr/bin/env bash\n( sleep 1.5; touch "${mark}.grandchild" ) &\nsleep 1.5\ntouch "${mark}.child"\n`);
    chmodSync(fakePython, 0o755);
    const env = { JARVIS_CAD_AGENT_ENABLED: "1", JARVIS_DEMO_ROOT: root, JARVIS_DEMO_PYTHON: fakePython };
    const outcome = await createJarvisWorkerRunner({ env, workerTimeoutMs: 300 })(plateParams());
    // The inner (CLI) timeout reported, not the outer backstop, so the CLI's cleanup ran.
    expect(outcome).toMatchObject({ ok: false, state: "failed", reason: "worker timed out after 300 ms" });
    expect(readdirSync(path.join(root, "queue", "claimed"))).toEqual([]);
    expect(readdirSync(path.join(root, "queue", "failed"))).toEqual([`${outcome.id}.json`]);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(existsSync(`${mark}.child`) || existsSync(`${mark}.grandchild`)).toBe(false);
  }, 20_000);

  it("the default runner runs nothing with the CAD flag off, even when called directly", async () => {
    const root = tempRoot();
    for (const flag of [undefined, "", "0", "true"]) {
      const outcome = await createJarvisWorkerRunner({ env: { JARVIS_CAD_AGENT_ENABLED: flag, JARVIS_DEMO_ROOT: root } })(plateParams());
      expect(outcome).toEqual({ ok: false, state: "disabled", reason: "CAD agent is off; set JARVIS_CAD_AGENT_ENABLED=1 to run the build123d worker" });
    }
    expect(readdirSync(root)).toEqual([]);
  });
});
