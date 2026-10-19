import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { JobManager, JobError } from "../lib/jobs.mjs";
import { createFsStorage } from "../lib/storage/fs.mjs";
import { withAppendVersion } from "../lib/storage/index.mjs";
import { createFakeEngine } from "../lib/engines/fake.mjs";
import { createTemplateDemoEngine } from "../lib/engines/template-demo.mjs";
import { createClaudeCliEngine, buildArgs, NOT_LOGGED_IN, NOT_INSTALLED, parseCopyResult, toolPaths } from "../lib/engines/claude-cli.mjs";
import { createEngines } from "../lib/engines/index.mjs";
import { createGithubStorage } from "../lib/storage/github.mjs";
import { buildBrief, WORDING_RULES } from "../lib/brief.mjs";
import { loadConfig, localToolStatus, remoteToolStatus } from "../lib/config.mjs";
import { checkAsset } from "../lib/assetcheck.mjs";
import { demoAssetHtml } from "../lib/engines/template-demo.mjs";
import { runWorkerJob, NO_CREDENTIAL, scrubbedEnv, hasCredential } from "../lib/worker-core.mjs";
import { freshProject, tmpDir, studioRoot, githubWithProject } from "./helpers.mjs";

const config = loadConfig(path.join(studioRoot, "studio.config.json"), { home: "/nonexistent-home" });

async function setup(engineOpts, mgrOpts = {}) {
  const dir = tmpDir();
  const storage = withAppendVersion(createFsStorage({ dataDir: dir }));
  await storage.initProject(freshProject());
  const fake = createFakeEngine(engineOpts);
  const jobs = new JobManager({ storage, engines: { fake, "template-demo": createTemplateDemoEngine() }, config, timeoutMs: 5000, ...mgrOpts });
  return { storage, jobs, dir };
}
const params = (o = {}) => ({ kind: "asset", sectionId: "ch3", prompt: "make it", tool: "hand-built", engine: "fake", model: "sonnet", ...o });
const finalJob = async (jobs, j) => {
  await jobs.idle();
  return jobs.get(j.id);
};

test("job succeeds: version record, receipt, file in storage", async () => {
  const { jobs, storage } = await setup({ behavior: "success" });
  const j = await jobs.submit(params());
  assert.equal(j.state, "queued");
  const done = await finalJob(jobs, j);
  assert.equal(done.state, "succeeded");
  const a = (await storage.readProject()).assets["asset-ch3"];
  assert.equal(a.versions.length, 1);
  assert.equal(a.versions[0].kind, "generated");
  assert.equal(a.versions[0].model, "fake-model");
  assert.equal(a.versions[0].prompt, "make it");
  assert.equal(a.currentVersionId, done.resultVersionId);
  assert.match((await storage.readAsset(a.versions[0].assetPath)).toString(), /<html/);
});

test("job failure still records a failed version with the log and a recovery action", async () => {
  const { jobs, storage } = await setup({ behavior: "fail", message: "boom" });
  const done = await finalJob(jobs, await jobs.submit(params()));
  assert.equal(done.state, "failed");
  assert.match(done.recovery, /Retry|switch tool|demo engine/);
  const a = (await storage.readProject()).assets["asset-ch3"];
  assert.equal(a.versions[0].kind, "failed");
  assert.equal(a.currentVersionId, null, "a failed record never becomes current");
  assert.match((await storage.readAsset(a.versions[0].logPath)).toString(), /boom/);
});

test("job timeout kills the engine and records timed_out", async () => {
  const { jobs, storage } = await setup({ behavior: "timeout" }, { timeoutMs: 60 });
  const done = await finalJob(jobs, await jobs.submit(params()));
  assert.equal(done.state, "timed_out");
  assert.match(done.recovery, /Retry/);
  assert.equal((await storage.readProject()).assets["asset-ch3"].versions[0].kind, "failed");
});

test("unavailable engine => blocked, no version, no fabricated output", async () => {
  const { jobs, storage } = await setup({ behavior: "unavailable", message: "Nope." });
  const done = await finalJob(jobs, await jobs.submit(params()));
  assert.equal(done.state, "blocked");
  assert.equal(done.message, "Nope.");
  assert.match(done.recovery, /demo engine/);
  assert.equal((await storage.readProject()).assets["asset-ch3"].versions.length, 0);
});

test("cancel aborts a running job", async () => {
  const { jobs } = await setup({ behavior: "hang" });
  const j = await jobs.submit(params());
  await new Promise((r) => setTimeout(r, 30));
  await jobs.cancel(j.id);
  const done = await finalJob(jobs, j);
  assert.equal(done.state, "cancelled");
});

test("busy: a second job for the same target is refused while one runs", async () => {
  const { jobs } = await setup({ behavior: "hang" });
  const j = await jobs.submit(params());
  await assert.rejects(jobs.submit(params()), (e) => e instanceof JobError && e.status === 409);
  await jobs.cancel(j.id);
  await jobs.idle();
});

test("retry with the demo engine keeps prompt and section and is labelled", async () => {
  const { jobs, storage } = await setup({ behavior: "unavailable" });
  const blocked = await finalJob(jobs, await jobs.submit(params({ prompt: "same prompt" })));
  assert.equal(blocked.state, "blocked");
  const again = await jobs.retry(blocked.id, { engine: "template-demo" });
  const done = await finalJob(jobs, again);
  assert.equal(done.state, "succeeded");
  assert.equal(done.demo, true);
  const v = (await storage.readProject()).assets["asset-ch3"].versions[0];
  assert.equal(v.prompt, "same prompt");
  assert.equal(v.engine, "template-demo");
  assert.match(v.note, /demo engine, not generated by a model/);
  assert.match(v.model, /demo engine, not generated by a model/);
});

test("output that breaks the asset contract becomes a failed record", async () => {
  const { jobs, storage } = await setup({ behavior: "bad-output" });
  const done = await finalJob(jobs, await jobs.submit(params()));
  assert.equal(done.state, "failed");
  assert.match(done.message, /asset contract/);
  assert.equal((await storage.readProject()).assets["asset-ch3"].versions[0].kind, "failed");
});

test("copy jobs: clean candidate saved; lint-error candidate rejected as failed", async () => {
  const ok = await setup({ behavior: "success", text: "A tidy replacement." });
  let done = await finalJob(ok.jobs, await ok.jobs.submit({ kind: "copy", sectionId: "hero", fieldId: "hero-lede", prompt: "shorter", tool: "hand-built", engine: "fake" }));
  assert.equal(done.state, "succeeded");
  let f = (await ok.storage.readProject()).fields["hero-lede"];
  assert.equal(f.versions.at(-1).kind, "generated");
  assert.equal(f.versions.at(-1).author, "agent");
  assert.equal(f.versions.at(-1).text, "A tidy replacement.");

  const bad = await setup({ behavior: "success", text: "Ships in Q3 2027 with SolidWorks." });
  done = await finalJob(bad.jobs, await bad.jobs.submit({ kind: "copy", sectionId: "hero", fieldId: "hero-lede", prompt: "x", tool: "hand-built", engine: "fake" }));
  assert.equal(done.state, "failed");
  assert.match(done.message, /copy lint/);
  f = (await bad.storage.readProject()).fields["hero-lede"];
  assert.equal(f.versions.at(-1).kind, "failed");
  assert.equal(f.versions.length, 2);
  assert.equal(f.currentVersionId, f.versions[0].id, "current copy is unchanged");
});

test("demo engine shortens copy, and refuses what it cannot do", async () => {
  const { jobs, storage } = await setup({});
  let done = await finalJob(jobs, await jobs.submit({ kind: "copy", sectionId: "hero", fieldId: "hero-lede", prompt: "shorter", tool: "hand-built", engine: "template-demo" }));
  assert.equal(done.state, "succeeded");
  assert.equal((await storage.readProject()).fields["hero-lede"].versions.at(-1).text, "From idea to part to assembly to shelf.");
  done = await finalJob(jobs, await jobs.submit({ kind: "copy", sectionId: "hero", fieldId: "hero-eyebrow", prompt: "make it poetic", tool: "hand-built", engine: "template-demo" }));
  assert.equal(done.state, "failed");
});

test("validation: unknown section, field, tool, engine, empty copy instruction", async () => {
  const { jobs } = await setup({});
  await assert.rejects(jobs.submit(params({ sectionId: "nope" })), /Unknown section/);
  await assert.rejects(jobs.submit(params({ tool: "nope" })), /Unknown tool/);
  await assert.rejects(jobs.submit(params({ engine: "nope" })), /Unknown engine/);
  await assert.rejects(jobs.submit({ kind: "copy", sectionId: "hero", fieldId: "ch3-headline", prompt: "x", tool: "hand-built", engine: "fake" }), /Unknown field/);
  await assert.rejects(jobs.submit({ kind: "copy", sectionId: "hero", fieldId: "hero-lede", prompt: "  ", tool: "hand-built", engine: "fake" }), /instruction/);
  await assert.rejects(jobs.submit(params({ prompt: "x".repeat(8001) })), /longer/);
});

test("a tool whose skill folder is missing blocks skill engines with a specific message", async () => {
  const dir = tmpDir();
  const storage = withAppendVersion(createFsStorage({ dataDir: dir }));
  await storage.initProject(freshProject());
  const fakeSkill = { ...createFakeEngine({}), id: "fake", usesSkills: true };
  const jobs = new JobManager({ storage, engines: { fake: fakeSkill }, config, localToolStatus: (t) => localToolStatus(t) });
  const done = await finalJob(jobs, await jobs.submit(params({ tool: "anatomy" })));
  assert.equal(done.state, "blocked");
  assert.match(done.message, /Anatomy is unavailable/);
  assert.match(done.message, /studio skills folder/);
});

// ---- claude-cli engine ----
test("claude-cli: not logged in => BLOCKED with the exact message and no process spawned", async () => {
  let spawned = 0;
  const cli = createClaudeCliEngine({ probe: async () => ({ installed: true, loggedIn: false }), spawnImpl: () => { spawned++; throw new Error("must not spawn"); } });
  const dir = tmpDir();
  const storage = withAppendVersion(createFsStorage({ dataDir: dir }));
  await storage.initProject(freshProject());
  const jobs = new JobManager({ storage, engines: { "claude-cli": cli }, config });
  const done = await finalJob(jobs, await jobs.submit(params({ engine: "claude-cli" })));
  assert.equal(done.state, "blocked");
  assert.equal(done.message, "Claude CLI is not logged in: run `claude auth login`");
  assert.equal(done.message, NOT_LOGGED_IN);
  assert.equal(spawned, 0);
  assert.equal((await storage.readProject()).assets["asset-ch3"].versions.length, 0);
});

test("claude-cli: missing binary is blocked too, and hosted marks it unavailable", async () => {
  assert.deepEqual(await createClaudeCliEngine({ probe: async () => ({ installed: false, loggedIn: false }) }).available(), { ok: false, message: NOT_INSTALLED });
  const hosted = createEngines({ mode: "hosted", storage: { kind: "fs" } });
  const av = await hosted["claude-cli"].available();
  assert.equal(av.ok, false);
  assert.match(av.message, /runs only on a machine with the CLI/);
  assert.equal((await hosted["template-demo"].available()).ok, true);
});

test("claude-cli: argument vector, restricted tools, variadic add-dir last", () => {
  const args = buildArgs({ brief: "BRIEF", model: "opus", skillDir: "/skills/x", kind: "asset", maxBudgetUsd: 3 });
  assert.deepEqual(args.slice(0, 7), ["-p", "BRIEF", "--no-session-persistence", "--output-format", "json", "--model", "opus"]);
  assert.equal(args[args.indexOf("--allowedTools") + 1], "Read,Write,Edit,Glob,Grep");
  assert.deepEqual(args.slice(-2), ["--add-dir", "/skills/x"]);
  assert.equal(buildArgs({ brief: "b", kind: "copy" })[buildArgs({ brief: "b", kind: "copy" }).indexOf("--allowedTools") + 1], "Read");
  assert.ok(!args.some((a) => /Bash|WebFetch|WebSearch/.test(a)));
});

function fakeSpawn({ stdout, code = 0, write }) {
  return (_bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    setImmediate(() => {
      if (write) fs.writeFileSync(path.join(opts.cwd, "index.html"), write);
      child.stdout.emit("data", stdout);
      child.exitCode = code;
      child.emit("close", code);
    });
    child.args = args;
    return child;
  };
}

test("claude-cli: success path returns the modelUsage receipt (fake spawn)", async () => {
  const result = JSON.stringify({ is_error: false, result: "done", modelUsage: { "claude-sonnet-x": { costUSD: 0.12 } }, total_cost_usd: 0.12, duration_ms: 900, num_turns: 3 });
  const cli = createClaudeCliEngine({ probe: async () => ({ installed: true, loggedIn: true }), spawnImpl: fakeSpawn({ stdout: result, write: demoAssetHtml({ section: { label: "S" }, prompt: "p", tool: "t" }) }) });
  const dir = tmpDir();
  const storage = withAppendVersion(createFsStorage({ dataDir: dir }));
  await storage.initProject(freshProject());
  const jobs = new JobManager({ storage, engines: { "claude-cli": cli }, config });
  const done = await finalJob(jobs, await jobs.submit(params({ engine: "claude-cli" })));
  assert.equal(done.state, "succeeded");
  const v = (await storage.readProject()).assets["asset-ch3"].versions[0];
  assert.equal(v.model, "claude-sonnet-x");
  assert.equal(v.usage.total_cost_usd, 0.12);
});

test("claude-cli: error JSON becomes failed; copy output is parsed strictly", async () => {
  const cli = createClaudeCliEngine({ probe: async () => ({ installed: true, loggedIn: true }), spawnImpl: fakeSpawn({ stdout: JSON.stringify({ is_error: true, result: "rate limited" }), code: 1 }) });
  const dir = tmpDir();
  const storage = withAppendVersion(createFsStorage({ dataDir: dir }));
  await storage.initProject(freshProject());
  const jobs = new JobManager({ storage, engines: { "claude-cli": cli }, config });
  const done = await finalJob(jobs, await jobs.submit(params({ engine: "claude-cli" })));
  assert.equal(done.state, "failed");
  assert.match(done.message, /rate limited/);
  assert.equal(parseCopyResult('```json\n{"text":"Hi there"}\n```'), "Hi there");
  assert.throws(() => parseCopyResult("just prose"), /JSON/);
});

test("brief carries the skill entry, copy, prompt, contract and wording rules", () => {
  const b = buildBrief({ kind: "asset", tool: { entryPath: "/s/anatomy/SKILL.md" }, section: { label: "Chapter 3" }, currentCopy: [{ label: "Headline", text: "Agents turn drawings into quotes" }], prompt: "Show a scanner", budget: { minutes: 20, usd: 3 } });
  assert.match(b, /\/s\/anatomy\/SKILL\.md/);
  assert.match(b, /Agents turn drawings into quotes/);
  assert.match(b, /Show a scanner/);
  assert.match(b, /prefers-reduced-motion/);
  assert.match(b, /data-theme/);
  assert.match(b, /Live in Founding Beta/);
  assert.match(b, /20 minutes/);
  assert.equal(WORDING_RULES.length >= 9, true);
  assert.match(buildBrief({ kind: "asset", tool: null, section: { label: "S" }, prompt: "x" }), /No skill is selected/);
  assert.equal(toolPaths({ id: "t", resolvedPath: "/a", entry: "SKILL.md" }).entryPath, "/a/SKILL.md");
});

test("config: tool status, pinned sources, nothing vendored", () => {
  assert.equal(localToolStatus(config.tools.find((t) => t.id === "hand-built")).ok, true);
  const any = config.tools.find((t) => t.id === "machine");
  assert.equal(localToolStatus(any, fs).ok, false);
  assert.equal(remoteToolStatus(any).ok, true);
  assert.equal(remoteToolStatus({ ...any, source: { type: "git", commit: "main" } }).ok, false);
  assert.equal(remoteToolStatus({ ...any, source: { type: "zip", sha256: "" } }).ok, false);
  assert.deepEqual(config.tools.map((t) => t.id), ["hand-built", "anatomy", "anatomy-asset", "isoglow", "machine"]);
  assert.equal(config.tools.filter((t) => t.skillPath && !t.skillPath.startsWith("~/.homepage-studio/skills/")).length, 0);
});

test("asset contract check", () => {
  assert.deepEqual(checkAsset(demoAssetHtml({ section: { label: "S" }, prompt: "", tool: "t" })), []);
  assert.ok(checkAsset("<html><body><script src=\"https://cdn.example/x.js\"></script></body></html>").some((p) => /external URL/.test(p)));
  assert.ok(checkAsset(demoAssetHtml({ section: { label: "S" }, prompt: "", tool: "t" }).replace("</body>", "<script>fetch('/x')</script></body>")).some((p) => /network/.test(p)));
  assert.ok(checkAsset("").length > 0);
});

// ---- hosted: github-actions engine ----
function hostedMgr(gh, cfg = config) {
  const storage = withAppendVersion(createGithubStorage({ repo: gh.repo, token: "t", fetchImpl: gh.fetch }));
  const engines = createEngines({ mode: "hosted", storage });
  return { storage, jobs: new JobManager({ storage, engines, config: cfg, awaitInline: true }) };
}
const ghParams = (o = {}) => ({ kind: "asset", sectionId: "ch2", prompt: "PRIVATE-PROMPT-TEXT", tool: "machine", engine: "github-actions", model: "sonnet", ...o });

test("github-actions: queues a job file in the data repo, then dispatches without the prompt", async () => {
  const gh = githubWithProject();
  const { jobs } = hostedMgr(gh);
  const job = await jobs.submit(ghParams());
  assert.equal(job.state, "queued");
  const file = JSON.parse(gh.file(`jobs/${job.id}.json`));
  assert.equal(file.prompt, "PRIVATE-PROMPT-TEXT", "the prompt is committed in the job file");
  assert.equal(gh.dispatches.length, 1);
  assert.deepEqual(Object.keys(gh.dispatches[0].inputs).sort(), ["engine", "jobId", "promptRef", "section", "tool"]);
  assert.equal(gh.dispatches[0].inputs.promptRef, `jobs/${job.id}.json`);
  assert.ok(!JSON.stringify(gh.dispatches).includes("PRIVATE-PROMPT-TEXT"), "prompt never goes through workflow inputs");
  assert.match(gh.commitMessages().join("|"), /studio: queued asset ch2/);
});

test("github-actions: job state follows the workflow run", async () => {
  const gh = githubWithProject();
  const { jobs } = hostedMgr(gh);
  const job = await jobs.submit(ghParams());
  gh.runs.push({ id: 1, status: "in_progress", conclusion: null, display_title: `studio ${job.id}`, html_url: "https://example/run/1" });
  let g = await jobs.get(job.id);
  assert.equal(g.state, "running");
  assert.equal(g.runUrl, "https://example/run/1");
  gh.runs[0] = { ...gh.runs[0], status: "completed", conclusion: "failure" };
  g = await jobs.get(job.id);
  assert.equal(g.state, "failed");
  assert.match(g.message, /failure/);
  assert.match(g.recovery, /Retry/);
  gh.runs[0] = { ...gh.runs[0], conclusion: "timed_out" };
  assert.equal((await jobs.get(job.id)).state, "timed_out");
  gh.runs[0] = { ...gh.runs[0], conclusion: "cancelled" };
  assert.equal((await jobs.get(job.id)).state, "cancelled");
});

test("github-actions: dispatch permission error leaves a blocked job with the reason", async () => {
  const gh = githubWithProject();
  gh.failures.push({ status: 403, message: "Resource not accessible", persist: true, match: (m, p) => m === "POST" && p.includes("/dispatches") });
  const { jobs } = hostedMgr(gh);
  const job = await jobs.submit(ghParams());
  assert.equal(job.state, "blocked");
  assert.match(job.message, /Could not start the worker/);
  assert.match(job.message, /Actions: write/);
  assert.equal(JSON.parse(gh.file(`jobs/${job.id}.json`)).state, "blocked");
});

test("github-actions: unpinned tool source is blocked before anything is queued", async () => {
  const gh = githubWithProject();
  const cfg = { ...config, tools: config.tools.map((t) => (t.id === "machine" ? { ...t, source: { type: "git", repo: "https://github.com/a/b", commit: "main" } } : t)) };
  const { jobs } = hostedMgr(gh, cfg);
  const job = await jobs.submit(ghParams());
  assert.equal(job.state, "blocked");
  assert.match(job.message, /not pinned/);
  assert.equal(gh.dispatches.length, 0);
});

test("github-actions is blocked with a specific reason when no data repo is configured", async () => {
  const dir = tmpDir();
  const storage = withAppendVersion(createFsStorage({ dataDir: dir }));
  await storage.initProject(freshProject());
  const jobs = new JobManager({ storage, engines: createEngines({ mode: "hosted", storage }), config });
  const job = await jobs.submit(ghParams());
  assert.equal(job.state, "blocked");
  assert.match(job.message, /STUDIO_DATA_REPO and GITHUB_TOKEN/);
});

// ---- worker core (runs in the Actions runner) ----
async function workerSetup() {
  const dir = tmpDir();
  const storage = withAppendVersion(createFsStorage({ dataDir: dir }));
  await storage.initProject(freshProject());
  const job = { id: "jobw1", versionId: "verw1", kind: "asset", sectionId: "ch4", target: "asset:ch4", prompt: "from the data repo", tool: "hand-built", engine: "github-actions", model: "sonnet", state: "queued", createdAt: new Date().toISOString() };
  await storage.writeJob(job);
  const pushes = [];
  const git = { async commitPush(m) { pushes.push(m); return { ok: true }; }, async resetToRemote() {} };
  return { dir, storage, git, pushes };
}

test("worker: without any model credential the job is BLOCKED with the exact message and nothing is generated", async () => {
  const w = await workerSetup();
  const out = await runWorkerJob({ dataDir: w.dir, jobId: "jobw1", env: { GITHUB_TOKEN: "x" }, config, git: w.git, fetchSkill: async () => { throw new Error("no"); }, engineFactory: () => { throw new Error("engine must not be built"); } });
  assert.equal(out.state, "blocked");
  assert.equal(out.message, "No model credential configured in the data repo: add ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN");
  assert.equal(out.message, NO_CREDENTIAL);
  assert.equal((await w.storage.readProject()).assets["asset-ch4"].versions.length, 0);
  assert.equal((await w.storage.readJob("jobw1")).state, "blocked");
  assert.match(w.pushes[0], /^studio: blocked ch4/);
});

test("worker: with a credential it runs the engine, records the version, commits once", async () => {
  const w = await workerSetup();
  const out = await runWorkerJob({ dataDir: w.dir, jobId: "jobw1", env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" }, config, git: w.git, fetchSkill: async () => "/x", engineFactory: () => ({ ...createFakeEngine({ behavior: "success" }), id: "claude-cli" }) });
  assert.equal(out.state, "succeeded");
  assert.deepEqual(w.pushes, [`studio: generated ch4 verw1`]);
  const v = (await w.storage.readProject()).assets["asset-ch4"].versions[0];
  assert.equal(v.id, "verw1");
  assert.equal(v.prompt, "from the data repo");
  assert.equal((await w.storage.readJob("jobw1")).state, "succeeded");
});

test("worker: a rejected push resets to the remote and re-applies the result", async () => {
  const w = await workerSetup();
  let n = 0;
  let resets = 0;
  const snap = { project: fs.readFileSync(path.join(w.dir, "project.json")), job: fs.readFileSync(path.join(w.dir, "jobs/jobw1.json")) };
  const git = {
    async commitPush() { return ++n === 1 ? { ok: false, rejected: true } : { ok: true }; },
    async resetToRemote() {
      resets++; // what `git reset --hard origin/main` does: back to the remote state
      fs.writeFileSync(path.join(w.dir, "project.json"), snap.project);
      fs.writeFileSync(path.join(w.dir, "jobs/jobw1.json"), snap.job);
      fs.rmSync(path.join(w.dir, "versions"), { recursive: true, force: true });
    },
  };
  const out = await runWorkerJob({ dataDir: w.dir, jobId: "jobw1", env: { ANTHROPIC_API_KEY: "k" }, config, git, fetchSkill: async () => "/x", engineFactory: () => ({ ...createFakeEngine({}), id: "claude-cli" }) });
  assert.equal(out.state, "succeeded");
  assert.equal(resets, 1);
  assert.equal(n, 2);
  assert.equal((await w.storage.readProject()).assets["asset-ch4"].versions.length, 1, "applied once, not twice");
});

test("worker: skill fetch failure fails closed; finished jobs are skipped; model env never holds the GitHub token", async () => {
  const w = await workerSetup();
  const out = await runWorkerJob({ dataDir: w.dir, jobId: "jobw1", env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" }, config: { ...config }, git: w.git, fetchSkill: async () => { throw new Error("sha mismatch"); }, engineFactory: () => ({ ...createFakeEngine({}), id: "claude-cli" }) });
  assert.equal(out.state, "succeeded", "hand-built has no skill source, so no fetch happens");
  const w2 = await workerSetup();
  const job2 = { id: "jobw2", versionId: "verw2", kind: "asset", sectionId: "ch5", prompt: "p", tool: "machine", engine: "github-actions", model: "sonnet", state: "queued", createdAt: new Date().toISOString() };
  await w2.storage.writeJob(job2);
  const out2 = await runWorkerJob({ dataDir: w2.dir, jobId: "jobw2", env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" }, config, git: w2.git, fetchSkill: async () => { throw new Error("zip sha256 mismatch"); } });
  assert.equal(out2.state, "failed");
  assert.match(out2.message, /closed/);
  assert.match(out2.message, /sha256 mismatch/);
  assert.deepEqual((await runWorkerJob({ dataDir: w2.dir, jobId: "jobw2", env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" }, config, git: w2.git, fetchSkill: async () => "/x" })).skipped, true);
  const env = scrubbedEnv({ PATH: "/bin", HOME: "/h", GITHUB_TOKEN: "ghs_secret", CLAUDE_CODE_OAUTH_TOKEN: "tok", RANDOM: "x" });
  assert.deepEqual(Object.keys(env).sort(), ["CLAUDE_CODE_OAUTH_TOKEN", "HOME", "PATH"]);
  assert.equal(hasCredential({}), false);
  assert.equal(hasCredential({ ANTHROPIC_API_KEY: " " }), false);
});
