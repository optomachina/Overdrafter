#!/usr/bin/env node
// Jarvis end to end demo (OVD-743 follow up): a phone reachable trigger files a
// design request into a local queue, and a worker claims it and runs the
// CAD-neutral assembly build. Demo only: behind JARVIS_DEMO_ENABLED=1, local
// files only, no hosted database, no SolidWorks, no provider calls.
//
//   node scripts/jarvis-demo/jarvis-demo.mjs request "<text>"   -> prints the request id
//   node scripts/jarvis-demo/jarvis-demo.mjs work [--id <id>]   -> runs that request, or the oldest pending one
//   node scripts/jarvis-demo/jarvis-demo.mjs status <id>
//   node scripts/jarvis-demo/jarvis-demo.mjs plate '<params json>'  -> files a plate job, claims it, runs it (OVD-802)
//
// JARVIS_DEMO_ROOT (default ~/overnight/jarvis) holds queue/ and runs/.
// JARVIS_DEMO_PYTHON points at a Python with build123d and matplotlib.
// JARVIS_DEMO_WORKER_TIMEOUT_MS (default 300000) bounds one Python run.
// Plate jobs also need JARVIS_CAD_AGENT_ENABLED=1 (OVD-802).

import { isEntryPoint } from "../lib/entry-point.mjs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PIN_MIN_MM = 4;
const PIN_MAX_MM = 20;
const DEFAULT_PIN_MM = 10;

export function parseDesignRequest(text) {
  const lower = String(text ?? "").toLowerCase();
  if (lower.length > 500) return { ok: false, reason: "request text is limited to 500 characters" };
  const missing = ["bracket", "plate", "pin"].filter((part) => !new RegExp(`\\b${part}s?\\b`).test(lower));
  if (missing.length > 0) {
    return { ok: false, reason: `this demo builds only a bracket + plate + pin assembly; missing: ${missing.join(", ")}` };
  }
  // Any number written next to "pin" is the diameter; only mm is accepted, so an
  // explicit "0.5 inch" or "-8 mm" is refused rather than silently replaced.
  const match = lower.match(/(-?\d+(?:\.\d+)?)\s*([a-z"]+)?\s+(?:diameter\s+)?pin\b|\bpin\s+(?:of\s+|diameter\s+|ø\s*)?(-?\d+(?:\.\d+)?)\s*([a-z"]+)?/);
  if (match && (match[2] ?? match[4]) !== "mm") {
    return { ok: false, reason: "give the pin diameter in mm" };
  }
  const pinDiameterMm = match ? Number(match[1] ?? match[3]) : DEFAULT_PIN_MM;
  if (!(pinDiameterMm >= PIN_MIN_MM && pinDiameterMm <= PIN_MAX_MM)) {
    return { ok: false, reason: `pin diameter must be ${PIN_MIN_MM} to ${PIN_MAX_MM} mm, got ${pinDiameterMm}` };
  }
  return { ok: true, params: { assembly: "plate-bracket-pin", pinDiameterMm, pinProtrusionMm: 6 } };
}

// Plate recipe (OVD-802): a fixed 4.000 in square; thickness and hole pattern vary.
// Under 0.5 mm is foil rather than a machinable plate; over 50 mm is a block.
export const PLATE_EDGE_MM = 101.6;
export const PLATE_THICKNESS_MIN_MM = 0.5;
export const PLATE_THICKNESS_MAX_MM = 50;
export const PLATE_HOLE_PATTERNS = ["none", "four_corner_m5", "four_corner_1_4_20"];
// Float comparison slack for the fixed edge; far below any machinable difference.
const PLATE_EDGE_EPSILON_MM = 1e-9;
// Reasons go to stdout, so only numbers are echoed back, never caller-supplied text.
const got = (value) => (Number.isFinite(value) ? `, got ${value}` : "");

export function validatePlateParams(params) {
  if (params?.recipe !== "plate") return { ok: false, reason: "recipe must be plate" };
  if (typeof params.edgeMm !== "number" || !(Math.abs(params.edgeMm - PLATE_EDGE_MM) <= PLATE_EDGE_EPSILON_MM)) {
    return { ok: false, reason: `this recipe builds only a ${PLATE_EDGE_MM} mm square plate${got(params.edgeMm)}` };
  }
  const t = params.thicknessMm;
  if (typeof t !== "number" || !(t >= PLATE_THICKNESS_MIN_MM && t <= PLATE_THICKNESS_MAX_MM)) {
    return { ok: false, reason: `plate thickness must be ${PLATE_THICKNESS_MIN_MM} to ${PLATE_THICKNESS_MAX_MM} mm${got(t)}` };
  }
  if (!PLATE_HOLE_PATTERNS.includes(params.holePattern)) {
    return { ok: false, reason: `hole pattern must be one of ${PLATE_HOLE_PATTERNS.join(", ")}` };
  }
  if (typeof params.material !== "string" || params.material.length === 0 || params.material.length > 100) {
    return { ok: false, reason: "material must be a short non-empty string" };
  }
  return { ok: true, params: { recipe: "plate", edgeMm: PLATE_EDGE_MM, thicknessMm: t, holePattern: params.holePattern, material: params.material } };
}

export function createRequest(root, text, source, now = new Date()) {
  const parsed = parseDesignRequest(text);
  if (!parsed.ok) return parsed;
  return fileRequest(root, text, source, parsed.params, now);
}

// queue "claimed" files the job already claimed, for a caller that runs it itself
// (the plate command), so a concurrent `work` can never take it first.
export function createPlateRequest(root, params, source, now = new Date(), queue = "pending") {
  const checked = validatePlateParams(params);
  if (!checked.ok) return checked;
  return fileRequest(root, `plate ${JSON.stringify(checked.params)}`, source, checked.params, now, queue);
}

function fileRequest(root, text, source, params, now, queue = "pending") {
  const id = `jd-${now.toISOString().replace(/[-:.]/g, "").slice(0, 18)}-${randomUUID().slice(0, 8)}`;
  const request = { id, createdAt: now.toISOString(), source, text, params, state: queue };
  const dir = join(root, "queue", queue);
  mkdirSync(dir, { recursive: true });
  // Write under a non-.json name, then rename, so a worker never sees a partial file.
  const staging = join(dir, `.${id}.tmp`);
  writeFileSync(staging, `${JSON.stringify(request, null, 2)}\n`, { flag: "wx" });
  renameSync(staging, join(dir, `${id}.json`));
  return { ok: true, request };
}

// Claiming is a rename into claimed/, so two workers can never take the same request.
// The phone wrapper claims exactly the request it filed, so a backlog never makes it run another one.
export function claimById(root, id) {
  const name = `${id}.json`;
  mkdirSync(join(root, "queue", "claimed"), { recursive: true });
  try {
    renameSync(join(root, "queue", "pending", name), join(root, "queue", "claimed", name));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return { name, request: JSON.parse(readFileSync(join(root, "queue", "claimed", name), "utf8")) };
}

export function claimOldest(root) {
  const pending = join(root, "queue", "pending");
  const claimed = join(root, "queue", "claimed");
  mkdirSync(claimed, { recursive: true });
  const names = existsSync(pending) ? readdirSync(pending).filter((n) => n.endsWith(".json")).sort() : [];
  for (const name of names) {
    try {
      renameSync(join(pending, name), join(claimed, name));
      return { name, request: JSON.parse(readFileSync(join(claimed, name), "utf8")) };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return null;
}

const RECIPE_SCRIPTS = { "plate-bracket-pin": "assembly.py", plate: "plate.py" };
const HERE = dirname(fileURLToPath(import.meta.url));
export const CAD_AGENT_FLAG = "JARVIS_CAD_AGENT_ENABLED";
const PLATE_FLAG_OFF = `plate jobs need ${CAD_AGENT_FLAG}=1`;
export const DEFAULT_WORKER_TIMEOUT_MS = 300_000;

export function workerTimeoutMs(env = process.env) {
  const ms = Number(env.JARVIS_DEMO_WORKER_TIMEOUT_MS);
  return Number.isInteger(ms) && ms > 0 ? ms : DEFAULT_WORKER_TIMEOUT_MS;
}

// Python runs in its own process group, so a timeout or a stop kills it and anything
// it started; nothing keeps writing into runs/<id>/ after the job is reported.
const running = new Set();
let stopping = false;

function killGroup(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Already exited.
  }
}

// Called on SIGTERM/SIGINT: kills every running Python group; each job's cleanup then
// runs as normal, so its claim still moves to failed/.
export function stopRunningWorkers() {
  stopping = true;
  for (const child of running) killGroup(child);
}

function runPython(python, args, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(python, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);
    const done = (status, error) => {
      clearTimeout(timer);
      running.delete(child);
      resolve({ status, stdout, stderr, error, timedOut });
    };
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => done(null, error));
    child.on("close", (status) => done(status));
    if (child.pid) running.add(child);
    if (stopping) killGroup(child);
  });
}

// The JARVIS_DEMO_ENABLED check is in main(); work() itself gates only plate jobs.
export async function work(root, python, id, env = process.env) {
  const claim = id ? claimById(root, id) : claimOldest(root);
  if (!claim) return id ? { ok: false, id, state: "not_pending" } : { ok: true, idle: true };
  return runClaim(root, python, claim, env);
}

async function runClaim(root, python, { name, request }, env) {
  const claimed = join(root, "queue", "claimed", name);
  const recipe = request.params?.recipe ?? request.params?.assembly;
  if (recipe === "plate" && env[CAD_AGENT_FLAG] !== "1") {
    // Not ours to run: hand it back untouched rather than failing it.
    mkdirSync(join(root, "queue", "pending"), { recursive: true });
    renameSync(claimed, join(root, "queue", "pending", name));
    return { ok: false, id: request.id, state: "disabled", reason: PLATE_FLAG_OFF };
  }
  let state = "failed";
  try {
    const runDir = join(root, "runs", request.id);
    mkdirSync(runDir, { recursive: true });
    const finish = (outcome, log) => {
      writeFileSync(join(runDir, "worker.log"), log);
      writeFileSync(join(runDir, "outcome.json"), `${JSON.stringify(outcome, null, 2)}\n`);
      return { ok: outcome.state === "verified", ...outcome };
    };
    if (!Object.hasOwn(RECIPE_SCRIPTS, recipe)) {
      return finish({ id: request.id, state, reason: "unknown recipe", runDir }, "unknown recipe\n");
    }
    const requestPath = join(runDir, "request.json");
    writeFileSync(requestPath, `${JSON.stringify({ ...request, state: "running" }, null, 2)}\n`);
    const timeoutMs = workerTimeoutMs(env);
    const started = Date.now();
    const run = await runPython(python, [join(HERE, RECIPE_SCRIPTS[recipe]), requestPath, runDir], {
      ...env,
      JARVIS_DEMO_ROOT: root,
      PYTHONDONTWRITEBYTECODE: "1",
    }, timeoutMs);
    state = run.status === 0 ? "verified" : run.status === 2 ? "checks_failed" : "failed";
    let reason;
    if (run.timedOut) reason = `worker timed out after ${timeoutMs} ms`;
    else if (stopping) reason = "worker stopped";
    else if (run.error) reason = "worker could not start";
    const outcome = { id: request.id, state, exitCode: run.status, durationMs: Date.now() - started, runDir, reason };
    return finish(outcome, `${run.stdout}\n--- stderr ---\n${run.stderr}${run.error ? `\n${run.error}` : ""}`);
  } finally {
    renameSync(claimed, join(root, "queue", state === "verified" ? "done" : "failed", name));
  }
}

const python = (root) => process.env.JARVIS_DEMO_PYTHON ?? join(root, ".venv", "bin", "python");
const source = () => process.env.JARVIS_DEMO_SOURCE ?? "cli";
const isRequestId = (value) => /^jd-[\w-]+$/.test(value ?? "");

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function runPlate(root, paramsJson) {
  if (process.env[CAD_AGENT_FLAG] !== "1") return { ok: false, state: "disabled", reason: PLATE_FLAG_OFF };
  const filed = createPlateRequest(root, parseJson(paramsJson), source(), new Date(), "claimed");
  if (!filed.ok) return filed;
  const result = await runClaim(root, python(root), { name: `${filed.request.id}.json`, request: filed.request }, process.env);
  const resultPath = result.runDir && join(result.runDir, "result.json");
  if (resultPath && existsSync(resultPath)) result.result = JSON.parse(readFileSync(resultPath, "utf8"));
  return result;
}

function readStatus(root, id) {
  const path = join(root, "runs", id, "outcome.json");
  return existsSync(path) ? { ok: true, ...JSON.parse(readFileSync(path, "utf8")) } : { ok: true, state: "pending_or_unknown" };
}

function dispatch(root, command, rest) {
  if (command === "request") return createRequest(root, rest.join(" "), source());
  if (command === "plate" && rest.length === 1) return runPlate(root, rest[0]);
  if (command === "work" && (rest.length === 0 || (rest[0] === "--id" && isRequestId(rest[1])))) return work(root, python(root), rest[1]);
  if (command === "status" && isRequestId(rest[0])) return readStatus(root, rest[0]);
  return undefined;
}

// The CLI's stdout is its response, so it carries ids, states, refusal reasons and
// the worker's verification summary only; never the request text, params, env or
// the Python stderr (that stays in runs/<id>/worker.log).
function responseOf(result) {
  const { ok, idle, id, state, exitCode, durationMs, runDir, reason } = result;
  const response = { ok, idle, id, state, exitCode, durationMs, runDir, reason };
  if (result.request) response.request = { id: result.request.id, state: result.request.state };
  if (result.result) {
    const { requestId, stepBboxMm, allChecksPass, checks, files } = result.result;
    response.result = { requestId, stepBboxMm, allChecksPass, checks, files };
  }
  return response;
}

async function main(argv) {
  if (process.env.JARVIS_DEMO_ENABLED !== "1") {
    console.error("Jarvis demo is off. Set JARVIS_DEMO_ENABLED=1 (admin only, never on the quoting path).");
    return 3;
  }
  const root = process.env.JARVIS_DEMO_ROOT ?? join(homedir(), "overnight", "jarvis");
  for (const dir of ["done", "failed"]) mkdirSync(join(root, "queue", dir), { recursive: true });
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, stopRunningWorkers);
  const [command, ...rest] = argv;
  const result = await dispatch(root, command, rest);
  if (!result) {
    console.error("usage: jarvis-demo.mjs request <text> | work [--id <id>] | status <id> | plate <params json>");
    return 64;
  }
  process.stdout.write(`${JSON.stringify(responseOf(result), null, 2)}\n`);
  if (result.ok) return 0;
  return result.state === "checks_failed" ? 2 : 1;
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
