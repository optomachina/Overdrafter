import fs from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { sanitizeToken } from "../jev-client.mjs";

export const REASON_CODES = Object.freeze(["path-rule", "jev-score", "marker-raise", "files-incomplete", "error"]);

export function validateRow(row, { logPath } = {}) {
  const problems = [];
  const plain = row !== null && typeof row === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(row));
  if (!plain) problems.push("row: must be a plain object");
  else {
    for (const field of ["ts", "reason", "shadow", "kind"]) {
      if (!Object.hasOwn(row, field)) { problems.push(`missing: ${field}`); continue; }
      if (field === "ts" && (typeof row.ts !== "string" || !Number.isFinite(Date.parse(row.ts)) || !/(Z|[+-]\d{2}:\d{2})$/.test(row.ts)))
        problems.push("ts: must be a timestamp with zone");
      if (field === "reason" && (typeof row.reason !== "string" || !row.reason.trim() || sanitizeToken(row.reason) !== row.reason || !REASON_CODES.includes(row.reason)))
        problems.push("reason: must be an allowed sanitized code");
      if (field === "shadow" && typeof row.shadow !== "boolean") problems.push("shadow: must be boolean");
      if (field === "kind" && (typeof row.kind !== "string" || !row.kind.trim())) problems.push("kind: must be non-empty string");
    }
    if (logPath !== undefined && typeof row.shadow === "boolean" &&
        (typeof logPath !== "string" || row.shadow !== logPath.endsWith(".shadow.jsonl")))
      problems.push("shadow: log path mismatch");
  }
  try {
    const serialized = JSON.stringify(row);
    const key = process.env.TYPESAFE_API_KEY?.trim();
    if (serialized === undefined) problems.push("row: must be JSON serializable");
    if (key && serialized?.includes(key)) problems.push("secret: row contains api key");
  } catch { problems.push("row: must be JSON serializable"); }
  return problems.length ? { ok: false, problems } : { ok: true };
}

const defaultWarn = (message) => process.stderr.write(message + "\n");
function reject(logPath, raw, problems, append, warn) {
  warn("jev-decisions: rejected row (" + problems.join("; ") + ")");
  const row_sha256 = createHash("sha256").update(raw).digest("hex");
  append(`${logPath}.rejects.jsonl`, JSON.stringify({ ts: new Date().toISOString(), log: logPath, problems, row_sha256 }) + "\n");
  return { ok: false, problems };
}

export function appendDecision(logPath, row, { append = fs.appendFileSync, warn = defaultWarn } = {}) {
  const result = validateRow(row, { logPath });
  let serialized;
  try { serialized = JSON.stringify(row); } catch { /* Non-JSON input is hashed as text. */ }
  if (!result.ok) return reject(logPath, serialized ?? String(row), result.problems, append, warn);
  append(logPath, serialized + "\n");
  return { ok: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , flag, logPath] = process.argv;
  if (flag !== "--append" || !logPath) {
    process.stderr.write("usage: jev-decisions-log.mjs --append <log>\n");
    process.exitCode = 2;
  } else {
    const raw = fs.readFileSync(0, "utf8");
    let row;
    let parsed = false;
    try { row = JSON.parse(raw); parsed = true; } catch { /* Reject without retaining raw input. */ }
    const result = parsed ? appendDecision(logPath, row) :
      reject(logPath, raw, ["invalid json"], fs.appendFileSync, defaultWarn);
    process.exitCode = result.ok ? 0 : 3;
  }
}
