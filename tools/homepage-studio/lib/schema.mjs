// Hand-written schema validation for project.json and job records.
import { ASSET_PATH_RE, LOG_PATH_RE, ID_RE } from "./paths.mjs";

export const SCHEMA_VERSION = 1;
export const VERSION_KINDS = ["seed", "manual", "generated", "restore", "failed"];
export const AUTHORS = ["human", "agent"];
export const JOB_STATES = ["queued", "running", "succeeded", "failed", "blocked", "cancelled", "timed_out"];

export class SchemaError extends Error {
  constructor(errors) {
    super(`Schema validation failed: ${errors.slice(0, 5).join("; ")}${errors.length > 5 ? "; ..." : ""}`);
    this.name = "SchemaError";
    this.errors = errors;
    this.status = 400;
  }
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string";
const isIso = (v) => isStr(v) && !Number.isNaN(Date.parse(v));

export function validateVersion(v, type, where = "version") {
  const e = [];
  if (!isObj(v)) return [`${where}: not an object`];
  if (!isStr(v.id) || !ID_RE.test(v.id)) e.push(`${where}: bad id`);
  if (v.parentId !== null && !(isStr(v.parentId) && ID_RE.test(v.parentId))) e.push(`${where}: bad parentId`);
  if (!VERSION_KINDS.includes(v.kind)) e.push(`${where}: bad kind`);
  if (!AUTHORS.includes(v.author)) e.push(`${where}: bad author`);
  if (!isIso(v.createdAt)) e.push(`${where}: bad createdAt`);
  for (const k of ["prompt", "tool", "engine", "model", "note"]) {
    if (!isStr(v[k])) e.push(`${where}: ${k} must be a string`);
  }
  if (v.usage !== null && !isObj(v.usage)) e.push(`${where}: usage must be an object or null`);
  if (type === "copy") {
    if (v.kind !== "failed" && !isStr(v.text)) e.push(`${where}: copy version needs text`);
  } else if (type === "asset") {
    if (v.kind === "generated" || v.kind === "restore") {
      if (!isStr(v.assetPath) || !ASSET_PATH_RE.test(v.assetPath)) e.push(`${where}: bad assetPath`);
    } else if (v.kind === "failed") {
      if (v.assetPath !== null) e.push(`${where}: failed version has no assetPath`);
    } else e.push(`${where}: asset versions cannot be kind ${v.kind}`);
  }
  if (v.logPath !== undefined && v.logPath !== null && !(isStr(v.logPath) && LOG_PATH_RE.test(v.logPath))) {
    e.push(`${where}: bad logPath`);
  }
  if (v.kind === "restore" && v.parentId === null) e.push(`${where}: restore must point at the restored version`);
  return e;
}

function validateEntity(ent, type, key) {
  const e = [];
  const where = `${type} ${key}`;
  if (!isObj(ent)) return [`${where}: not an object`];
  if (ent.id !== key) e.push(`${where}: id mismatch`);
  if (!Array.isArray(ent.versions)) return [...e, `${where}: versions must be an array`];
  const ids = new Set();
  for (const v of ent.versions) {
    e.push(...validateVersion(v, type, `${where} version ${v && v.id}`));
    if (v && ids.has(v.id)) e.push(`${where}: duplicate version id ${v.id}`);
    if (v) ids.add(v.id);
  }
  for (const v of ent.versions) {
    if (v && v.parentId && !ids.has(v.parentId)) e.push(`${where}: parent ${v.parentId} missing`);
  }
  if (ent.currentVersionId !== null) {
    const cur = ent.versions.find((v) => v.id === ent.currentVersionId);
    if (!cur) e.push(`${where}: currentVersionId not found`);
    else if (cur.kind === "failed") e.push(`${where}: current version cannot be a failed record`);
  } else if (type === "copy") e.push(`${where}: copy needs a current version`);
  if (!Array.isArray(ent.marks)) e.push(`${where}: marks must be an array`);
  else {
    for (const m of ent.marks) {
      if (!isObj(m) || !ids.has(m.versionId) || typeof m.starred !== "boolean" || !isIso(m.at)) {
        e.push(`${where}: bad mark`);
      }
    }
  }
  return e;
}

export function validateProject(p) {
  const e = [];
  if (!isObj(p)) return ["project: not an object"];
  if (p.schema !== SCHEMA_VERSION) e.push("project: unsupported schema version");
  if (!Array.isArray(p.sections) || p.sections.length === 0) e.push("project: sections required");
  const sectionIds = new Set();
  for (const s of p.sections || []) {
    if (!isObj(s) || !ID_RE.test(s.id || "") || !isStr(s.label)) e.push("project: bad section");
    else sectionIds.add(s.id);
  }
  if (!isObj(p.fields)) e.push("project: fields must be an object");
  else {
    for (const [k, f] of Object.entries(p.fields)) {
      if (!ID_RE.test(k)) e.push(`field ${k}: bad id`);
      e.push(...validateEntity(f, "copy", k));
      if (isObj(f) && !sectionIds.has(f.sectionId)) e.push(`field ${k}: unknown section`);
      if (isObj(f) && !isStr(f.label)) e.push(`field ${k}: label required`);
    }
  }
  if (!isObj(p.assets)) e.push("project: assets must be an object");
  else {
    for (const [k, a] of Object.entries(p.assets)) {
      if (!ID_RE.test(k)) e.push(`asset ${k}: bad id`);
      e.push(...validateEntity(a, "asset", k));
      if (isObj(a) && !sectionIds.has(a.sectionId)) e.push(`asset ${k}: unknown section`);
    }
  }
  if (!Array.isArray(p.baselines)) e.push("project: baselines must be an array");
  if (!Array.isArray(p.capabilities)) e.push("project: capabilities must be an array");
  return e;
}

export function assertValidProject(p) {
  const errors = validateProject(p);
  if (errors.length) throw new SchemaError(errors);
  return p;
}

export function validateJob(j) {
  const e = [];
  if (!isObj(j)) return ["job: not an object"];
  if (!isStr(j.id) || !ID_RE.test(j.id)) e.push("job: bad id");
  if (!["asset", "copy"].includes(j.kind)) e.push("job: bad kind");
  if (!isStr(j.sectionId) || !ID_RE.test(j.sectionId)) e.push("job: bad sectionId");
  if (!JOB_STATES.includes(j.state)) e.push("job: bad state");
  if (!isStr(j.prompt)) e.push("job: prompt must be a string");
  if (!isStr(j.engine) || !isStr(j.tool)) e.push("job: engine and tool required");
  if (!isIso(j.createdAt)) e.push("job: bad createdAt");
  return e;
}
export function assertValidJob(j) {
  const errors = validateJob(j);
  if (errors.length) throw new SchemaError(errors);
  return j;
}

// Nothing may be deleted or rewritten: old versions and marks must be an exact prefix.
export function assertAppendOnly(oldP, newP) {
  const errors = [];
  for (const group of ["fields", "assets"]) {
    for (const [k, oldEnt] of Object.entries(oldP[group] || {})) {
      const newEnt = (newP[group] || {})[k];
      if (!newEnt) {
        errors.push(`${group}.${k} was removed`);
        continue;
      }
      for (const list of ["versions", "marks"]) {
        const a = oldEnt[list] || [];
        const b = newEnt[list] || [];
        if (b.length < a.length) errors.push(`${group}.${k}.${list} shrank`);
        for (let i = 0; i < a.length && i < b.length; i++) {
          if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) errors.push(`${group}.${k}.${list}[${i}] was rewritten`);
        }
      }
    }
  }
  const newSections = new Set((newP.sections || []).map((s) => s.id));
  for (const s of oldP.sections || []) if (!newSections.has(s.id)) errors.push(`section ${s.id} was removed`);
  if (errors.length) throw new SchemaError(errors);
}
