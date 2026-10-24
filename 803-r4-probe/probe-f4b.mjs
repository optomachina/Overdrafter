import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const SCRIPT = path.resolve(process.argv[2]);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
Object.assign(env, { GIT_AUTHOR_NAME: "qa", GIT_AUTHOR_EMAIL: "qa@x", GIT_COMMITTER_NAME: "qa", GIT_COMMITTER_EMAIL: "qa@x" });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa803f4-")); const repo = path.join(dir, "r"); fs.mkdirSync(repo);
const g = (...a) => execFileSync("git", ["-C", repo, ...a], { env, encoding: "utf8" }).trim();
const commit = (f, c, m) => { fs.writeFileSync(path.join(repo, f), c); g("add", f); g("commit", "-q", "-m", m); return g("rev-parse", "HEAD"); };
const cli = (a) => { const r = spawnSync("node", [SCRIPT, ...a], { encoding: "utf8", env }); let j = null; try { j = JSON.parse(r.stdout); } catch {} return { code: r.status, j, err: r.stderr.split("\n")[0] }; };
const W = (n, v) => { const p = path.join(dir, n); fs.writeFileSync(p, JSON.stringify(v)); return p; };
g("init", "-q", "-b", "main"); g("config", "commit.gpgsign", "false"); commit("R", "x\n", "init"); const early = commit("e", "e\n", "early");
const base = commit("f", "f\n", "base");
g("checkout", "-q", "-b", "pr1"); const h1 = commit("a", "a\n", "a"); g("checkout", "-q", "-b", "pr2"); const h2 = commit("b", "b\n", "b"); g("checkout", "-q", "main");
g("merge", "-q", "--squash", "pr1"); g("commit", "-q", "-m", "s1"); const m1 = g("rev-parse", "HEAD");
g("merge", "-q", "--squash", "pr2"); g("commit", "-q", "-m", "s2"); const m2 = g("rev-parse", "HEAD");
const log = path.join(dir, "l.tsv"); cli(["init-log", "--log", log]);
const plan = cli(["plan", "--stack", W("s.json", { base, prs: [{ pr: 1, head_sha: h1 }, { pr: 2, head_sha: h2 }] }), "--verdicts", W("v.json", { 1: { sha: h1, verdict_ref: "v1", valid: true }, 2: { sha: h2, verdict_ref: "v2", valid: true } }), "--log", log]).j;
for (const [name, p] of Object.entries({ "base->early(ancestor)": { ...plan, base: early }, "stop-added": { ...plan, stop: { pr: 3, head_sha: h2, verdict_ref: "v3", reason: "x" } } })) {
  const before = fs.readFileSync(log, "utf8");
  const r = cli(["readback-run", "--repo", repo, "--merges", W("m.json", [{ pr: 1, merge_sha: m1 }, { pr: 2, merge_sha: m2 }]), "--plan", W("p.json", p), "--log", log]);
  console.log(`F4b ${name} merges=[1,2]: code=${r.code} refused=${r.j?.refused} stop=${r.j?.stop?.reason} landed=${r.j?.landed?.length} log_unchanged=${before === fs.readFileSync(log, "utf8")}`);
  fs.writeFileSync(log, before);
}
