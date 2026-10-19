// Pure operations on a project draft. Every function only APPENDS.
import { newId } from "./ids.mjs";

export function assetIdFor(sectionId) {
  return `asset-${sectionId}`;
}

export function makeVersion(partial, { id, now }) {
  return {
    id,
    parentId: null,
    kind: "manual",
    prompt: "",
    tool: "none",
    engine: "none",
    model: "none",
    usage: null,
    note: "",
    author: "human",
    createdAt: now.toISOString(),
    ...partial,
  };
}

export function currentVersion(entity) {
  return entity.versions.find((v) => v.id === entity.currentVersionId) || null;
}

export function appendVersion(entity, partial, { idGen = newId, now = () => new Date() } = {}) {
  const rec = makeVersion(partial, { id: idGen(now().getTime()), now: now() });
  if (rec.parentId === null && entity.versions.length && rec.kind !== "seed") {
    rec.parentId = entity.currentVersionId;
  }
  entity.versions.push(rec);
  if (rec.kind !== "failed") entity.currentVersionId = rec.id;
  return rec;
}

export function restoreVersion(entity, versionId, type, { note = "", idGen, now } = {}) {
  const old = entity.versions.find((v) => v.id === versionId);
  if (!old) throw Object.assign(new Error("Version not found."), { status: 404 });
  if (old.kind === "failed") throw Object.assign(new Error("A failed attempt cannot be restored."), { status: 400 });
  const partial = {
    kind: "restore",
    parentId: old.id,
    prompt: old.prompt,
    tool: old.tool,
    engine: old.engine,
    model: old.model,
    note: note || `Restored from ${old.id}`,
    author: "human",
  };
  if (type === "copy") partial.text = old.text;
  else partial.assetPath = old.assetPath;
  return appendVersion(entity, partial, { idGen, now });
}

export function addMark(entity, versionId, starred, now = () => new Date()) {
  if (!entity.versions.some((v) => v.id === versionId)) {
    throw Object.assign(new Error("Version not found."), { status: 404 });
  }
  entity.marks.push({ versionId, starred: !!starred, at: now().toISOString() });
}

export function starredIds(entity) {
  const s = new Map();
  for (const m of entity.marks) s.set(m.versionId, m.starred);
  return new Set([...s].filter(([, v]) => v).map(([k]) => k));
}

export function findVersion(project, versionId) {
  for (const [group, type] of [["fields", "copy"], ["assets", "asset"]]) {
    for (const ent of Object.values(project[group])) {
      const v = ent.versions.find((x) => x.id === versionId);
      if (v) return { type, entity: ent, version: v };
    }
  }
  return null;
}

// Decorate for API output: starred flag, isCurrent.
export function decorate(entity) {
  const stars = starredIds(entity);
  return {
    ...entity,
    versions: entity.versions.map((v) => ({
      ...v,
      starred: stars.has(v.id),
      isCurrent: v.id === entity.currentVersionId,
    })),
  };
}
