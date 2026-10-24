// QA probes for PR #846 (OVD-934) at the worktree head. No network, no gh: every
// GitHub call goes through an in-memory fake `run` behind the real readMarker/writeMarker.
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
const WT = process.env.QA_WT ?? "/workspace/qa-batch/wt846-r3";
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
function fakeGitHub({ heads = {}, statuses = {}, failWrites = false, failReads = false, author = "optomachina", failPage = null, endless = false, oversize = false } = {}) {
  const store = structuredClone(statuses); const calls = [];
  const run = (args) => {
    calls.push(args); const p = args[1];
    let m;
    if ((m = /^repos\/optomachina\/Overdrafter\/commits\/([0-9a-f]{40})\/statuses\?per_page=(\d+)&page=(\d+)$/.exec(p))) {
      if (failReads) throw new Error(`HTTP 502 Authorization: token ${FAKE_GH}`);
      const size = Number(m[2]), page = Number(m[3]);
      if (failPage === page) throw new Error(`HTTP 502 on page ${page}`);
      if (endless) return JSON.stringify(Array.from({ length: size }, (_, i) => ({ context: "ci/other", state: "success", description: `x${i}`, creator: { login: "github-actions" } })));
      if (oversize) return JSON.stringify(Array.from({ length: size + 1 }, () => ({ context: "ci/other", state: "success" })));
      return JSON.stringify((store[m[1]] ?? []).slice((page - 1) * size, page * size));
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
  ok("P1 AC1 fields: second row cache_hit=true head_sha=SHA tokens=null; aliases marker_hit/sha equal", b.cache_hit === true && b.marker_hit === true && b.head_sha === SHA_A && b.sha === SHA_A && "tokens" in b && b.tokens === null, `keys=${Object.keys(b).join(",")}`);
  ok("P1 AC1 first row cache_hit=false head_sha=SHA", a.cache_hit === false && a.head_sha === SHA_A);
  // P2 AC2: new SHA (head moved) -> re-screen
  const j2 = jev(); gh.store[SHA_A] = gh.store[SHA_A]; const gh2 = fakeGitHub({ heads: { 846: SHA_B }, statuses: gh.store });
  const [c] = await S.screen([pr(SHA_B)], opts({ ask: j2.ask, marker: gh2.io }));
  ok("P2 new head SHA re-screens (Jev called, cache_hit=false, head_sha=new, one marker on new SHA, old SHA marker untouched)", j2.calls === 1 && c.cache_hit === false && c.head_sha === SHA_B && (gh2.store[SHA_B] ?? []).length === 1 && gh2.store[SHA_A].length === 1);
  const [c2] = await S.screen([pr(SHA_B)], opts({ ask: j2.ask, marker: gh2.io }));
  ok("P2 next screen at new head is a cache hit", j2.calls === 1 && c2.cache_hit === true);
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
  ok("P3 duplicate 'tier=' key in description -> rejected (null)", parsed === null, `parsed=${JSON.stringify(parsed)}`);
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

// P7 AC1 tokens in real rows written to the log file
{ const tlog = join(dir, "tokens.jsonl");
  const mk = (usage, extra = {}) => async () => ({ ok: true, model: JEV_MODEL, answers: { tier: { type: "choice", choice: "normal", confidence: 0.9 }, incident: { type: "noul", noul: 0.1 } }, usage, latencyMs: 42, ...extra });
  const gh = fakeGitHub({ heads: { 846: SHA_A } });
  await S.screen([pr()], { log: tlog, warn: () => {}, ask: mk({ input_tokens: 512, output_tokens: 7, total_tokens: 519, api_key: FAKE_KEY, authorization: FAKE_GH }), marker: gh.io });
  await S.screen([pr()], { log: tlog, warn: () => {}, ask: mk({ input_tokens: 1, output_tokens: 1 }), marker: gh.io });
  const cases = [
    [{ input_tokens: FAKE_KEY, output_tokens: FAKE_GH }, null],
    [{ input_tokens: 3.5, output_tokens: Number.MAX_SAFE_INTEGER + 2 }, null],
    [{ input_tokens: 9 }, { input_tokens: 9, output_tokens: null }],
    [null, null], [undefined, null], ["512 tokens", null], [[1, 2], null],
  ];
  for (const [usage] of cases) await S.screen([pr(SHA_A, ["README.md"], 0)], { log: tlog, warn: () => {}, ask: mk(usage), marker: gh.io });
  await S.screen([pr(SHA_A, ["README.md"], 0)], { log: tlog, warn: () => {}, ask: async () => ({ ok: false, reason: "timeout", usage: { input_tokens: 5, output_tokens: 5 }, latencyMs: 3 }), marker: gh.io });
  const rows = readFileSync(tlog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  ok("P7 miss row tokens exactly {input_tokens:512,output_tokens:7} (no extra usage keys copied)", JSON.stringify(rows[0].tokens) === '{"input_tokens":512,"output_tokens":7}', JSON.stringify(rows[0].tokens));
  ok("P7 hit row tokens=null, cache_hit=true, latency_ms=null", rows[1].tokens === null && rows[1].cache_hit === true && rows[1].latency_ms === null);
  const got = rows.slice(2, 2 + cases.length).map((r) => r.tokens);
  ok("P7 bad/missing usage -> null; partial -> {n,null}", JSON.stringify(got) === JSON.stringify(cases.map((c) => c[1])), JSON.stringify(got));
  ok("P7 failed Jev call tokens=null", rows.at(-1).ok === false && rows.at(-1).tokens === null);
  const raw = readFileSync(tlog, "utf8");
  ok("P7 no fake secret in any logged row", !raw.includes(FAKE_KEY) && !raw.includes(FAKE_GH));
  ok("P7 every row has head_sha, sha, cache_hit, marker_hit, tokens keys", rows.every((r) => ["head_sha", "sha", "cache_hit", "marker_hit", "tokens"].every((k) => k in r) && r.head_sha === r.sha && r.cache_hit === r.marker_hit));
  ok("P7 replay accepts new and old names", JSON.stringify(S.replay([{ ...rows[1] }, { ...rows[1], cache_hit: undefined, head_sha: undefined }]).map((r) => [r.sha, r.after])) === JSON.stringify([[SHA_A, rows[1].final], [SHA_A, rows[1].final]]));
}

// P8 paged marker read (Architect high): markers beyond page 1 are seen; any truncation is a miss
{ const Q = S.SCREEN_QUESTIONS; const qh = M.hashQuestions(Q);
  const d = (o) => M.buildMarkerDescription({ tier: "low", jevTier: "low", confidence: 0.99, pIncident: 0.01, model: JEV_MODEL, questionHash: qh, ...o });
  const url = (sha) => `https://api.github.com/repos/optomachina/Overdrafter/statuses/${sha}`;
  const filler = (n, tag = "f") => Array.from({ length: n }, (_, i) => ({ url: url(SHA_A), context: i % 3 ? "ci/other" : "jev-screen", state: "success", description: i % 3 ? `${tag}${i}` : d({ model: "jev-0.0.1" }), creator: { login: i % 2 ? "github-actions" : "optomachina" } }));
  const marker = (tier, extra = {}) => ({ url: url(SHA_A), context: "jev-screen", state: "success", description: d({ tier }), creator: { login: "optomachina" }, ...extra });
  const run1 = async (statuses, opt = {}) => { const gh = fakeGitHub({ heads: { 846: SHA_A }, statuses: { [SHA_A]: statuses }, ...opt }); const j = jev("normal"); const [r] = await S.screen([pr()], opts({ ask: j.ask, marker: gh.io })); const pages = gh.calls.filter((a) => a[1].includes("/statuses?")).length; return { r, j, gh, pages }; };
  // Architect's repro: low on page 1, risky on page 2 -> must pick risky
  { const st = [marker("low"), ...filler(130)]; st.splice(120, 0, marker("risky")); const { r, j, pages } = await run1(st);
    ok("P8 low marker p1 + risky marker p2 -> hit uses risky (strongest), 0 Jev calls", r.cache_hit === true && r.final === "risky" && r.marker_tier === "risky" && j.calls === 0, `final=${r.final} pages=${pages}`); }
  { const st = [...filler(230)]; st.splice(215, 0, marker("normal")); const { r, j, pages } = await run1(st);
    ok("P8 only valid marker on page 3 (231 statuses) -> found", r.cache_hit === true && r.marker_tier === "normal" && j.calls === 0 && pages === 3, `pages=${pages}`); }
  { const st = [...filler(99), marker("normal")]; const { r, pages } = await run1(st);
    ok("P8 exactly 100 statuses, marker at #100 -> found, reads page 2 to confirm end", r.cache_hit === true && pages === 2, `pages=${pages}`); }
  { const st = [...filler(150)]; st.splice(140, 0, marker("low")); const { r, j } = await run1(st, { failPage: 2 });
    ok("P8 page 2 API error -> miss, re-screen", r.cache_hit === false && j.calls === 1); }
  { const { r, j, pages } = await run1([], { endless: true });
    ok("P8 endless full pages -> miss after MAX_STATUS_PAGES, re-screen", r.cache_hit === false && j.calls === 1 && pages === M.MAX_STATUS_PAGES, `pages=${pages} max=${M.MAX_STATUS_PAGES}`); }
  { const { r, j } = await run1([], { oversize: true });
    ok("P8 oversized page (101 > 100) -> miss, re-screen", r.cache_hit === false && j.calls === 1); }
  { const { r, j } = await run1([marker("low", { url: url(SHA_B) })]);
    ok("P8 marker whose url names another commit -> miss", r.cache_hit === false && j.calls === 1); }
}
// P9 strict marker parsing (Architect medium): malformed/duplicate/extra fields reject the whole marker -> re-screen
{ const qh = M.hashQuestions(S.SCREEN_QUESTIONS);
  const good = M.buildMarkerDescription({ tier: "risky", jevTier: "normal", confidence: 0.9, pIncident: 0.2, model: JEV_MODEL, questionHash: qh });
  const bad = {
    "Architect repro: risky marker + appended 'tier=low jev=low'": `${good} tier=low jev=low`,
    "duplicate c": `${good} c=0.99`,
    "extra unknown field": `${good} extra=1`,
    "junk token": `${good} junk`,
    "token with two '='": good.replace("tier=risky", "tier=risky=low"),
    "missing p": good.replace(/ p=\S+/, ""),
    "missing screener": good.replace(/ screener=\S+/, ""),
    "q uppercase": good.replace(`q=${qh}`, `q=${qh.toUpperCase()}`),
    "q 9 hex": good.replace(`q=${qh}`, `q=${qh}0`),
    "c=1.5": good.replace("c=0.9", "c=1.5"),
    "c 4 decimals": good.replace("c=0.9", "c=0.9001"),
    "c=NaN": good.replace("c=0.9", "c=NaN"),
    "c=.9": good.replace("c=0.9", "c=.9"),
    "c=1e-1": good.replace("c=0.9", "c=1e-1"),
    "p=-0.1": good.replace("p=0.2", "p=-0.1"),
    "unknown tier": good.replace("tier=risky", "tier=high"),
    "wrong version": good.replace(/^v1/, "v2"),
    "over 140 chars": `${good}${" ".repeat(141 - good.length)}`,
  };
  for (const [name, description] of Object.entries(bad)) {
    const parsed = M.parseMarkerDescription(description);
    const gh = fakeGitHub({ heads: { 846: SHA_A }, statuses: { [SHA_A]: [{ context: "jev-screen", state: "success", description, creator: { login: "optomachina" } }] } }); const j = jev("normal");
    const [r] = await S.screen([pr()], opts({ ask: j.ask, marker: gh.io }));
    ok(`P9 rejects ${name} -> parse null, re-screen (1 Jev call)`, parsed === null && r.cache_hit === false && j.calls === 1, `len=${description.length}`);
  }
  const gh = fakeGitHub({ heads: { 846: SHA_A }, statuses: { [SHA_A]: [{ context: "jev-screen", state: "success", description: good, creator: { login: "optomachina" } }] } }); const j = jev("low");
  const [r] = await S.screen([pr()], opts({ ask: j.ask, marker: gh.io }));
  ok("P9 control: well-formed marker still hits (risky, 0 Jev calls)", M.parseMarkerDescription(good) !== null && r.cache_hit === true && r.final === "risky" && j.calls === 0);
  ok("P9 p=na accepted", M.parseMarkerDescription(good.replace("p=0.2", "p=na"))?.pIncident === null);
  ok("P9 writer output round-trips (c floor, p ceil)", JSON.stringify(M.parseMarkerDescription(M.buildMarkerDescription({ tier: "low", jevTier: "low", confidence: 0.98765, pIncident: 0.12301, model: JEV_MODEL, questionHash: qh })) ?? null).includes('"confidence":0.987,"pIncident":0.124'));
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
