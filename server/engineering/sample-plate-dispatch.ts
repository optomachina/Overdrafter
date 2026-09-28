import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";

export const RECIPE = "4 × 4 × ¼ in · 6061 Alloy · four ¼-20 UNC 2B through taps on a 3 × 3 in square · R½ in concentric corners";
export const HELPER_HASH = "92b01a5904901780745689dbd747a6611524bf5c37857606eb347cc19258087e";
export type Decision = { action: string; confidence: number; probability: number; model: string; inputTokens: number; outputTokens: number; elapsedMs: number; costUsd: number };
export type NativeResult = { checks: Record<string, boolean>; files: { name: string; bytes: number; sha256: string }[]; material: string; elapsedSeconds: number; documentsPreserved: boolean };
export type Run = { id: string; instruction: string; recipe: string; status: "interpreting" | "building" | "verifying" | "succeeded" | "denied" | "unknown"; message: string; decision?: Decision; result?: NativeResult; startedAt: string; finishedAt?: string };
export type Adapter = { interpret: (instruction: string) => Promise<Decision>; build: (id: string, progress: () => void) => Promise<NativeResult> };
const idPattern = /^[a-f0-9]{32}$/;
// The demo only admits explicit references to this displayed recipe. Numbers,
// modifications, extra clauses and arbitrary modeling requests require clarification.
export function admissibleInstruction(text: string) {
  return /^(?:please )?(?:build|make|create) (?:the |this |an? )?(?:approved )?sample plate(?: please)?[.!]?$/i.test(text.trim());
}
export function acceptedDecision(d: Decision) {
  return d.model === "jev-1.13.0" && d.action === "build_approved_sample_plate"
    && Number.isFinite(d.confidence) && d.confidence >= 0.8 && d.confidence <= 1
    && Number.isFinite(d.probability) && d.probability >= 0.95 && d.probability <= 1
    && Number.isInteger(d.inputTokens) && d.inputTokens >= 0 && Number.isInteger(d.outputTokens) && d.outputTokens >= 0
    && Number.isFinite(d.elapsedMs) && d.elapsedMs >= 0 && Number.isFinite(d.costUsd) && d.costUsd >= 0;
}
export function verifiedResult(result: NativeResult) {
  const required = ["dimensions", "material", "holes", "corners", "threadMetadata", "stepDimensions", "stepHoles", "stepCorners", "documentsPreserved"];
  return result.documentsPreserved === true && required.every(k => result.checks[k] === true)
    && result.material === "6061 Alloy" && Number.isFinite(result.elapsedSeconds) && result.elapsedSeconds > 0
    && result.files.length === 2 && ["plate.SLDPRT", "plate.STEP"].every(name => result.files.some(f => f.name === name && f.bytes > 0 && /^[a-f0-9]{64}$/.test(f.sha256)));
}
function append(file: string, value: unknown) {
  const fd = openSync(file, "a");
  try { writeSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
}
export class PlateDispatcher {
  private runs = new Map<string, Run>();
  private readonly journal: string;
  private readonly lock: string;
  constructor(readonly root: string, private readonly adapter: Adapter, readonly binding: Record<string, string>) {
    mkdirSync(root, { recursive: true });
    this.journal = path.join(root, "attempts.jsonl"); this.lock = path.join(root, "native-attempt.lock");
    if (existsSync(this.journal)) {
      for (const line of readFileSync(this.journal, "utf8").trim().split("\n").filter(Boolean)) {
        const record = JSON.parse(line) as { run: Run };
        if (!record.run || !idPattern.test(record.run.id)) throw new Error("Invalid attempt journal; recovery required");
        this.runs.set(record.run.id, record.run);
      }
      for (const run of this.runs.values()) {
        if (["interpreting", "building", "verifying"].includes(run.status)) {
          run.status = "unknown"; run.message = "Server interrupted. Inspect the retained receipt and files; no automatic retry.";
          this.persist(run);
        }
      }
    }
  }
  private persist(run: Run) { append(this.journal, { at: new Date().toISOString(), binding: this.binding, run }); }
  list() { return [...this.runs.values()].map(r => structuredClone(r)); }
  get(id: string) { const r = this.runs.get(id); return r ? structuredClone(r) : undefined; }
  start(id: string, instruction: string) {
    if (!idPattern.test(id) || typeof instruction !== "string" || instruction.length > 300 || !instruction.trim()) throw new Error("Invalid request");
    const prior = this.runs.get(id);
    if (prior) {
      if (prior.instruction !== instruction.trim()) throw new Error("Request ID already belongs to another instruction");
      return this.get(id)!;
    }
    if ([...this.runs.values()].some(r => ["interpreting", "building", "verifying"].includes(r.status))) throw new Error("A request is already running");
    if (existsSync(this.lock)) throw new Error("The one native attempt is already reserved. Inspect its receipt; do not retry.");
    const run: Run = { id, instruction: instruction.trim(), recipe: RECIPE, status: "interpreting", message: "Jev is checking your instruction.", startedAt: new Date().toISOString() };
    this.persist(run); this.runs.set(id, run);
    void this.execute(run);
    return this.get(id)!;
  }
  private async execute(run: Run) {
    try {
      const decision = await this.adapter.interpret(run.instruction); run.decision = decision;
      if (!admissibleInstruction(run.instruction) || !acceptedDecision(decision)) {
        run.status = "denied"; run.message = "No CAD changes. Ask to build the sample plate exactly as shown; ambiguous or changed recipes are unsupported.";
      } else {
        // Permanent single-attempt reservation shared across server processes. Never
        // remove on timeout/error/restart: absence of a reply is not absence of effects.
        const fd = openSync(this.lock, "wx");
        try { writeSync(fd, JSON.stringify({ id: run.id, recipe: RECIPE, binding: this.binding })); fsyncSync(fd); } finally { closeSync(fd); }
        run.status = "building"; run.message = "Building one new plate in the existing SolidWorks session."; this.persist(run);
        const result = await this.adapter.build(run.id, () => { run.status = "verifying"; run.message = "Inspecting the saved native part and STEP independently."; this.persist(run); });
        if (!verifiedResult(result)) throw new Error("Independent verification did not pass");
        run.result = result; run.status = "succeeded"; run.message = "Plate built. Every native and STEP check passed.";
      }
    } catch {
      run.status = "unknown"; run.message = "Execution could not be confirmed. No automatic retry. Inspect the run receipt and SolidWorks before recovery.";
    }
    run.finishedAt = new Date().toISOString(); this.persist(run);
  }
}
export function newCapability() { return randomBytes(32).toString("hex"); }
export function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }
