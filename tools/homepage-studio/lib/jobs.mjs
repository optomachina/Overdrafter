// Job state machine: queued, running, succeeded, failed, blocked, cancelled, timed_out.
// Inline engines run in this process; the github-actions engine queues a job file and
// triggers the worker workflow, and state is read back from the job file plus the run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newId } from "./ids.mjs";
import { assertId } from "./paths.mjs";
import { getTool } from "./config.mjs";
import { toolPaths } from "./engines/claude-cli.mjs";
import { finalizeJob, RECOVERY } from "./finalize.mjs";
import { currentVersion } from "./ops.mjs";
import { StorageError } from "./storage/common.mjs";

const FINAL = new Set(["succeeded", "failed", "blocked", "cancelled", "timed_out"]);
const MAX_PROMPT = 8000;

export class JobError extends Error {
  constructor(message, status = 400, code = "invalid") {
    super(message);
    this.name = "JobError";
    this.status = status;
    this.code = code;
  }
}

export class JobManager {
  constructor({ storage, engines, config, awaitInline = false, timeoutMs, now = () => new Date(), idGen = newId, localToolStatus, finalize = null }) {
    this.finalize = finalize;
    this.storage = storage;
    this.engines = engines;
    this.config = config;
    this.awaitInline = awaitInline;
    this.timeoutMs = timeoutMs ?? config.jobTimeoutMs;
    this.now = now;
    this.idGen = idGen;
    this.localToolStatus = localToolStatus;
    this.live = new Map(); // jobId -> {controller, log, promise, flags}
  }

  async idle() {
    await Promise.all([...this.live.values()].map((l) => l.promise.catch(() => {})));
  }

  async submit(params) {
    const project = await this.storage.readProject();
    if (!project) throw new JobError("No project yet.", 503, "not_initialized");
    const { kind, sectionId, fieldId } = params;
    if (!["asset", "copy"].includes(kind)) throw new JobError("kind must be asset or copy.");
    assertId(sectionId, "section id");
    if (!project.sections.some((s) => s.id === sectionId)) throw new JobError("Unknown section.", 404);
    const prompt = String(params.prompt ?? "");
    if (prompt.length > MAX_PROMPT) throw new JobError(`Prompt is longer than ${MAX_PROMPT} characters.`);
    if (kind === "copy") {
      if (!project.fields[fieldId] || project.fields[fieldId].sectionId !== sectionId) throw new JobError("Unknown field for this section.", 404);
      if (!prompt.trim()) throw new JobError("Write an instruction first, for example: shorter, more concrete.");
    }
    const engine = this.engines[params.engine];
    if (!engine) throw new JobError(`Unknown engine: ${params.engine}`);
    const tool = getTool(this.config, params.tool);
    if (!tool) throw new JobError(`Unknown tool: ${params.tool}`);
    const model = params.model === "opus" ? "opus" : "sonnet";

    const target = kind === "copy" ? `copy:${fieldId}` : `asset:${sectionId}`;
    for (const j of await this.activeJobs()) {
      if (j.target === target) throw new JobError("A job for this item is already running. Cancel it or wait.", 409, "busy");
    }

    const job = {
      id: this.idGen(this.now().getTime()),
      versionId: this.idGen(this.now().getTime()),
      kind,
      sectionId,
      ...(kind === "copy" ? { fieldId } : {}),
      target,
      prompt,
      tool: tool.id,
      engine: engine.id,
      model,
      state: "queued",
      message: "",
      recovery: "",
      createdAt: this.now().toISOString(),
    };

    if (!engine.inline) return this.submitRemote(job, engine);

    const initial = { ...job };
    const entry = { controller: new AbortController(), log: [], flags: {} };
    entry.promise = this.runInline(job, engine, tool, project, entry).finally(() => this.live.delete(job.id));
    this.live.set(job.id, entry);
    if (this.storage.cheapWrites) await this.storage.writeJob(initial, `queued ${kind} ${sectionId} ${job.id}`);
    if (this.awaitInline) {
      await entry.promise;
      return this.get(job.id);
    }
    return initial;
  }

  async activeJobs() {
    const active = [...this.live.keys()];
    const out = [];
    for (const id of active) {
      const j = await this.storage.readJob(id).catch(() => null);
      if (j && !FINAL.has(j.state)) out.push(j);
    }
    // Remote jobs: check recent job files that are still non-final.
    if (!this.storage.cheapWrites) {
      for (const j of await this.storage.listJobs(10)) if (!FINAL.has(j.state)) out.push(j);
    }
    return out;
  }

  async submitRemote(job, engine) {
    const av = await engine.available();
    if (!av.ok) {
      const blocked = { ...job, state: "blocked", message: av.message, recovery: RECOVERY.blocked, finishedAt: this.now().toISOString() };
      await this.storage.writeJob(blocked, `blocked ${job.kind} ${job.sectionId} ${job.id}`);
      return blocked;
    }
    const tool = getTool(this.config, job.tool);
    const remote = tool.source ? (await import("./config.mjs")).remoteToolStatus(tool) : { ok: true };
    if (!remote.ok) {
      const blocked = { ...job, state: "blocked", message: remote.reason, recovery: RECOVERY.blocked, finishedAt: this.now().toISOString() };
      await this.storage.writeJob(blocked, `blocked ${job.kind} ${job.sectionId} ${job.id}`);
      return blocked;
    }
    await this.storage.writeJob(job, `queued ${job.kind} ${job.sectionId} ${job.id}`);
    try {
      await engine.enqueue(job);
    } catch (e) {
      const failed = { ...job, state: "blocked", message: `Could not start the worker: ${e.message}`, recovery: RECOVERY.blocked, finishedAt: this.now().toISOString() };
      await this.storage.writeJob(failed, `blocked ${job.kind} ${job.sectionId} ${job.id}`);
      return failed;
    }
    return { ...job };
  }

  async runInline(job, engine, tool, project, entry) {
    const log = (line) => entry.log.push(`${this.now().toISOString()} ${line}`);
    const setState = async (patch) => {
      Object.assign(job, patch);
      if (this.storage.cheapWrites) await this.storage.writeJob({ ...job }, `${job.state} ${job.kind} ${job.sectionId} ${job.id}`);
    };
    const finish = (outcome) => this.doFinalize({ ...job, startedAt: job.startedAt }, { ...outcome, log: entry.log.join("\n") });

    try {
      await setState({ state: "running", startedAt: this.now().toISOString() });
      if (entry.flags.cancelled) return await finish({ state: "cancelled", message: "Cancelled before it started." });

      if (engine.usesSkills) {
        const st = this.localToolStatus ? this.localToolStatus(tool) : { ok: true };
        if (!st.ok) return await finish({ state: "blocked", message: st.reason });
      }
      const av = await engine.available();
      if (!av.ok) {
        log(`blocked: ${av.message}`);
        return await finish({ state: "blocked", message: av.message });
      }

      const field = job.kind === "copy" ? project.fields[job.fieldId] : null;
      const sectionFields = Object.values(project.fields).filter((f) => f.sectionId === job.sectionId);
      const outDir = job.kind === "asset" && this.storage.workDir ? await this.storage.workDir(job.sectionId, job.versionId) : await fs.promises.mkdtemp(path.join(os.tmpdir(), "studio-job-"));
      const section = project.sections.find((s) => s.id === job.sectionId);
      const ctx = {
        jobId: job.id, kind: job.kind, section, field, prompt: job.prompt, model: job.model, outDir,
        currentCopy: sectionFields.map((f) => ({ label: f.label, text: currentVersion(f).text })),
        currentText: field ? currentVersion(field).text : "",
        tool: { ...(toolPaths(tool) || {}), id: tool.id, label: tool.label },
        signal: entry.controller.signal, onLog: log, timeoutMs: this.timeoutMs,
      };
      const timer = setTimeout(() => {
        entry.flags.timedOut = true;
        entry.controller.abort();
      }, this.timeoutMs);
      let res;
      try {
        res = await engine.run(ctx);
      } catch (e) {
        if (entry.flags.timedOut) return await finish({ state: "timed_out", message: `Timed out after ${Math.round(this.timeoutMs / 60000)} minutes.` });
        if (entry.flags.cancelled) return await finish({ state: "cancelled", message: "Cancelled by the owner." });
        if (e.code === "unavailable") return await finish({ state: "blocked", message: e.message });
        log(`error: ${e.message}`);
        return await finish({ state: "failed", message: e.message });
      } finally {
        clearTimeout(timer);
      }
      if (entry.flags.cancelled) return await finish({ state: "cancelled", message: "Cancelled by the owner." });
      const outcome = { state: "succeeded", message: "", model: res.model, usage: res.usage, demo: !!res.demo };
      if (job.kind === "copy") outcome.text = res.text;
      else {
        try {
          outcome.assetHtml = await fs.promises.readFile(path.join(outDir, "index.html"), "utf8");
        } catch {
          outcome.state = "failed";
          outcome.message = "The engine finished but wrote no index.html.";
        }
      }
      return await finish(outcome);
    } catch (e) {
      log(`internal error: ${e.message}`);
      // Last resort: make sure the job does not stay "running" forever.
      try {
        return await this.doFinalize({ ...job }, { state: "failed", message: `Internal error: ${e.message}`, log: entry.log.join("\n") });
      } catch {
        return null;
      }
    }
  }

  doFinalize(job, outcome) {
    if (this.finalize) return this.finalize(job, outcome);
    return finalizeJob(this.storage, job, outcome, { now: this.now, idGen: this.idGen });
  }

  // Worker entry: run a job record that already exists in storage (state queued).
  async runExisting(job) {
    const project = await this.storage.readProject();
    const engine = this.engines[job.engine === "github-actions" ? "claude-cli" : job.engine];
    const tool = getTool(this.config, job.tool);
    if (!project || !engine || !tool) throw new JobError("Job references an unknown project, engine or tool.");
    const entry = { controller: new AbortController(), log: [], flags: {} };
    entry.promise = this.runInline({ ...job }, engine, tool, project, entry).finally(() => this.live.delete(job.id));
    this.live.set(job.id, entry);
    return entry.promise;
  }

  async get(id) {
    assertId(id, "job id");
    const stored = await this.storage.readJob(id);
    if (!stored) throw new JobError("Job not found.", 404, "not_found");
    const live = this.live.get(id);
    let job = { ...stored };
    // In-process job whose final write has not landed yet.
    if (live && !FINAL.has(job.state)) job.state = job.state === "queued" ? "queued" : "running";
    let run = null;
    if (!FINAL.has(job.state) && !live && this.engines["github-actions"] && !this.engines["github-actions"].inline && this.storage.kind === "github") {
      try {
        run = await this.engines["github-actions"].status(job);
      } catch (e) {
        job.statusNote = `Could not read worker status: ${e.message}`;
      }
      if (run) {
        job.runUrl = run.url;
        if (run.status === "in_progress") job.state = "running";
        if (run.status === "completed" && run.conclusion && run.conclusion !== "success") {
          job.state = run.conclusion === "cancelled" ? "cancelled" : run.conclusion === "timed_out" ? "timed_out" : "failed";
          job.message = `The worker run ended with "${run.conclusion}". Open the run for logs.`;
          job.recovery = RECOVERY[job.state];
        } else if (run.status === "completed" && run.conclusion === "success") {
          job.message = "The worker finished; refreshing the result.";
        }
      }
    }
    if (!FINAL.has(job.state) && !live && this.storage.kind === "fs" && Date.now() - Date.parse(job.createdAt) > this.timeoutMs + 60_000) {
      job.state = "failed";
      job.message = "The studio restarted while this job was running.";
      job.recovery = RECOVERY.failed;
    }
    if (live) job.log = live.log.slice(-200);
    return job;
  }

  async list(limit = 8) {
    return this.storage.listJobs(limit);
  }

  async cancel(id) {
    const live = this.live.get(id);
    if (live) {
      live.flags.cancelled = true;
      live.controller.abort();
      return this.get(id);
    }
    const job = await this.get(id);
    if (FINAL.has(job.state)) throw new JobError(`Job already ${job.state}.`, 409, "final");
    throw new JobError("This job runs on the worker and cannot be cancelled from here. Cancel the run in GitHub Actions.", 409, "remote");
  }

  async retry(id, overrides = {}) {
    const old = await this.storage.readJob(id);
    if (!old) throw new JobError("Job not found.", 404, "not_found");
    return this.submit({ kind: old.kind, sectionId: old.sectionId, fieldId: old.fieldId, prompt: old.prompt, tool: old.tool, engine: old.engine, model: old.model, ...overrides });
  }
}

export { StorageError };
