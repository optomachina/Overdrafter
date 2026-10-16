import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentContext, AgentEmit, AgentOutput, DecisionSpec, DesignRequest, DomainAgent } from "./agents";
import type { ArtifactDimensionsMm } from "./events";

// OVD-802 CAD agent: runs the OVD-765 CAD-neutral build123d worker
// (scripts/jarvis-demo) through its file queue. Off unless JARVIS_CAD_AGENT_ENABLED=1.
// No SolidWorks, no hosted service: the worker writes local files only.

export const CAD_AGENT_FLAG = "JARVIS_CAD_AGENT_ENABLED";

export type Env = Record<string, string | undefined>;

export const isCadAgentEnabled = (env: Env = process.env) => env[CAD_AGENT_FLAG] === "1";

const MM_PER_INCH = 25.4;
export const CAD_PLATE_EDGE_MM = 101.6; // 4.000 in
// Under 0.5 mm is foil rather than a machinable plate; over 50 mm is a block.
// The worker (jarvis-demo.mjs and plate.py) enforces the same range.
export const CAD_PLATE_THICKNESS_MIN_MM = 0.5;
export const CAD_PLATE_THICKNESS_MAX_MM = 50;
export const CAD_BBOX_TOLERANCE_MM = 0.01;

export type PlateHolePattern = "none" | "four_corner_m5" | "four_corner_1_4_20";

export interface PlateJobParams {
  recipe: "plate";
  edgeMm: number;
  thicknessMm: number;
  holePattern: PlateHolePattern;
  material: string;
}

// The subset of the worker's runs/<id>/result.json the agent relies on.
export interface PlateWorkerResult {
  stepBboxMm: ArtifactDimensionsMm;
  allChecksPass: boolean;
  checks: { check: string; pass: boolean; detail: string }[];
  files: { step: string; glb: string; iso: string; top: string };
}

export interface PlateWorkerOutcome {
  ok: boolean;
  state: string;
  id?: string;
  runDir?: string;
  reason?: string;
  result?: PlateWorkerResult;
}

// Files the job in the queue, claims it with the queue's atomic rename, runs it.
export type CadWorkerRunner = (params: PlateJobParams) => Promise<PlateWorkerOutcome>;

const THICKNESS_OPTIONS: [label: string, mm: number][] = [
  ["0.125 in (3.175 mm)", 3.175],
  ["0.25 in (6.35 mm)", 6.35],
  ["0.375 in (9.525 mm)", 9.525],
  ["0.5 in (12.7 mm)", 12.7],
];
const HOLE_OPTIONS: [label: string, pattern: PlateHolePattern][] = [
  ["No holes", "none"],
  ["4x corner M5 clearance (5.5 mm, 12.7 mm from edges)", "four_corner_m5"],
  ["4x corner 1/4-20 clearance (6.6 mm, 12.7 mm from edges)", "four_corner_1_4_20"],
];
const BEST_THICKNESS = THICKNESS_OPTIONS[1][0];
const BEST_HOLES = HOLE_OPTIONS[0][0];
const DEFAULT_MATERIAL = "6061-T6 aluminum";

const NUMBER = String.raw`(-?\d+(?:\.\d+)?|\d+\/\d+)`;
const UNIT = String.raw`(mm|millimet(?:er|re)s?|inch(?:es)?|in\b|")`;
const THICKNESS_PATTERNS = [
  new RegExp(String.raw`${NUMBER}\s*-?\s*${UNIT}\s*-?\s*thick`, "i"),
  new RegExp(String.raw`thick(?:ness)?\s*(?:of|:|=)?\s*${NUMBER}\s*${UNIT}`, "i"),
];
const SIZE_PATTERNS = [
  new RegExp(String.raw`${NUMBER}\s*-?\s*${UNIT}\s+(?:square\s+)?(?:\w+\s+)?plate\b`, "gi"),
  new RegExp(String.raw`${NUMBER}\s*${UNIT}?\s*(?:x|×|by)\s*${NUMBER}\s*${UNIT}?`, "gi"),
];

function toMm(value: string, unit: string | undefined): number {
  const [num, den] = value.split("/");
  const n = den === undefined ? Number(num) : Number(num) / Number(den);
  return unit && /^(in|inch|")/i.test(unit) ? n * MM_PER_INCH : n;
}

export function parseThicknessMm(prompt: string): number | undefined {
  for (const pattern of THICKNESS_PATTERNS) {
    const match = prompt.match(pattern);
    if (match) return toMm(match[1], match[2]);
  }
  return undefined;
}

// The recipe is a fixed 4.000 in square; a request naming another plate size is refused
// rather than silently built at 4 in.
export function findWrongPlateSize(prompt: string): string | undefined {
  const withoutThickness = THICKNESS_PATTERNS.reduce((text, pattern) => text.replace(pattern, " "), prompt);
  for (const pattern of SIZE_PATTERNS) {
    for (const match of withoutThickness.matchAll(pattern)) {
      const units = pattern === SIZE_PATTERNS[0] ? [match[2]] : [match[2] ?? match[4], match[4] ?? match[2]];
      const sizes = pattern === SIZE_PATTERNS[0] ? [match[1]] : [match[1], match[3]];
      if (sizes.some((size, i) => Math.abs(toMm(size, units[i] ?? "in") - CAD_PLATE_EDGE_MM) > CAD_BBOX_TOLERANCE_MM)) {
        return match[0].trim();
      }
    }
  }
  return undefined;
}

export function parseHolePattern(prompt: string): PlateHolePattern | undefined {
  if (/\b(?:no|without)\s+(?:\w+\s+)?holes\b|\bhole-?less\b|\bblank\b/i.test(prompt)) return "none";
  if (/\bm5\b/i.test(prompt)) return "four_corner_m5";
  if (/\b1\/4-20\b|\bquarter-20\b/i.test(prompt)) return "four_corner_1_4_20";
  return undefined;
}

export function parseMaterial(prompt: string): string {
  if (/stainless|\b304\b/i.test(prompt)) return "304 stainless steel";
  if (/acetal|delrin/i.test(prompt)) return "acetal (Delrin)";
  return DEFAULT_MATERIAL;
}

export function defaultJarvisDemoScript(): string {
  return fileURLToPath(new URL("../../scripts/jarvis-demo/jarvis-demo.mjs", import.meta.url));
}

// Default runner: `node jarvis-demo.mjs plate <params>` files the job in
// $JARVIS_DEMO_ROOT/queue/pending, claims it by id (atomic rename) and runs plate.py
// with $JARVIS_DEMO_PYTHON. The CAD flag is the gate here, so the child gets the
// demo flag it needs.
export function createJarvisWorkerRunner(options: { env?: Env; script?: string; timeoutMs?: number } = {}): CadWorkerRunner {
  const env = options.env ?? process.env;
  const script = options.script ?? defaultJarvisDemoScript();
  const timeoutMs = options.timeoutMs ?? 300_000;
  return (params) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [script, "plate", JSON.stringify(params)], {
        env: {
          ...process.env,
          ...env,
          JARVIS_DEMO_ENABLED: "1",
          JARVIS_DEMO_ROOT: env.JARVIS_DEMO_ROOT ?? path.join(homedir(), "overnight", "jarvis"),
          JARVIS_DEMO_SOURCE: "design-graph",
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", (error) => resolve({ ok: false, state: "failed", reason: error.message }));
      child.on("close", (code) => {
        try {
          resolve(JSON.parse(stdout) as PlateWorkerOutcome);
        } catch {
          resolve({ ok: false, state: "failed", reason: `worker exited ${code}: ${stderr.trim().slice(-500) || "no output"}` });
        }
      });
    });
}

function refusal(prompt: string): string | undefined {
  const wrongSize = findWrongPlateSize(prompt);
  if (wrongSize) return `this recipe builds only a 4.000 in (${CAD_PLATE_EDGE_MM} mm) square plate, got "${wrongSize}"`;
  const thicknessMm = parseThicknessMm(prompt);
  if (thicknessMm !== undefined && !(thicknessMm >= CAD_PLATE_THICKNESS_MIN_MM && thicknessMm <= CAD_PLATE_THICKNESS_MAX_MM)) {
    return `plate thickness must be ${CAD_PLATE_THICKNESS_MIN_MM} to ${CAD_PLATE_THICKNESS_MAX_MM} mm, got ${Number(thicknessMm.toFixed(4))} mm`;
  }
  return undefined;
}

const optionValue = <T>(options: [string, T][], label: string | undefined): T | undefined =>
  options.find(([option]) => option === label)?.[1];

export interface CadAgentOptions {
  env?: Env;
  // Defaults to the flag in env.
  enabled?: boolean;
  runner?: CadWorkerRunner;
}

export class CadAgent implements DomainAgent {
  readonly id = "cad" as const;
  private readonly enabled: boolean;
  private readonly runner: CadWorkerRunner;

  constructor(options: CadAgentOptions = {}) {
    const env = options.env ?? process.env;
    this.enabled = options.enabled ?? isCadAgentEnabled(env);
    this.runner = options.runner ?? createJarvisWorkerRunner({ env });
  }

  canHandle(request: DesignRequest): boolean {
    return /\bplate\b/i.test(request.prompt);
  }

  conceptPicks(request: DesignRequest): DecisionSpec[] {
    // A request run() will refuse asks nothing, so the refusal is not held behind a question.
    if (refusal(request.prompt)) return [];
    const picks: DecisionSpec[] = [];
    if (parseThicknessMm(request.prompt) === undefined) {
      picks.push({
        key: "thickness",
        question: "How thick should the 4 inch plate be?",
        options: THICKNESS_OPTIONS.map(([label]) => label),
        recommended: BEST_THICKNESS,
        bestGuess: BEST_THICKNESS,
        bestGuessRationale: "0.25 in 6061 is stock plate, stiff enough for a 4 inch mounting plate and cheap to machine.",
      });
    }
    if (parseHolePattern(request.prompt) === undefined) {
      picks.push({
        key: "holePattern",
        question: "Which hole pattern should the plate have?",
        options: HOLE_OPTIONS.map(([label]) => label),
        recommended: BEST_HOLES,
        bestGuess: BEST_HOLES,
        bestGuessRationale: "A blank plate is the safe default; holes can be added once the mating part is known.",
      });
    }
    return picks;
  }

  async run(ctx: AgentContext, emit: AgentEmit): Promise<AgentOutput> {
    if (!this.enabled) throw new Error(`CAD agent is off; set ${CAD_AGENT_FLAG}=1 to run the build123d worker`);
    const params = this.plan(ctx);
    const { thicknessMm, holePattern, material } = params;
    emit({ type: "status", state: "info", message: `Filing plate job: ${CAD_PLATE_EDGE_MM} x ${CAD_PLATE_EDGE_MM} x ${thicknessMm} mm, ${holePattern} holes, ${material}` });

    const outcome = await this.runner(params);
    const result = outcome.result;
    if (!outcome.ok || !result || !outcome.runDir) {
      const failed = result?.checks.filter((check) => !check.pass).map((check) => check.check) ?? [];
      throw new Error(`worker ${outcome.state}${outcome.reason ? `: ${outcome.reason}` : ""}${failed.length ? `; failed checks: ${failed.join(", ")}` : ""}`);
    }
    const measured = result.stepBboxMm;
    const expected = { x: CAD_PLATE_EDGE_MM, y: CAD_PLATE_EDGE_MM, z: thicknessMm };
    const worst = Math.max(...(["x", "y", "z"] as const).map((axis) => Math.abs(measured[axis] - expected[axis])));
    if (!result.allChecksPass || worst > CAD_BBOX_TOLERANCE_MM) {
      throw new Error(`worker output failed verification (bbox deviation ${worst.toFixed(4)} mm)`);
    }

    const uri = (file: string) => pathToFileURL(path.join(outcome.runDir as string, file)).href;
    const dimensionsMm = { ...measured };
    emit({ type: "status", state: "info", message: `Worker ${outcome.id} verified: STEP measures ${measured.x} x ${measured.y} x ${measured.z} mm` });
    emit({ type: "artifact", kind: "step", name: result.files.step, mimeType: "model/step", uri: uri(result.files.step), dimensionsMm });
    emit({ type: "artifact", kind: "glb", name: result.files.glb, mimeType: "model/gltf-binary", uri: uri(result.files.glb), dimensionsMm });
    emit({ type: "artifact", kind: "png", name: result.files.iso, mimeType: "image/png", uri: uri(result.files.iso) });
    emit({ type: "artifact", kind: "png", name: result.files.top, mimeType: "image/png", uri: uri(result.files.top) });
    return {
      summary: `4.000 in (${CAD_PLATE_EDGE_MM} mm) square plate, ${thicknessMm} mm thick, ${holePattern} holes, ${material}; STEP measures ${measured.x} x ${measured.y} x ${measured.z} mm`,
    };
  }

  // Validates before anything is filed, so a refused request never reaches the queue.
  private plan(ctx: AgentContext): PlateJobParams {
    const prompt = ctx.request.prompt;
    const refused = refusal(prompt);
    if (refused) throw new Error(refused);
    const thicknessMm = parseThicknessMm(prompt) ?? optionValue(THICKNESS_OPTIONS, ctx.picks.thickness) ?? THICKNESS_OPTIONS[1][1];
    return {
      recipe: "plate",
      edgeMm: CAD_PLATE_EDGE_MM,
      thicknessMm: Number(thicknessMm.toFixed(4)),
      holePattern: parseHolePattern(prompt) ?? optionValue(HOLE_OPTIONS, ctx.picks.holePattern) ?? "none",
      material: parseMaterial(prompt),
    };
  }
}
