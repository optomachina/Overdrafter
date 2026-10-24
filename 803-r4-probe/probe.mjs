// QA r4 probes for PR #803 (OVD-857). Usage: node probe.mjs <path/to/merge-readback.mjs>
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const SCRIPT = path.resolve(process.argv[2]);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
Object.assign(env, { GIT_AUTHOR_NAME: "qa", GIT_AUTHOR_EMAIL: "qa@x", GIT_COMMITTER_NAME: "qa", GIT_COMMITTER_EMAIL: "qa@x" });
let repo, dir;
const g = (...a) => execFileSync("git", ["-C", repo, ...a], { env, encoding: "utf8", maxBuffer: 1 << 28 }).trim();
function fresh() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa803r4-")); repo = path.join(dir, "repo"); fs.mkdirSync(repo);
  g("init", "-q", "-b", "main"); g("config", "commit.gpgsign", "false");
  commit("README", "x\n", "init");
}
function commit(file, content, msg) { fs.writeFileSync(path.join(repo, file), content); g("add", file); g("commit", "-q", "-m", msg); return g("rev-parse", "HEAD"); }
function branch(name, from, file, content) { g("checkout", "-q", "-b", name, from); const h = commit(file, content, name); g("checkout", "-q", "main"); return h; }
function squash(name) { g("merge", "-q", "--squash", name); g("commit", "-q", "-m", `squash ${name}`); return g("rev-parse", "HEAD"); }
function cli(args) {
  const r = spawnSync("node", [SCRIPT, ...args], { encoding: "utf8", env, maxBuffer: 1 << 28 });
  let json = null; try { json = JSON.parse(r.stdout); } catch {}
  return { code: r.status, json, err: r.stderr.split("\n")[0] };
}
const W = (name, v) => { const p = path.join(dir, name); fs.writeFileSync(p, JSON.stringify(v)); return p; };
function plan(base, land, logName = "log.tsv", extra = []) {
  const log = path.join(dir, logName);
  cli(["init-log", "--log", log]);
  const stack = W("stack.json", { base, prs: land.map(([pr, h]) => ({ pr, head_sha: h })) });
  const verdicts = W("verdicts.json", Object.fromEntries(land.map(([pr, h]) => [pr, { sha: h, verdict_ref: `v${pr}`, valid: true }])));
  const r = cli(["plan", "--stack", stack, "--verdicts", verdicts, "--log", log, ...extra]);
  return { log, plan: r.json, planPath: W("plan.json", r.json), code: r.code };
}
const brief = (r) => JSON.stringify(r.json ? {
  code: r.code, refused: r.json.refused, landed: r.json.landed?.map((x) => `${x.pr}:${x.tree_match}:${x.reason}`),
  stop: r.json.stop ? `${r.json.stop.pr}:${r.json.stop.tree_match}:${r.json.stop.reason}` : r.json.stop,
  tree_match: r.json.tree_match, reason: r.json.reason, skipped: r.json.skipped, ok: r.json.ok, has_log_digest: "log_digest" in r.json,
} : { code: r.code, err: r.err });
const rows = (log) => fs.readFileSync(log, "utf8").trim().split("\n").slice(1).map((l) => l.split("\t"));
const out = (k, v) => console.log(`${k}: ${v}`);

// F2a: 5-line nearby-line repro (plan-bound readback-run)
fresh(); commit("f.txt", "1\n2\n3\n4\n5\n", "five");
{ const base = g("rev-parse", "main"); const h = branch("pr1", "main", "f.txt", "1\n2\n3\nfour\n5\n");
  commit("f.txt", "one\n2\n3\n4\n5\n", "main line1"); const m = squash("pr1");
  const p = plan(base, [[1, h]]); const r = cli(["readback-run", "--repo", repo, "--merges", W("m.json", [{ pr: 1, merge_sha: m }]), "--plan", p.planPath, "--log", p.log]);
  out("F2a nearby-line correct squash (readback-run)", brief(r));
  const p2 = plan(base, [[1, h]], "log2.tsv"); out("F2a nearby-line correct squash (readback --log --pr)", brief(cli(["readback", "--repo", repo, "--merge-sha", m, "--verified-head", h, "--log", p2.log, "--plan", p2.planPath, "--pr", "1"])));
  out("F2a nearby-line standalone readback", brief(cli(["readback", "--repo", repo, "--merge-sha", m, "--verified-head", h]))); }
// F2b: same but merge carries a real content difference
fresh(); commit("f.txt", "1\n2\n3\n4\n5\n", "five");
{ const base = g("rev-parse", "main"); const h = branch("pr1", "main", "f.txt", "1\n2\n3\nfour\n5\n");
  commit("f.txt", "one\n2\n3\n4\n5\n", "main line1"); g("merge", "-q", "--squash", "pr1");
  fs.writeFileSync(path.join(repo, "f.txt"), "one\n2\nthree\nfour\n5\n"); g("commit", "-q", "-a", "-m", "tampered squash"); const m = g("rev-parse", "HEAD");
  const p = plan(base, [[1, h]]); out("F2b tampered nearby squash (readback-run)", brief(cli(["readback-run", "--repo", repo, "--merges", W("m.json", [{ pr: 1, merge_sha: m }]), "--plan", p.planPath, "--log", p.log])));
  out("F2b tampered standalone", brief(cli(["readback", "--repo", repo, "--merge-sha", m, "--verified-head", h]))); }
// F2c: extra unrelated file rode along after main moved
fresh(); commit("f.txt", "1\n2\n3\n4\n5\n", "five");
{ const base = g("rev-parse", "main"); const h = branch("pr1", "main", "f.txt", "1\n2\n3\nfour\n5\n");
  commit("g.txt", "g\n", "main moved"); g("merge", "-q", "--squash", "pr1"); fs.writeFileSync(path.join(repo, "evil.txt"), "x\n"); g("add", "evil.txt"); g("commit", "-q", "-m", "squash+extra"); const m = g("rev-parse", "HEAD");
  const p = plan(base, [[1, h]]); out("F2c extra file rode along after main moved (readback-run)", brief(cli(["readback-run", "--repo", repo, "--merges", W("m.json", [{ pr: 1, merge_sha: m }]), "--plan", p.planPath, "--log", p.log]))); }

// F3: reversed landing: stack B->H1(+a)->H2(+b); main B->M2(+b)->M1(+a)
fresh();
{ const base = g("rev-parse", "main"); const h1 = branch("pr1", "main", "a.txt", "a\n"); const h2 = branch("pr2", "pr1", "b.txt", "b\n");
  const m2 = commit("b.txt", "b\n", "upper first"); const m1 = commit("a.txt", "a\n", "lower second");
  const p = plan(base, [[1, h1], [2, h2]]);
  const r = cli(["readback-run", "--repo", repo, "--merges", W("m.json", [{ pr: 1, merge_sha: m1 }, { pr: 2, merge_sha: m2 }]), "--plan", p.planPath, "--log", p.log]);
  out("F3 reversed landing, one run", brief(r) + " log_actions=" + rows(p.log).map((x) => `${x[5]}/${x[7]}`).join(","));
  const q = plan(base, [[1, h1], [2, h2]], "log2.tsv");
  const a = cli(["readback", "--repo", repo, "--merge-sha", m1, "--verified-head", h1, "--log", q.log, "--plan", q.planPath, "--pr", "1"]);
  const b = cli(["readback", "--repo", repo, "--merge-sha", m2, "--verified-head", h2, "--log", q.log, "--plan", q.planPath, "--pr", "2"]);
  out("F3 reversed landing, per-PR readback pr1", brief(a)); out("F3 reversed landing, per-PR readback pr2", brief(b)); }
// F3 control + behavior note 2: correct stacked landing B->H1->H2, squash M1 then M2
fresh();
let stackFx;
{ const base = g("rev-parse", "main"); const h1 = branch("pr1", "main", "a.txt", "a\n"); const h2 = branch("pr2", "pr1", "b.txt", "b\n");
  const m1 = squash("pr1"); g("checkout", "-q", "pr2"); g("rebase", "-q", "--onto", "main", "pr1"); g("checkout", "-q", "main");
  // squash the ORIGINAL h2 content onto main (main already has a): simulate GitHub squash of stacked pr2 after retarget
  g("merge", "-q", "--squash", "pr2"); g("commit", "-q", "-m", "squash pr2"); const m2 = g("rev-parse", "HEAD");
  const p = plan(base, [[1, h1], [2, h2]]);
  out("F3-control correct stacked landing, one run", brief(cli(["readback-run", "--repo", repo, "--merges", W("m.json", [{ pr: 1, merge_sha: m1 }, { pr: 2, merge_sha: m2 }]), "--plan", p.planPath, "--log", p.log])));
  const q = plan(base, [[1, h1], [2, h2]], "log2.tsv");
  out("F3-control per-PR pr1", brief(cli(["readback", "--repo", repo, "--merge-sha", m1, "--verified-head", h1, "--log", q.log, "--plan", q.planPath, "--pr", "1"])));
  out("F3-control per-PR pr2", brief(cli(["readback", "--repo", repo, "--merge-sha", m2, "--verified-head", h2, "--log", q.log, "--plan", q.planPath, "--pr", "2"])));
  out("BN2 standalone diagnostic readback (no --log) stacked pr2", brief(cli(["readback", "--repo", repo, "--merge-sha", m2, "--verified-head", h2])));
  const q3 = plan(base, [[1, h1], [2, h2]], "log3.tsv");
  out("BN2 --log path pr2 before pr1 read back", brief(cli(["readback", "--repo", repo, "--merge-sha", m2, "--verified-head", h2, "--log", q3.log, "--plan", q3.planPath, "--pr", "2"])));
  stackFx = { base, h1, h2, m1, m2 }; }
// BN2: tampered stacked pr2 (extra content), standalone and plan-bound
fresh();
{ const base = g("rev-parse", "main"); const h1 = branch("pr1", "main", "a.txt", "a\n"); const h2 = branch("pr2", "pr1", "b.txt", "b\n");
  const m1 = squash("pr1"); g("merge", "-q", "--squash", "pr2"); fs.writeFileSync(path.join(repo, "evil.txt"), "x\n"); g("add", "evil.txt"); g("commit", "-q", "-m", "pr2+extra"); const m2 = g("rev-parse", "HEAD");
  out("BN2 tampered stacked pr2 standalone", brief(cli(["readback", "--repo", repo, "--merge-sha", m2, "--verified-head", h2])));
  const p = plan(base, [[1, h1], [2, h2]]);
  out("BN2 tampered stacked pr2 readback-run", brief(cli(["readback-run", "--repo", repo, "--merges", W("m.json", [{ pr: 1, merge_sha: m1 }, { pr: 2, merge_sha: m2 }]), "--plan", p.planPath, "--log", p.log]))); }
// BN2: pr1 content differs on main (pr1 landed tampered then acked?) -> pr2 plan-bound must use H1 as base
fresh();
{ const base = g("rev-parse", "main"); const h1 = branch("pr1", "main", "a.txt", "a\n"); const h2 = branch("pr2", "pr1", "b.txt", "b\n");
  // PR2 squashed directly onto base carrying a+b without PR1 landing
  const m2 = squash("pr2");
  out("BN2 pr2 squashed without pr1 (standalone diagnostic)", brief(cli(["readback", "--repo", repo, "--merge-sha", m2, "--verified-head", h2])));
  const p = plan(base, [[1, h1], [2, h2]]);
  out("BN2 pr2 squashed without pr1 (readback-run merges=[pr2])", brief(cli(["readback-run", "--repo", repo, "--merges", W("m.json", [{ pr: 2, merge_sha: m2 }]), "--plan", p.planPath, "--log", p.log]))); }

// F4: plan.json edited (lower PR deleted / base changed / stop changed)
fresh();
{ const base = g("rev-parse", "main"); const h1 = branch("pr1", "main", "a.txt", "a\n"); const h2 = branch("pr2", "pr1", "b.txt", "b\n");
  const m1 = squash("pr1"); const m2 = squash("pr2");
  const p = plan(base, [[1, h1], [2, h2]]);
  const variants = { "lower-deleted": { ...p.plan, land: p.plan.land.slice(1) }, "base-changed": { ...p.plan, base: m1 }, "land-reordered": { ...p.plan, land: [...p.plan.land].reverse() } };
  for (const [name, edited] of Object.entries(variants)) {
    const pp = W(`plan-${name}.json`, edited); const before = fs.readFileSync(p.log, "utf8");
    const r1 = cli(["readback-run", "--repo", repo, "--merges", W("m.json", [{ pr: 2, merge_sha: m2 }]), "--plan", pp, "--log", p.log]);
    const r2 = cli(["readback", "--repo", repo, "--merge-sha", m2, "--verified-head", h2, "--log", p.log, "--plan", pp, "--pr", "2"]);
    out(`F4 ${name}`, `readback-run=${brief(r1)} readback=${brief(r2)} log_unchanged=${before === fs.readFileSync(p.log, "utf8")}`);
    if (before !== fs.readFileSync(p.log, "utf8")) { fs.writeFileSync(p.log, before); }
  }
  out("F4 control: unedited plan", brief(cli(["readback-run", "--repo", repo, "--merges", W("m.json", [{ pr: 1, merge_sha: m1 }, { pr: 2, merge_sha: m2 }]), "--plan", p.planPath, "--log", p.log]))); }

// F5: digest after every append
fresh();
{ const base = g("rev-parse", "main"); const h = branch("pr1", "main", "a.txt", "a\n"); g("merge", "-q", "--squash", "pr1"); fs.writeFileSync(path.join(repo, "evil.txt"), "x\n"); g("add", "."); g("commit", "-q", "-m", "bad"); const m = g("rev-parse", "HEAD");
  const d0 = path.join(dir, "d0.json"), d1 = path.join(dir, "d1.json");
  const p = plan(base, [[1, h]], "log.tsv", ["--digest-out", d0]);
  out("F5 plan --digest-out wrote d0", fs.existsSync(d0));
  const r = cli(["readback-run", "--repo", repo, "--merges", W("m.json", [{ pr: 1, merge_sha: m }]), "--plan", p.planPath, "--log", p.log, "--prior", d0, "--digest-out", d1]);
  out("F5 failing readback-run --prior d0 --digest-out d1", brief(r) + ` d1_written=${fs.existsSync(d1)}`);
  if (!fs.existsSync(d1)) fs.writeFileSync(d1, JSON.stringify(cli(["digest", "--log", p.log]).json));
  const orig = fs.readFileSync(p.log, "utf8");
  const flipped = orig.replace(/\tfalse\tSTOP [^\n]*/, "\ttrue\tlanded (rebased)");
  fs.writeFileSync(p.log, flipped);
  out("F5 flipped (len-changing) verify-log --prior d0(plan-time)", brief(cli(["verify-log", "--log", p.log, "--prior", d0])));
  out("F5 flipped (len-changing) verify-log --prior d1(post-readback)", brief(cli(["verify-log", "--log", p.log, "--prior", d1])));
  out("F5 flipped readback-run --prior d1", brief(cli(["readback-run", "--repo", repo, "--merges", W("m.json", [{ pr: 1, merge_sha: m }]), "--plan", p.planPath, "--log", p.log, "--prior", d1])));
  // same-length flip: "false"->"true " is not valid; instead change one hex char of merge_sha in the readback row
  const same = orig.replace(/(\treadback\t)([0-9a-f])/, (s, a, c) => a + (c === "0" ? "1" : "0"));
  fs.writeFileSync(p.log, same);
  out("F5 same-length rewrite verify-log --prior d1", brief(cli(["verify-log", "--log", p.log, "--prior", d1])));
  fs.writeFileSync(p.log, orig);
  out("F5 untouched verify-log --prior d1", brief(cli(["verify-log", "--log", p.log, "--prior", d1])));
  out("F5 stop-ack prints log_digest", brief(cli(["stop-ack", "--log", p.log, "--pr", "1", "--by", "Blaine", "--note", "qa", "--prior", d1, "--digest-out", path.join(dir, "d2.json")]))); }

// F7: ~2.4 MB diff
fresh();
{ const base = g("rev-parse", "main"); const big = Array.from({ length: 60000 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n") + "\n";
  const h = branch("pr1", "main", "big.txt", big); commit("other.txt", "o\n", "main moved"); const m = squash("pr1");
  const p = plan(base, [[1, h]]);
  out("F7 ~2.4MB diff readback-run", brief(cli(["readback-run", "--repo", repo, "--merges", W("m.json", [{ pr: 1, merge_sha: m }]), "--plan", p.planPath, "--log", p.log])));
  out("F7 ~2.4MB diff standalone", brief(cli(["readback", "--repo", repo, "--merge-sha", m, "--verified-head", h]))); }
