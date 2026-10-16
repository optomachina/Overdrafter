#!/usr/bin/env node
// Jarvis end to end demo (OVD-743 follow up): a phone reachable trigger files a
// design request into a local queue, and a worker claims it and runs the
// CAD-neutral assembly build. Demo only: behind JARVIS_DEMO_ENABLED=1, local
// files only, no hosted database, no SolidWorks, no provider calls.
//
//   node scripts/jarvis-demo/jarvis-demo.mjs request "<text>"   -> prints the request id
//   node scripts/jarvis-demo/jarvis-demo.mjs work [--id <id>]   -> runs that request, or the oldest pending one
//   node scripts/jarvis-demo/jarvis-demo.mjs status <id>
//
// JARVIS_DEMO_ROOT (default ~/overnight/jarvis) holds queue/ and runs/.
// JARVIS_DEMO_PYTHON points at a Python with build123d and matplotlib.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
    return { ok: false, reason: `give the pin diameter in mm, got "${match[0].trim()}"` };
  }
  const pinDiameterMm = match ? Number(match[1] ?? match[3]) : DEFAULT_PIN_MM;
  if (!(pinDiameterMm >= PIN_MIN_MM && pinDiameterMm <= PIN_MAX_MM)) {
    return { ok: false, reason: `pin diameter must be ${PIN_MIN_MM} to ${PIN_MAX_MM} mm, got ${pinDiameterMm}` };
  }
  return { ok: true, params: { assembly: "plate-bracket-pin", pinDiameterMm, pinProtrusionMm: 6 } };
}

export function createRequest(root, text, source, now = new Date()) {
  const parsed = parseDesignRequest(text);
  if (!parsed.ok) return parsed;
  const id = `jd-${now.toISOString().replace(/[-:.]/g, "").slice(0, 18)}-${randomUUID().slice(0, 8)}`;
  const request = { id, createdAt: now.toISOString(), source, text, params: parsed.params, state: "pending" };
  const pending = join(root, "queue", "pending");
  mkdirSync(pending, { recursive: true });
  // Write under a non-.json name, then rename, so a worker never sees a partial file.
  const staging = join(pending, `.${id}.tmp`);
  writeFileSync(staging, `${JSON.stringify(request, null, 2)}\n`, { flag: "wx" });
  renameSync(staging, join(pending, `${id}.json`));
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

function work(root, python, id) {
  const claim = id ? claimById(root, id) : claimOldest(root);
  if (!claim) return id ? { ok: false, id, state: "not_pending" } : { ok: true, idle: true };
  const { name, request } = claim;
  let state = "failed";
  try {
    const runDir = join(root, "runs", request.id);
    mkdirSync(runDir, { recursive: true });
    const requestPath = join(runDir, "request.json");
    writeFileSync(requestPath, `${JSON.stringify({ ...request, state: "running" }, null, 2)}\n`);
    const script = join(dirname(fileURLToPath(import.meta.url)), "assembly.py");
    const started = Date.now();
    const run = spawnSync(python, [script, requestPath, runDir], {
      encoding: "utf8",
      timeout: 300_000,
      env: { ...process.env, JARVIS_DEMO_ROOT: root },
    });
    state = run.status === 0 ? "verified" : run.status === 2 ? "checks_failed" : "failed";
    const outcome = { id: request.id, state, exitCode: run.status, durationMs: Date.now() - started, runDir };
    writeFileSync(join(runDir, "worker.log"), `${run.stdout ?? ""}\n--- stderr ---\n${run.stderr ?? ""}${run.error ? `\n${run.error}` : ""}`);
    writeFileSync(join(runDir, "outcome.json"), `${JSON.stringify(outcome, null, 2)}\n`);
    return { ok: state === "verified", ...outcome };
  } finally {
    renameSync(join(root, "queue", "claimed", name), join(root, "queue", state === "verified" ? "done" : "failed", name));
  }
}

function main(argv) {
  if (process.env.JARVIS_DEMO_ENABLED !== "1") {
    console.error("Jarvis demo is off. Set JARVIS_DEMO_ENABLED=1 (admin only, never on the quoting path).");
    return 3;
  }
  const root = process.env.JARVIS_DEMO_ROOT ?? join(homedir(), "overnight", "jarvis");
  for (const dir of ["done", "failed"]) mkdirSync(join(root, "queue", dir), { recursive: true });
  const [command, ...rest] = argv;
  let result;
  if (command === "request") {
    result = createRequest(root, rest.join(" "), process.env.JARVIS_DEMO_SOURCE ?? "cli");
  } else if (command === "work" && (rest.length === 0 || (rest[0] === "--id" && /^jd-[\w-]+$/.test(rest[1] ?? "")))) {
    result = work(root, process.env.JARVIS_DEMO_PYTHON ?? join(root, ".venv", "bin", "python"), rest[1]);
  } else if (command === "status" && rest[0] && /^jd-[\w-]+$/.test(rest[0])) {
    const path = join(root, "runs", rest[0], "outcome.json");
    result = existsSync(path) ? { ok: true, ...JSON.parse(readFileSync(path, "utf8")) } : { ok: true, state: "pending_or_unknown" };
  } else {
    console.error("usage: jarvis-demo.mjs request <text> | work [--id <id>] | status <id>");
    return 64;
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.ok) return 0;
  return result.state === "checks_failed" ? 2 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
