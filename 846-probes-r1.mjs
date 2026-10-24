// QA probes for PR #846 (OVD-934) at the worktree head. No network, no gh: every
// GitHub call goes through an in-memory fake `run` behind the real readMarker/writeMarker.
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
const WT = "/workspace/qa-batch/wt846";
const FAKE_KEY = "tsk_QAFAKEKEY_9f8e7d6c5b4a39281706";
const FAKE_GH = "ghp_QAFAKEGHTOKEN0123456789abcdefABCDEF";
process.env.TYPESAFE_API_KEY = FAKE_KEY;
process.env.GH_TOKEN = FAKE_GH;
const S = await import(`${WT}/scripts/jev-pr-screen.mjs`);
const M = await import(`${WT}/scripts/lib/jev-screen-marker.mjs`);
const { JEV_MODEL } = await import(`${WT}/scripts/jev-client.mjs`);
const SHA_A = "a".repeat(40), SHA_B = "b".repeat(40);
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` :: ${extra}` : ""}`); };
const captured = [];
const origErr = console.error, origLog = console.log;
function fakeGitHub({ heads = {}, statuses = {}, failWrites = false, failReads = false, author = "optomachina" } = {}) {
  const store = structuredClone(statuses); const calls = [];
  const run = (args) => {
    calls.push(args); const p = args[1];
    let m;
    if ((m = /^repos\/optomachina\/Overdrafter\/commits\/([0-9a-f]{40})\/statuses\?per_page=100$/.exec(p))) {
      if (failReads) throw new Error(`HTTP 502 Authorization: token ${FAKE_GH}`);
      return JSON.stringify(store[m[1]] ?? []);
    }
    if ((m = /^repos\/optomachina\/Overdrafter\/statuses\/([0-9a-f]{40})$/.exec(p))) {
      if (failWrites) throw new Error(`HTTP 403 bad credentials ${FAKE_GH}`);
      const f = (k) => args[args.indexOf(`${k}=` + args.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1))]?.slice(k.length + 1);
      store[m[1]] = [{ context: f("context"), state: f("state"), description: f("description"), creator: { login: author } }, ...(store[m[1]] ?? [])];
      return "{}";
    }
    if ((m = /^repos\/optomachina\/Overdrafter\/pulls\/(\d+)$/.exec(p))) { if (heads[m[1]]) return heads[m[1]] + "\n"; throw new Error("HTTP 404"); }
    throw new Error("unexpected " + args.join(" "));
  };
  return { store, calls, posts: () => calls.filter((a) => a.includes("POST")), io: { read: (s, mo, q) => M.readMarker(s, mo, q, { run }), write: (s, mk) => M.writeMarker(s, mk, { run }), headSha: (pr) => M.readPrHeadSha(pr, { run }) } };
}
function jev(choice = "normal", confidence = 0.9, noul = 0.15) { const j = { calls: 0 }; j.ask = async () => { j.calls++; return { ok: true, model: JEV_MODEL, answers: { tier: { type: "choice", choice, confidence }, incident: { type: "noul", noul } }, latencyMs: 111 }; }; return j; }
const dir = mkdtempSync(join(tmpdir(), "qa846-"));
const logPath = join(dir, "sub", "jev-decisions.jsonl");
const warnings = [];
const opts = (extra) => ({ log: logPath, warn: (l) => warnings.push(l), ...extra });
const pr = (sha = SHA_A, files = ["README.md"], n = 846) => ({ pr: n, sha, deterministic: "low", title: "Docs", files });

// P1 AC1: same PR same SHA twice -> 1 Jev call, second row marker_hit=true, latency null
{ const gh = fakeGitHub({ heads: { 846: SHA_A } }); const j = jev();
  const [a] = await S.screen([pr()], opts({ ask: j.ask, marker: gh.io, caller: "qa-probe" }));
  const [b] = await S.screen([pr()], opts({ ask: j.ask, marker: gh.io, caller: "qa-probe" }));
  ok("P1 same SHA twice: 1 Jev call", j.calls === 1, `calls=${j.calls}`);
  ok("P1 second row marker_hit=true latency_ms=null, first marker_hit=false latency=111", a.marker_hit === false && a.latency_ms === 111 && b.marker_hit === true && b.latency_ms === null);
  ok("P1 exactly one status POST, context jev-screen state success", gh.posts().length === 1 && gh.posts()[0].includes("context=jev-screen") && gh.posts()[0].includes("state=success"));
  ok("P1 rows carry sha, caller, screener", b.sha === SHA_A && b.caller === "qa-probe" && b.screener === "mjs");
  ok("P1 rows have no field named cache_hit / head_sha / tokens (AC wording)", !("cache_hit" in b) && !("head_sha" in b) && !("tokens" in b), `keys=${Object.keys(b).join(",")}`);
  // P2 AC2: new SHA (head moved) -> re-screen
  const j2 = jev(); gh.store[SHA_A] = gh.store[SHA_A]; const gh2 = fakeGitHub({ heads: { 846: SHA_B }, statuses: gh.store });
  const [c] = await S.screen([pr(SHA_B)], opts({ ask: j2.ask, marker: gh2.io }));
  ok("P2 new head SHA re-screens (Jev called, marker_hit=false, new marker written on new SHA)", j2.calls === 1 && c.marker_hit === false && (gh2.store[SHA_B] ?? []).length === 1);
  // P2b old SHA after head moved -> no marker read/write, re-screen
  const j3 = jev(); const [d] = await S.screen([pr(SHA_A)], opts({ ask: j3.ask, marker: gh2.io }));
  ok("P2b stale SHA (not head) never uses the marker", j3.calls === 1 && d.marker_hit === false);
}
// P3 model change, untrusted author, pending, forged duplicate keys -> miss
{ const desc = (o = {}) => M.buildMarkerDescription({ tier: "low", jevTier: "low", confidence: 0.99, pIncident: 0.01, model: JEV_MODEL, questionHash: M.hashQuestions(S.SCREEN_QUESTIONS ?? {}), ...o });
  const Q = (await import(`${WT}/scripts/jev-pr-screen.mjs`)).SCREEN_QUESTIONS;
  const qh = Q ? M.hashQuestions(Q) : null;
  ok("P3 SCREEN_QUESTIONS exported (needed for hash)", !!Q);
  const d = (o) => M.buildMarkerDescription({ tier: "low", jevTier: "low", confidence: 0.99, pIncident: 0.01, model: JEV_MODEL, questionHash: qh, ...o });
  const cases = {
    "other model": [{ context: "jev-screen", state: "success", description: d({ model: "jev-1.12.0" }), creator: { login: "optomachina" } }],
    "untrusted author": [{ context: "jev-screen", state: "success", description: d(), creator: { login: "mallory" } }],
    "pending state": [{ context: "jev-screen", state: "pending", description: d(), creator: { login: "optomachina" } }],
    "other screener": [{ context: "jev-screen", state: "success", description: d().replace("screener=mjs", "screener=py"), creator: { login: "optomachina" } }],
    "garbage": [{ context: "jev-screen", state: "success", description: "v1 tier=low lol", creator: { login: "optomachina" } }],
    "dup key tier=low=risky": [{ context: "jev-screen", state: "success", description: d().replace("tier=low", "tier=low=x"), creator: { login: "optomachina" } }],
  };
  for (const [name, sts] of Object.entries(cases)) { const gh = fakeGitHub({ heads: { 846: SHA_A }, statuses: { [SHA_A]: sts } }); const j = jev();
    const [r] = await S.screen([pr()], opts({ ask: j.ask, marker: gh.io })); ok(`P3 miss on ${name}`, j.calls === 1 && r.marker_hit === false); }
  // trusted low marker cannot lower a sensitive-path PR
  const gh = fakeGitHub({ heads: { 846: SHA_A }, statuses: { [SHA_A]: [{ context: "jev-screen", state: "success", description: d(), creator: { login: "optomachina" } }] } }); const j = jev();
  const [r] = await S.screen([pr(SHA_A, ["scripts/jev-pr-screen.mjs"])], opts({ ask: j.ask, marker: gh.io }));
  ok("P3 trusted low marker on sensitive file: hit but final risky (never lowers)", r.marker_hit === true && r.final === "risky" && j.calls === 0, `final=${r.final}`);
  // duplicate key later in description: last value wins? (forgery-by-owner only)
  const dup = d() + " tier=risky"; const parsed = M.parseMarkerDescription(dup);
  ok("P3 info: duplicate 'tier=' key in description -> parsed tier", true, `parsed.tier=${parsed?.tier}`);
}
// P4 fail-safe read / fail-open write / uncertain not written / PR<=0
{ const gh = fakeGitHub({ heads: { 846: SHA_A }, failReads: true }); const j = jev();
  const [r] = await S.screen([pr()], opts({ ask: j.ask, marker: gh.io })); ok("P4 read API error -> re-screen", j.calls === 1 && r.marker_hit === false);
  const gw = fakeGitHub({ heads: { 846: SHA_A }, failWrites: true }); warnings.length = 0;
  const [w] = await S.screen([pr()], opts({ ask: jev().ask, marker: gw.io })); ok("P4 write failure -> warned, result stands", w.ok && w.final === "normal" && warnings.some((l) => /marker write for #846 failed \(api_error\)/.test(l)), warnings.join(" | "));
  const gu = fakeGitHub({ heads: { 846: SHA_A } }); await S.screen([pr()], opts({ ask: jev("low", 0.3).ask, marker: gu.io }));
  ok("P4 uncertain answer writes no marker", gu.posts().length === 0);
  const g0 = fakeGitHub({ heads: { 846: SHA_A } }); const [z] = await S.screen([pr(SHA_A, ["README.md"], 0)], opts({ ask: jev().ask, marker: g0.io }));
  ok("P4 PR 0 logged as null, no GitHub call", z.pr === null && g0.calls.length === 0);
  const gs = fakeGitHub({ heads: { 846: SHA_A } }); await S.screen([pr("aaaaaaa")], opts({ ask: jev().ask, marker: gs.io }));
  ok("P4 short SHA: no GitHub call", gs.calls.length === 0);
  // uppercase SHA equal to head is accepted and lowercased for the marker
  const gU = fakeGitHub({ heads: { 846: SHA_A } }); await S.screen([pr(SHA_A.toUpperCase())], opts({ ask: jev().ask, marker: gU.io }));
  ok("P4 uppercase SHA matching head -> marker written on lowercase SHA", (gU.store[SHA_A] ?? []).length === 1);
}
// P5 secrets: errors carrying a fake GH token / Jev key never reach warnings, log or stdout/stderr
{ const out = []; console.error = (...a) => out.push(a.join(" ")); console.log = (...a) => out.push(a.join(" "));
  warnings.length = 0;
  const gh = fakeGitHub({ heads: { 846: SHA_A }, failReads: true, failWrites: true });
  const failingJev = async () => ({ ok: false, reason: `upstream said key ${FAKE_KEY} invalid` });
  const recs = await S.screen([pr(), { ...pr(), title: "t" }], { log: logPath, ask: async () => ({ ok: true, model: JEV_MODEL, answers: { tier: { type: "choice", choice: "low", confidence: 0.9 } }, latencyMs: 1 }), marker: gh.io });
  const recs2 = await S.screen([pr()], { log: logPath, ask: failingJev, marker: gh.io });
  const outAfterReal = out.length;
  const throwingHead = { read: async () => { throw new Error(FAKE_GH); }, write: async () => { throw new Error(FAKE_GH); }, headSha: async () => SHA_A };
  await S.screen([pr()], { log: logPath, ask: jev().ask, marker: throwingHead });
  await S.screen([pr()], { log: join(logPath, "notadir", "x.jsonl"), ask: jev().ask, marker: { read: async () => null, write: async () => ({ success: false, reason: FAKE_GH }), headSha: async () => SHA_A } });
  console.error = origErr; console.log = origLog;
  const logText = readFileSync(logPath, "utf8");
  const blob = [...out, logText, JSON.stringify(recs), JSON.stringify(recs2)].join("\n");
  const realIoOut = out.slice(0, outAfterReal);
  ok("P5 real GitHub marker IO (gh errors carrying a fake token): no token in stderr/stdout/log/records", ![...realIoOut, logText, JSON.stringify(recs), JSON.stringify(recs2)].join("\n").includes(FAKE_GH), `lines=${realIoOut.length}`);
  const injectedLeak = out.slice(outAfterReal).some((l) => l.includes(FAKE_GH));
  ok("P5 INFO (not a gate): an injected marker writer that throws/returns a secret string has it echoed in the warning (only TYPESAFE_API_KEY is redacted)", true, `echoed=${injectedLeak}`);
  ok("P5 no fake Jev key in stderr/stdout/log/records", !blob.includes(FAKE_KEY), `reason=${recs2[0].reason}`);
  ok("P5 warnings emitted for failures (sanitized)", out.some((l) => /marker write .* failed/.test(l)), out.slice(0, 4).join(" | "));
}
// P6 log location & gh resolution
{ ok("P6 DEFAULT_LOG outside repo (~/work/claude-jobs)", S.DEFAULT_LOG === `${homedir()}/work/claude-jobs/jev-decisions.jsonl` && !S.DEFAULT_LOG.startsWith(WT));
  ok("P6 log dir auto-created", existsSync(logPath));
  const fake = mkdtempSync(join(tmpdir(), "qa846bin-")); process.env.PATH = `${fake}:${process.env.PATH}`;
  const r = M.resolveTrustedExecutable("gh"); ok("P6 gh resolved from trusted dirs only, not PATH", r === null || M.TRUSTED_BIN_DIRS.some((d) => r === `${d}/gh`), `resolved=${r}`);
  ok("P6 resolveTrustedExecutable rejects path-like names", M.resolveTrustedExecutable("../gh") === null && M.resolveTrustedExecutable("gh;rm") === null);
  ok("P6 CLI --caller parse + rejects missing id", S.parseScreenArgs(["--caller", "box", "in.json"]).caller === "box" && (() => { try { S.parseScreenArgs(["--caller"]); return false; } catch { return true; } })());
}
console.log(`\nprobes: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
