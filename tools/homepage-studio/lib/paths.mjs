// Id validation and path containment. Every id is /^[a-z0-9-]+$/ and every
// resolved path must stay inside its base directory.
import path from "node:path";

export const ID_RE = /^[a-z0-9-]+$/;

export class PathError extends Error {
  constructor(message) {
    super(message);
    this.name = "PathError";
    this.status = 400;
  }
}

export function isValidId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 80 && ID_RE.test(id);
}

export function assertId(id, label = "id") {
  if (!isValidId(id)) throw new PathError(`Invalid ${label}: ids may only use a-z, 0-9 and "-".`);
  return id;
}

export function resolveInside(base, ...parts) {
  const root = path.resolve(base);
  const target = path.resolve(root, ...parts);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new PathError("Path escapes the data directory.");
  }
  return target;
}

// Relative storage paths (posix style, used in the data repo too).
export const ASSET_PATH_RE = /^versions\/[a-z0-9-]+\/[a-z0-9-]+\/index\.html$/;
export const LOG_PATH_RE = /^versions\/[a-z0-9-]+\/[a-z0-9-]+\/job\.log$/;
export const BASELINE_PATH_RE = /^baselines\/[a-z0-9-]+\/index\.html$/;

export function assetPathFor(sectionId, versionId) {
  return `versions/${assertId(sectionId, "section id")}/${assertId(versionId, "version id")}/index.html`;
}
export function logPathFor(sectionId, versionId) {
  return `versions/${assertId(sectionId, "section id")}/${assertId(versionId, "version id")}/job.log`;
}

// Any path the storage layer will read or write.
export function isAllowedStoragePath(p) {
  return (
    typeof p === "string" &&
    (p === "project.json" ||
      /^jobs\/[a-z0-9-]+\.json$/.test(p) ||
      ASSET_PATH_RE.test(p) ||
      LOG_PATH_RE.test(p) ||
      BASELINE_PATH_RE.test(p))
  );
}
