// Loads studio.config.json and resolves per-tool availability for each engine.
// The UI only ever sees public fields: no filesystem paths leave the server.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function expandHome(p, home = os.homedir()) {
  if (typeof p !== "string") return p;
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

export function loadConfig(file, { home = os.homedir() } = {}) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const tools = raw.tools.map((t) => ({
    ...t,
    resolvedPath: t.skillPath ? expandHome(t.skillPath, home) : null,
  }));
  return {
    studioName: raw.studioName,
    jobTimeoutMs: (raw.jobTimeoutMinutes ?? 20) * 60_000,
    workerTimeoutMinutes: raw.workerTimeoutMinutes ?? 30,
    defaultTool: raw.defaultTool,
    workflowFile: raw.workflowFile || "studio-generate.yml",
    tools,
  };
}

export function getTool(config, id) {
  return config.tools.find((t) => t.id === id) || null;
}

// Local reference directory check (claude-cli engine on a machine with the skills copied).
export function localToolStatus(tool, fsImpl = fs) {
  if (!tool.skillPath) return { ok: true, reason: "" };
  if (!path.isAbsolute(tool.resolvedPath || "")) {
    return { ok: false, reason: `${tool.label} is unavailable: its skill path must be absolute. Fix studio.config.json.` };
  }
  const entry = path.join(tool.resolvedPath, tool.entry || "SKILL.md");
  try {
    if (!fsImpl.statSync(tool.resolvedPath).isDirectory() || !fsImpl.statSync(entry).isFile()) throw new Error("missing");
  } catch {
    return {
      ok: false,
      reason: `${tool.label} is unavailable: its skill folder was not found on this machine. Copy the skill into the studio skills folder for \"${tool.id}\" (see README), then reload.`,
    };
  }
  return { ok: true, reason: "" };
}

// Hosted worker check: the source must be pinned (commit SHA or zip sha256).
export function remoteToolStatus(tool) {
  if (!tool.source) return { ok: true, reason: "" };
  const s = tool.source;
  const pinned = s.type === "git" ? /^[0-9a-f]{40}$/.test(s.commit || "") : /^[0-9a-f]{64}$/.test(s.sha256 || "");
  if (!pinned) {
    return { ok: false, reason: `${tool.label} is unavailable for the hosted worker: its source is not pinned. Record a commit SHA or sha256 in studio.config.json.` };
  }
  return { ok: true, reason: "" };
}

export function publicTools(config, { fsImpl = fs } = {}) {
  return config.tools.map((t) => ({
    id: t.id,
    label: t.label,
    description: t.description,
    goodFor: t.goodFor,
    usesSkill: !!t.skillPath,
    availability: {
      "claude-cli": localToolStatus(t, fsImpl),
      "github-actions": remoteToolStatus(t),
      "template-demo": { ok: true, reason: "" },
    },
  }));
}
