// Storage adapter factory.
//
// Interface (all async):
//   readProject()                         -> project | null
//   update(label, fn)                     -> fn(draft) returns {result, files, jobs}; one atomic commit
//   appendVersion({entity,id,partial,files,label}) -> the new version record
//   readAsset(path)                       -> Buffer | null
//   listVersions(kind, id)                -> version[]
//   readJob / writeJob / listJobs
import os from "node:os";
import path from "node:path";
import { createFsStorage } from "./fs.mjs";
import { createGithubStorage } from "./github.mjs";
import { appendVersion as opsAppend } from "../ops.mjs";
import { StorageError } from "./common.mjs";

export function withAppendVersion(storage, { idGen, now } = {}) {
  storage.appendVersion = ({ entity, id, partial, files = [], label }) =>
    storage.update(label || `${entity} ${id}`, (draft) => {
      const group = entity === "field" ? draft.fields : draft.assets;
      if (!group[id]) throw new StorageError("invalid", `Unknown ${entity} ${id}`, 404);
      const rec = opsAppend(group[id], partial, { idGen, now });
      return { result: rec, files };
    });
  return storage;
}

export function createStorage({ env = process.env, mode, dataDir, fetchImpl, workflowFile } = {}) {
  if (mode === "hosted") {
    if (env.STUDIO_DATA_REPO && env.GITHUB_TOKEN) {
      return withAppendVersion(
        createGithubStorage({ repo: env.STUDIO_DATA_REPO, branch: env.STUDIO_DATA_BRANCH || "main", token: env.GITHUB_TOKEN, fetchImpl, workflowFile }),
      );
    }
    // No data repo configured: temporary storage so the demo flow can be tried. Clearly flagged in the UI.
    return withAppendVersion(createFsStorage({ dataDir: path.join(os.tmpdir(), "homepage-studio-temp"), ephemeral: true }));
  }
  return withAppendVersion(createFsStorage({ dataDir }));
}
