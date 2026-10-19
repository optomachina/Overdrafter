import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createFsStorage } from "../lib/storage/fs.mjs";
import { createGithubStorage } from "../lib/storage/github.mjs";
import { withAppendVersion, createStorage } from "../lib/storage/index.mjs";
import { StorageError } from "../lib/storage/common.mjs";
import { appendVersion } from "../lib/ops.mjs";
import { freshProject, tmpDir, createFakeGithub, githubWithProject } from "./helpers.mjs";

async function fsStore() {
  const dir = tmpDir();
  const s = withAppendVersion(createFsStorage({ dataDir: dir }));
  await s.initProject(freshProject());
  return { s, dir };
}

test("fs: concurrent saves are serialized and none is lost", async () => {
  const { s, dir } = await fsStore();
  await Promise.all(Array.from({ length: 25 }, (_, i) => s.appendVersion({ entity: "field", id: "hero-lede", partial: { kind: "manual", text: `edit ${i}` } })));
  const p = await s.readProject();
  assert.equal(p.fields["hero-lede"].versions.length, 26);
  const texts = new Set(p.fields["hero-lede"].versions.map((v) => v.text));
  for (let i = 0; i < 25; i++) assert.ok(texts.has(`edit ${i}`));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "no temp files left behind");
  JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
});

test("fs: a failing update leaves the file untouched and the queue alive", async () => {
  const { s } = await fsStore();
  const before = JSON.stringify(await s.readProject());
  await assert.rejects(s.update("bad", (d) => {
    d.fields["hero-lede"].versions[0].text = "rewrite";
  }), /rewritten/);
  await assert.rejects(s.update("bad2", (d) => {
    d.fields["hero-lede"].versions.length = 0;
  }));
  assert.equal(JSON.stringify(await s.readProject()), before);
  await s.appendVersion({ entity: "field", id: "hero-lede", partial: { kind: "manual", text: "still works" } });
  assert.equal((await s.readProject()).fields["hero-lede"].versions.length, 2);
});

test("fs: assets are append-only and paths are validated", async () => {
  const { s } = await fsStore();
  const rec = await s.appendVersion({ entity: "asset", id: "asset-ch1", partial: { id: "aaa", kind: "generated", assetPath: "versions/ch1/aaa/index.html" }, files: [{ path: "versions/ch1/aaa/index.html", content: "<html>1</html>" }] });
  assert.equal(rec.id, "aaa");
  assert.equal((await s.readAsset("versions/ch1/aaa/index.html")).toString(), "<html>1</html>");
  await assert.rejects(s.update("x", () => ({ files: [{ path: "versions/ch1/aaa/index.html", content: "<html>2</html>" }] })), /append-only/);
  await assert.rejects(s.update("x", () => ({ files: [{ path: "../escape.txt", content: "x" }] })), /not allowed/);
  await assert.rejects(s.readAsset("../../etc/passwd"), /not allowed/);
  assert.equal(await s.readAsset("versions/ch1/zzz/index.html"), null);
});

test("fs: jobs are stored and listed newest first", async () => {
  const { s } = await fsStore();
  const mk = (id) => ({ id, kind: "asset", sectionId: "ch1", state: "queued", prompt: "", engine: "template-demo", tool: "hand-built", createdAt: new Date().toISOString() });
  await s.writeJob(mk("aaa1"));
  await s.writeJob(mk("bbb2"));
  assert.deepEqual((await s.listJobs()).map((j) => j.id), ["bbb2", "aaa1"]);
  assert.equal((await s.readJob("aaa1")).id, "aaa1");
  assert.equal(await s.readJob("nope"), null);
});

// ---- github adapter with a fake fetch ----
const mkGh = (gh, extra = {}) => withAppendVersion(createGithubStorage({ repo: gh.repo, branch: gh.branch, token: "tkn", fetchImpl: gh.fetch, ...extra }));

test("github: one append is exactly one commit with the studio message and bearer auth", async () => {
  const gh = githubWithProject();
  const s = mkGh(gh);
  const rec = await s.appendVersion({
    entity: "asset", id: "asset-ch3", label: "generated ch3 abc",
    partial: { id: "abc", kind: "generated", assetPath: "versions/ch3/abc/index.html" },
    files: [{ path: "versions/ch3/abc/index.html", content: "<html>x</html>" }],
  });
  assert.equal(rec.id, "abc");
  assert.deepEqual(gh.commitMessages(), ["studio: generated ch3 abc"]);
  assert.equal(gh.file("versions/ch3/abc/index.html"), "<html>x</html>");
  assert.equal(JSON.parse(gh.file("project.json")).assets["asset-ch3"].versions.length, 1);
  assert.ok(gh.calls.every((c) => c.auth === "Bearer tkn"));
  assert.ok(!gh.calls.some((c) => c.method === "PATCH" && c.body.force), "never forced");
  assert.ok(!gh.calls.some((c) => c.method === "DELETE"), "never deletes");
  assert.equal((await s.readAsset("versions/ch3/abc/index.html")).toString(), "<html>x</html>");
  assert.equal((await s.listVersions("asset", "asset-ch3")).length, 1);
});

test("github: ref conflict (422) retries against the latest head and merges both writes", async () => {
  const gh = githubWithProject();
  const s = mkGh(gh);
  gh.beforePatch = () => {
    // Another writer lands first: bump project.json with a different field edit.
    const p = JSON.parse(gh.file("project.json"));
    appendVersion(p.fields["hero-eyebrow"], { kind: "manual", text: "Other writer" });
    gh.externalCommit("project.json", JSON.stringify(p));
  };
  await s.appendVersion({ entity: "field", id: "hero-lede", partial: { kind: "manual", text: "Mine" } });
  const final = JSON.parse(gh.file("project.json"));
  assert.equal(final.fields["hero-lede"].versions.length, 2, "my write landed");
  assert.equal(final.fields["hero-eyebrow"].versions.length, 2, "the other writer's edit survived");
  assert.equal(gh.calls.filter((c) => c.method === "PATCH").length, 2, "one retry");
});

test("github: gives up after 3 retries with a conflict_exhausted state", async () => {
  const gh = githubWithProject();
  const s = mkGh(gh);
  gh.failures.push({ persist: true, status: 422, message: "Update is not a fast forward", match: (m, p) => m === "PATCH" && p.includes("/git/refs/") });
  await assert.rejects(s.appendVersion({ entity: "field", id: "hero-lede", partial: { kind: "manual", text: "x" } }), (e) => e instanceof StorageError && e.code === "conflict_exhausted");
  assert.equal(gh.calls.filter((c) => c.method === "PATCH").length, 4, "first try plus 3 retries");
});

test("github: error states are specific (401, 403, rate limit, 404, empty repo)", async () => {
  const run = async (status, headers, message, match) => {
    const gh = githubWithProject();
    gh.failures.push({ status, headers, message, persist: true, match: match || ((m, p) => p.startsWith("/git/ref/")) });
    const s = mkGh(gh);
    try {
      await s.appendVersion({ entity: "field", id: "hero-lede", partial: { kind: "manual", text: "x" } });
    } catch (e) {
      return e;
    }
    return null;
  };
  const e401 = await run(401, {}, "Bad credentials");
  assert.equal(e401.code, "bad_credentials");
  assert.match(e401.message, /GITHUB_TOKEN/);
  const e403 = await run(403, {}, "Resource not accessible by personal access token");
  assert.equal(e403.code, "forbidden");
  assert.match(e403.message, /Contents/);
  const rl = await run(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1900000000" }, "API rate limit exceeded");
  assert.equal(rl.code, "rate_limited");
  assert.equal(rl.status, 429);
  assert.match(rl.message, /Resets at/);
  const e404 = await run(404, {}, "Not Found");
  assert.equal(e404.code, "not_found");
  const empty = await run(409, {}, "Git Repository is empty.");
  assert.equal(empty.code, "repo_not_ready");
});

test("github: missing project.json reports not_initialized; bad config is rejected", async () => {
  const gh = createFakeGithub({ files: { "README.md": "hi" } });
  const s = mkGh(gh);
  await assert.rejects(s.update("x", () => ({})), (e) => e.code === "not_initialized");
  assert.equal(await s.readProject(), null);
  assert.equal(await s.initProject(freshProject()), true);
  assert.equal(await s.initProject(freshProject()), false, "init never overwrites");
  assert.throws(() => createGithubStorage({ repo: "not a repo", token: "x", fetchImpl: gh.fetch }), /owner\/name/);
  assert.throws(() => createGithubStorage({ repo: "a/b", token: "", fetchImpl: gh.fetch }), /GITHUB_TOKEN/);
});

test("github: jobs round trip, dispatch and run lookup", async () => {
  const gh = githubWithProject();
  const s = mkGh(gh);
  const job = { id: "j1", kind: "asset", sectionId: "ch1", state: "queued", prompt: "secret prompt text", engine: "github-actions", tool: "hand-built", createdAt: new Date().toISOString() };
  await s.writeJob(job, "queued asset ch1 j1");
  assert.equal((await s.readJob("j1")).prompt, "secret prompt text");
  assert.deepEqual((await s.listJobs()).map((j) => j.id), ["j1"]);
  await s.dispatch({ jobId: "j1", section: "ch1" });
  assert.deepEqual(gh.dispatches[0], { workflow: "studio-generate.yml", ref: "main", inputs: { jobId: "j1", section: "ch1" } });
  gh.runs.push({ id: 7, status: "in_progress", conclusion: null, display_title: "studio j1", html_url: "https://example/run/7" });
  assert.deepEqual(await s.findRun("j1"), { id: 7, status: "in_progress", conclusion: null, url: "https://example/run/7" });
  assert.equal(await s.findRun("other"), null);
});

test("storage factory: hosted without a data repo uses flagged temporary storage; with one uses github", () => {
  const temp = createStorage({ env: {}, mode: "hosted", dataDir: "/x" });
  assert.equal(temp.kind, "fs");
  assert.equal(temp.ephemeral, true);
  const gh = createStorage({ env: { STUDIO_DATA_REPO: "o/r", GITHUB_TOKEN: "t" }, mode: "hosted", fetchImpl: async () => new Response("{}") });
  assert.equal(gh.kind, "github");
  const local = createStorage({ env: {}, mode: "local", dataDir: tmpDir() });
  assert.equal(local.kind, "fs");
  assert.equal(local.ephemeral, false);
});
