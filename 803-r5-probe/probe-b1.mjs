// QA r5 B1 probe: follow land skill step 12 literally. Usage: node probe-b1.mjs <merge-readback.mjs>
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const SCRIPT = path.resolve(process.argv[2]);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
Object.assign(env, { GIT_AUTHOR_NAME: "qa", GIT_AUTHOR_EMAIL: "qa@x", GIT_COMMITTER_NAME: "qa", GIT_COMMITTER_EMAIL: "qa@x" });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa803r5-")); const repo = path.join(dir, "repo"); fs.mkdirSync(repo);
const g = (...a) => execFileSync("git", ["-C", repo, ...a], { env, encoding: "utf8" }).trim();
const commit = (f, c, m) => { fs.writeFileSync(path.join(repo, f), c); g("add", f); g("commit", "-q", "-m", m); return g("rev-parse", "HEAD"); };
const cli = (a) => { const r = spawnSync("node", [SCRIPT, ...a], { encoding: "utf8", env }); let j = null; try { j = JSON.parse(r.stdout); } catch {} return { code: r.status, j, err: r.stderr.split("\n")[0] }; };
const P = (n) => path.join(dir, n); const W = (n, v) => (fs.writeFileSync(P(n), JSON.stringify(v)), P(n));
const sz = () => fs.statSync(P("log.tsv")).size;
g("init", "-q", "-b", "main"); g("config", "commit.gpgsign", "false"); const base = commit("README", "x\n", "init");
g("checkout", "-q", "-b", "pr1"); const h1 = commit("a.txt", "a\n", "pr1"); g("checkout", "-q", "-b", "pr2"); const h2 = commit("b.txt", "b\n", "pr2"); g("checkout", "-q", "main");
g("merge", "-q", "--squash", "pr1"); fs.writeFileSync(path.join(repo, "rider.txt"), "r\n"); g("add", "rider.txt"); g("commit", "-q", "-m", "PR1 + rider"); const m1 = g("rev-parse", "HEAD");
g("merge", "-q", "--squash", "pr2"); g("commit", "-q", "-m", "PR2"); const m2 = g("rev-parse", "HEAD");
cli(["init-log", "--log", P("log.tsv")]);
const pl = cli(["plan", "--stack", W("stack.json", { base, prs: [{ pr: 1, head_sha: h1 }, { pr: 2, head_sha: h2 }] }), "--verdicts", W("v.json", { 1: { sha: h1, verdict_ref: "v1", valid: true }, 2: { sha: h2, verdict_ref: "v2", valid: true } }), "--log", P("log.tsv"), "--digest-out", P("d0.json")]);
W("plan.json", pl.j);
const rb = (pr, m, h, prior, out) => cli(["readback", "--repo", repo, "--main", "main", "--merge-sha", m, "--verified-head", h, "--log", P("log.tsv"), "--plan", P("plan.json"), "--pr", String(pr), "--prior", prior, "--digest-out", out]);
const r1 = rb(1, m1, h1, P("d0.json"), P("d1.json"));
console.log("B1 step12 PR1 rider squash:", JSON.stringify({ code: r1.code, tree_match: r1.j?.tree_match, reason: r1.j?.reason, d1_written: fs.existsSync(P("d1.json")), d1_equals_printed: fs.existsSync(P("d1.json")) && JSON.stringify(JSON.parse(fs.readFileSync(P("d1.json")))) === JSON.stringify(r1.j?.log_digest) }));
const log = fs.readFileSync(P("log.tsv"), "utf8"); const flipped = log.split("\n").map((l) => l.split("\t")[5] === "readback" ? l.replace("\tfalse\t", "\ttrue\t") : l).join("\n"); fs.writeFileSync(P("log.tsv"), flipped);
const before = sz();
const r2 = rb(2, m2, h2, P("d1.json"), P("d2.json"));
console.log("B1 PR2 readback --prior d1 (recorded stop digest) after flip:", JSON.stringify({ code: r2.code, out: r2.j, d2_written: fs.existsSync(P("d2.json")), log_unchanged: sz() === before }));
const r2old = rb(2, m2, h2, P("d0.json"), P("d2old.json"));
console.log("B1 contrast PR2 readback --prior d0 (old skill path):", JSON.stringify({ code: r2old.code, tree_match: r2old.j?.tree_match, refused: r2old.j?.refused }));
// stop-ack accepts --prior (fresh run, unflipped)
fs.writeFileSync(P("log.tsv"), log);
const ack = cli(["stop-ack", "--log", P("log.tsv"), "--pr", "1", "--by", "qa", "--note", "probe", "--prior", P("d1.json"), "--digest-out", P("d3.json")]);
console.log("stop-ack --prior d1 (unflipped):", JSON.stringify({ code: ack.code, acknowledged: ack.j?.acknowledged, d3_written: fs.existsSync(P("d3.json")) }));
// wording: do refusals write --digest-out? readback refusal vs readback-run refusal
const rRef = rb(2, m2, "0".repeat(40), P("d3.json"), P("d4.json"));
console.log("readback refusal (wrong head) d4_written:", fs.existsSync(P("d4.json")), "code", rRef.code, JSON.stringify(rRef.j));
const rr = cli(["readback-run", "--repo", repo, "--main", "main", "--merges", W("m.json", [{ pr: 2, merge_sha: m2 }]), "--plan", P("plan.json"), "--log", P("log.tsv"), "--prior", P("d3.json"), "--digest-out", P("d5.json")]);
const d3 = fs.readFileSync(P("d3.json"), "utf8");
console.log("readback-run refusal:", JSON.stringify({ code: rr.code, refused: rr.j?.refused, d5_written: fs.existsSync(P("d5.json")), d5_equals_d3: fs.existsSync(P("d5.json")) && JSON.stringify(JSON.parse(fs.readFileSync(P("d5.json")))) === JSON.stringify(JSON.parse(d3)) }));
