// Local filesystem storage under a data directory. Atomic writes (temp+rename),
// serialized through one in-process queue, append-only for assets.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { resolveInside, isAllowedStoragePath, assertId } from "../paths.mjs";
import { StorageError, planUpdate, jobFile, serializeProject, newestFirst } from "./common.mjs";

export function createFsStorage({ dataDir, ephemeral = false }) {
  const root = path.resolve(dataDir);
  let queue = Promise.resolve();

  const abs = (rel) => resolveInside(root, rel);

  async function atomicWrite(rel, content) {
    const target = abs(rel);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    await fs.promises.writeFile(tmp, content);
    await fs.promises.rename(tmp, target);
  }

  async function readProject() {
    try {
      return JSON.parse(await fs.promises.readFile(abs("project.json"), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }

  function update(label, fn) {
    const run = async () => {
      const cur = await readProject();
      if (!cur) throw new StorageError("not_initialized", "No project yet. Run the seed script or start the server once.", 503);
      const plan = await planUpdate(cur, fn);
      for (const f of plan.files) {
        if (f.path.startsWith("versions/")) {
          let existing = null;
          try {
            existing = await fs.promises.readFile(abs(f.path));
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
          if (existing && !existing.equals(f.content)) {
            throw new StorageError("invalid", `Refusing to overwrite ${f.path}: storage is append-only.`, 409);
          }
          if (existing) continue;
        }
        await atomicWrite(f.path, f.content);
      }
      for (const j of plan.jobs) await atomicWrite(jobFile(j).path, jobFile(j).content);
      if (plan.changed) await atomicWrite("project.json", serializeProject(plan.project));
      return plan.result;
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }

  async function initProject(project) {
    const run = async () => {
      if (await readProject()) return false;
      await atomicWrite("project.json", serializeProject(project));
      return true;
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }

  async function replaceProject(project) {
    // Used only by the seed script (which preserves every version).
    const p = queue.then(() => atomicWrite("project.json", serializeProject(project)));
    queue = p.catch(() => {});
    return p;
  }

  async function readFileOrNull(rel) {
    if (!isAllowedStoragePath(rel)) throw new StorageError("invalid", "Path not allowed.", 400);
    try {
      return await fs.promises.readFile(abs(rel));
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }

  return {
    kind: "fs",
    ephemeral,
    cheapWrites: true,
    dataDir: root,
    readProject,
    update,
    initProject,
    replaceProject,
    readAsset: readFileOrNull,
    async readJob(id) {
      assertId(id, "job id");
      const b = await readFileOrNull(`jobs/${id}.json`);
      return b ? JSON.parse(b.toString("utf8")) : null;
    },
    writeJob(job, label = "job") {
      return update(label, () => ({ jobs: [job] }));
    },
    async listJobs(limit = 10) {
      let names = [];
      try {
        names = await fs.promises.readdir(abs("jobs"));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      const picked = newestFirst(names.filter((n) => /^[a-z0-9-]+\.json$/.test(n))).slice(0, limit);
      const out = [];
      for (const n of picked) out.push(JSON.parse(await fs.promises.readFile(abs(`jobs/${n}`), "utf8")));
      return out;
    },
    async listVersions(kind, id) {
      const p = await readProject();
      const ent = p && (kind === "field" ? p.fields[id] : p.assets[id]);
      return ent ? ent.versions : [];
    },
    // Directory a local engine may write into (cwd of the claude run).
    async workDir(sectionId, versionId) {
      const dir = abs(`versions/${assertId(sectionId)}/${assertId(versionId)}`);
      await fs.promises.mkdir(dir, { recursive: true });
      return dir;
    },
  };
}
