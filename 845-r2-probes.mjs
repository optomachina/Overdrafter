// QA r2 probes for PR #845 at 4a70d533 (box only, no network except none; gh is stubbed)
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
const WT = "/workspace/qa-batch/wt845-r2";
const lib = await import(`${WT}/scripts/lib/spend-ledger.mjs`);
const cli = await import(`${WT}/scripts/spend-ledger.mjs`);
const ev = await import("/workspace/qa-batch/wt835/scripts/evals-weekly-report.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qa845-"));
const out = []; const log = (...a) => { const s = a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" "); out.push(s); console.log(s); };
const results = {};
const verdict = (k, ok, why) => { results[k] = results[k] ?? []; results[k].push({ ok, why }); log(`  [${ok ? "OK" : "FAIL"}] ${k}: ${why}`); };
const cap = () => { let s = ""; return { write: (x) => { s += x; return true; }, get text() { return s; } }; };
const runMain = (args, deps = {}) => { const so = cap(), se = cap(); const code = cli.main(args, { stdout: so, stderr: se, cwd: WT, repoRoot: tmp, ...deps }); return { code, out: so.text, err: se.text }; };
const base = { schema: "token-watcher-usage.v1", period: "2026-10-05", source: "probe" };

// ---------- a) unknown / missing spend never $0 ----------
log("== a) unknown or missing spend");
const cases = {
  missingCost: { ...base, pool: "codex" },
  nullDollars: { ...base, pool: "codex", dollars: null },
  nullShare: { ...base, pool: "codex", dollars: null, subscriptionShare: null },
};
for (const [k, r] of Object.entries(cases)) { const row = lib.usageToLedger(r); log(k, row); verdict("a", row.usd === null && row.valuation === "unvalued", `${k} -> usd=${row.usd} valuation=${row.valuation}`); }
for (const [k, r] of Object.entries({ unknownProvider: { ...base, pool: "openai", dollars: 1 }, unknownProviderNoCost: { ...base, pool: "gemini" }, unknownPlan_noPlanPrice: { ...base, pool: "claude", subscriptionShare: 0.2 }, unknownPlan_zeroPlanPrice: { ...base, pool: "claude", subscriptionShare: 0.2, subscriptionUsd: 0 } })) {
  try { const row = lib.usageToLedger(r, "probe:1"); verdict("a", false, `${k} accepted: ${JSON.stringify(row)}`); } catch (e) { verdict("a", e instanceof lib.UsageError, `${k} rejected: ${e.message}`); }
}
// weekly with only-unvalued pool, missing pools, partial pool
const ledgerA = [
  lib.usageToLedger({ ...base, pool: "codex" }),                       // codex: only unvalued
  lib.usageToLedger({ ...base, pool: "claude", dollars: 3 }),           // claude: valued on 1 of 7 days -> partial
  lib.usageToLedger({ ...base, pool: "claude", period: "2026-10-06", source: "probe2" }), // claude unvalued day
];
const prsA = [{ number: 1, mergedAt: "2026-10-06T10:00:00Z", labels: ["model:codex"] }, { number: 2, mergedAt: "2026-10-07T10:00:00Z", labels: ["model:claude"] }];
const repA = lib.weeklyReport({ ledger: ledgerA, prs: prsA, from: "2026-10-05", to: "2026-10-11" });
const wk = repA.weeks[0];
for (const p of wk.pools) log(`  pool ${p.pool}: usd=${p.usd} perPR=${p.usdPerMergedPR} status=${p.status} coverage=${p.coverage} flags=${p.flags}`);
log("  overall", wk.overall);
const codex = wk.pools.find((p) => p.pool === "codex"), cursor = wk.pools.find((p) => p.pool === "cursor"), claude = wk.pools.find((p) => p.pool === "claude");
verdict("a", codex.usd === null && codex.usdPerMergedPR === null && codex.status === "unknown", "codex unvalued-only pool -> usd null, ratio null, status unknown");
verdict("a", cursor.usd === null && cursor.coverage === "missing", "cursor no-data pool -> usd null, coverage missing");
verdict("a", claude.coverage === "partial" && claude.lowerBound === true, "claude partial -> lowerBound true");
verdict("a", wk.overall.totalUsd === 3 && wk.overall.lowerBound === true && wk.overall.missingPools.includes("cursor") && wk.overall.missingPools.includes("jev") && wk.overall.flags.includes("partial"), `overall totalUsd=${wk.overall.totalUsd} flagged partial/lowerBound, missingPools=${wk.overall.missingPools}`);
const pr1 = repA.prs.find((p) => p.number === 1);
verdict("a", pr1.attributedUsd === null, `PR1 per-PR attributedUsd=${pr1.attributedUsd} (null, not 0)`);
const md = lib.markdownReport(repA); log(md);
const zeroRows = md.split("\n").filter((l) => l.includes("$0.00"));
verdict("a", zeroRows.length === 0, `markdown has ${zeroRows.length} '$0.00' cells; codex row: ${md.split("\n").find((l) => l.startsWith("| codex"))}`);
verdict("a", /\| \*\*all pools\*\* \| \$3\.00 .*≥ \$1\.50 \(partial\).*cursor missing/.test(md), "all-pools row shows ≥ (partial) and names missing pools");
// all-unvalued window
const repNone = lib.weeklyReport({ ledger: [lib.usageToLedger({ ...base, pool: "jev" })], prs: prsA, from: "2026-10-05", to: "2026-10-11" });
verdict("a", repNone.totals.overall.totalUsd === null && repNone.totals.overall.status === "unknown" && !lib.markdownReport(repNone).includes("$0.00"), `all-unvalued window -> totals.totalUsd=${repNone.totals.overall.totalUsd} status=${repNone.totals.overall.status}`);
// explicit metered 0 is the only $0 path
const repZero = lib.weeklyReport({ ledger: [lib.usageToLedger({ ...base, pool: "jev", dollars: 0 })], prs: [], from: "2026-10-05", to: "2026-10-05" });
log("  explicit dollars:0 jev ->", repZero.totals.pools.find((p) => p.pool === "jev"));
// CLI collect summary counts unvalued
fs.writeFileSync(path.join(tmp, "a.jsonl"), [cases.missingCost, { ...base, pool: "claude", dollars: 2 }].map((r) => JSON.stringify(r)).join("\n"));
const ca = runMain(["collect", "--input", path.join(tmp, "a.jsonl"), "--ledger", path.join(tmp, "a-ledger.jsonl")]);
log("  collect:", ca); verdict("a", ca.code === 0 && /"unvalued":1/.test(ca.out), "collect stdout reports unvalued count");

// ---------- b) subscription share arithmetic ----------
log("== b) subscription share valuation");
const sub = lib.usageToLedger({ ...base, pool: "claude", subscriptionShare: 0.25, subscriptionUsd: 200, pr: 10 });
log(" ", sub); verdict("b", sub.usd === 50 && sub.valuation === "subscription-share", `0.25 x $200 = ${sub.usd}`);
const sub2 = lib.usageToLedger({ ...base, pool: "cursor", subscriptionShare: 0.07, subscriptionUsd: 100, period: "2026-10-06" });
const met = lib.usageToLedger({ ...base, pool: "claude", dollars: 1.255, period: "2026-10-06" });
const repB = lib.weeklyReport({ ledger: [sub, sub2, met], prs: [{ number: 10, mergedAt: "2026-10-06T00:00:00Z", labels: ["model:claude"] }, { number: 11, mergedAt: "2026-10-06T00:00:00Z", labels: ["model:claude"] }, { number: 12, mergedAt: "2026-10-06T00:00:00Z", labels: ["pool:cursor"] }], from: "2026-10-05", to: "2026-10-06", minSample: 1 });
const cl = repB.totals.pools.find((p) => p.pool === "claude"), cu = repB.totals.pools.find((p) => p.pool === "cursor");
log("  claude", cl); log("  cursor", cu); log("  overall", repB.totals.overall); log("  prs", repB.prs);
verdict("b", Math.abs(cl.usd - 51.255) < 1e-9 && cl.usdPerMergedPR === 25.63, `claude (50 + 1.255)/2 = ${cl.usdPerMergedPR} (expected 25.63 half-up)`);
verdict("b", Math.abs(cu.usd - 7) < 1e-9 && cu.usdPerMergedPR === 7, `cursor 0.07 x $100 = ${cu.usd} -> $/PR ${cu.usdPerMergedPR}`);
verdict("b", Math.abs(repB.totals.overall.totalUsd - 58.255) < 1e-9 && repB.totals.overall.usdPerMergedPR === 19.42, `overall 58.255/3 = ${repB.totals.overall.usdPerMergedPR} (expected 19.42)`);
verdict("b", repB.prs.find((p) => p.number === 10).attributedUsd === 50, "PR10 attributedUsd = 50 (direct pr link)");

// ---------- c) gh invocation ----------
log("== c) gh pr list invocation");
const src = fs.readFileSync(`${WT}/scripts/spend-ledger.mjs`, "utf8");
const ghLines = src.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => /execFileSync|exec\(|spawn|shell:/.test(l));
for (const [n, l] of ghLines) log(`  spend-ledger.mjs:${n}: ${l.trim()}`);
verdict("c", !/\bexec\(|execSync|shell:\s*true|spawn\(/.test(src), "no exec/execSync/spawn/shell:true; only execFileSync(cmd, argvArray)");
const stub = path.join(tmp, "bin"); fs.mkdirSync(stub); const argvLog = path.join(tmp, "gh.argv");
fs.writeFileSync(path.join(stub, "gh"), `#!/usr/bin/env bash\nfor a in "$@"; do printf '%s\\n' "$a"; done > ${argvLog}\nif [ -n "$GH_STUB_FAIL" ]; then echo "token=ghp_FAKE_SECRET_STDERR_123" >&2; exit 1; fi\necho '[{"number":100,"title":"OVD-100 x","mergedAt":"2026-10-05T12:00:00Z","labels":[],"headRefName":"h","body":"","author":{"login":"a"}}]'\n`, { mode: 0o755 });
const fx = `${WT}/scripts/fixtures/spend-ledger`;
fs.writeFileSync(path.join(tmp, "fx-ledger.jsonl"), "");
const cl1 = runMain(["collect", "--input", `${fx}/usage.jsonl`, "--ledger", path.join(tmp, "fx-ledger.jsonl")]);
// r2: in-process with a capturing execFile (real resolveBin), then a spawned run with a malicious gh first on PATH
const calls = [];
const capExec = (stubName) => (bin, argv, opts) => { calls.push({ bin, argv, opts }); if (bin.endsWith("/gh")) return execFileSync(path.join(stub, stubName), argv, { ...opts, env: { PATH: "/usr/bin:/bin" } }); return execFileSync(bin, argv, opts); };
const R = (args, name = "gh") => { const r = runMain(args, { execFile: capExec(name), repoRoot: undefined }); return { status: r.code, stdout: r.out, stderr: r.err }; };
fs.writeFileSync(path.join(stub, "ghfail"), `#!/usr/bin/env bash\necho "token=ghp_FAKE_SECRET_STDERR_123" >&2; exit 1\n`, { mode: 0o755 });
const injFrom = "2026-10-05; touch /tmp/qa845r2-pwned";
const r1 = R(["weekly", "--from", "2026-10-05", "--to", "2026-10-11", "--ledger", path.join(tmp, "fx-ledger.jsonl"), "--repo", "optomachina/Overdrafter"]);
const argv = fs.readFileSync(argvLog, "utf8").trimEnd().split("\n");
const ghCall = calls.find((x) => x.bin.endsWith("/gh")), gitCall = calls.find((x) => x.bin.endsWith("/git"));
log("  exit", r1.status, "gh argv:", argv, "gh bin:", ghCall?.bin, "git bin:", gitCall?.bin, "gh env keys:", Object.keys(ghCall?.opts.env ?? {}), "gh env PATH:", ghCall?.opts.env.PATH, "shell:", ghCall?.opts.shell, "git env keys:", Object.keys(gitCall?.opts.env ?? {}));
verdict("c", r1.status === 0 && argv[0] === "pr" && argv[1] === "list" && argv[argv.indexOf("--state") + 1] === "merged" && argv.includes("merged:2026-10-05..2026-10-11") && argv.includes("--json"), "gh got argv array: pr list --repo ... --state merged --search merged:FROM..TO --json ...");
verdict("c", path.isAbsolute(ghCall.bin) && ["/usr/bin/gh","/bin/gh","/usr/local/bin/gh","/opt/homebrew/bin/gh"].includes(ghCall.bin) && Array.isArray(ghCall.argv), `gh resolved to absolute fixed path ${ghCall.bin}, argv array`);
verdict("c", gitCall && ["/usr/bin/git","/bin/git"].includes(gitCall.bin), `git resolved to absolute path ${gitCall?.bin}`);
const envOk = (e) => e && JSON.stringify(Object.keys(e).sort()) === '["HOME","PATH"]' && e.PATH === "/usr/bin:/bin" && e.HOME === os.homedir();
verdict("c", envOk(ghCall.opts.env) && envOk(gitCall.opts.env) && !ghCall.opts.shell && !gitCall.opts.shell, "child env is exactly {PATH:/usr/bin:/bin, HOME}; no shell option");
verdict("c", !/\bexec\(|execSync|shell:\s*true|spawn\(/.test(src), "no exec/execSync/spawn/shell:true; only execFileSync(absBin, argvArray)");
verdict("c", !argv.some((a) => /^(create|edit|merge|close|comment|review|api)$/.test(a)), "no write subcommands (read-only pr list)");
fs.rmSync(argvLog, { force: true });
const r2 = R(["weekly", "--from", injFrom, "--to", "2026-10-11", "--ledger", path.join(tmp, "fx-ledger.jsonl")]);
verdict("c", r2.status === 2 && !fs.existsSync(argvLog) && !fs.existsSync("/tmp/qa845r2-pwned"), `metachar --from rejected before gh (exit ${r2.status}, stderr=${r2.stderr.trim()})`);
const r3 = R(["weekly", "--from", "2026-10-05", "--to", "2026-10-11", "--ledger", path.join(tmp, "fx-ledger.jsonl"), "--repo", "a/b;touch /tmp/qa845r2-pwned2"]);
const argv3 = fs.readFileSync(argvLog, "utf8").trimEnd().split("\n");
verdict("c", argv3.includes("a/b;touch /tmp/qa845r2-pwned2") && !fs.existsSync("/tmp/qa845r2-pwned2"), `--repo metachars passed as one argv element, not executed (exit ${r3.status})`);
// positive security property: malicious gh/git first on caller PATH is NOT executed (real process, fake empty HOME, no tokens)
const evil = path.join(tmp, "evil"); fs.mkdirSync(evil); const marker = path.join(tmp, "EVIL_RAN");
for (const n of ["gh", "git"]) fs.writeFileSync(path.join(evil, n), `#!/bin/sh\necho ${n} >> ${marker}\necho '[]'\n`, { mode: 0o755 });
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "qa845r2-home-"));
const env = { PATH: `${evil}:${process.env.PATH}`, HOME: fakeHome, QA_FAKE_TOKEN: "QA_FAKE_ENV_SECRET_987", GH_TOKEN: "QA_FAKE_GH_TOKEN_000", GH_CONFIG_DIR: path.join(fakeHome, "gh") };
const rEvil = spawnSync(process.execPath, [`${WT}/scripts/spend-ledger.mjs`, "weekly", "--from", "2026-10-05", "--to", "2026-10-11", "--ledger", path.join(tmp, "fx-ledger.jsonl"), "--repo", "optomachina/Overdrafter"], { env, encoding: "utf8", cwd: WT, timeout: 60000 });
log("  malicious-PATH run exit", rEvil.status, "stderr:", (rEvil.stderr || "").trim().slice(0, 300));
verdict("c", !fs.existsSync(marker), `malicious gh/git earlier on caller PATH NOT executed (marker exists=${fs.existsSync(marker)}); real /usr/bin/gh ran without GH_TOKEN (exit ${rEvil.status})`);
verdict("c", !(rEvil.stdout + rEvil.stderr).includes("QA_FAKE_GH_TOKEN_000") && !(rEvil.stdout + rEvil.stderr).includes("QA_FAKE_ENV_SECRET_987"), "parent env tokens not echoed");

// ---------- d) no secrets / env ----------
log("== d) secrets/env");
const libSrc = fs.readFileSync(`${WT}/scripts/lib/spend-ledger.mjs`, "utf8");
const envHits = [...`${src}\n${libSrc}`.matchAll(/process\.env|TOKEN|API_KEY|SECRET|\benv\b(?!\s*:)/g)].map((m) => m[0]);
const envOpt = [...src.matchAll(/env:\s*([^,}]+)/g)].map((m) => m[1].trim());
log("  env: options passed to children:", envOpt, " executableEnvironment:", src.match(/const executableEnvironment = .*/)?.[0]);
verdict("d", envHits.length === 0 && envOpt.every((e) => e === "executableEnvironment()"), `d1 (narrowed): process.env/TOKEN/API_KEY/SECRET reads in spend-ledger.mjs + lib: ${envHits.length} [${envHits}]; env: options only executableEnvironment() (no process.env passthrough)`);
verdict("d", !(r1.stdout + r1.stderr).includes("QA_FAKE_ENV_SECRET_987"), "fake env token not present in weekly output");
const r4 = R(["weekly", "--from", "2026-10-05", "--to", "2026-10-11", "--ledger", path.join(tmp, "fx-ledger.jsonl")], "ghfail");
verdict("d", r4.status === 1 && !(r4.stdout + r4.stderr).includes("ghp_FAKE_SECRET_STDERR_123"), `gh failure stderr secret not echoed (exit ${r4.status}, stderr="${r4.stderr.trim()}")`);
const badLine = path.join(tmp, "bad.jsonl"); fs.writeFileSync(badLine, '{"schema":"token-watcher-usage.v1","pool":"codex","period":"2026-10-05","source":"s","apiKey":"sk-FAKE_IN_FILE_555","dollars":"x"}\n');
const r5 = runMain(["collect", "--input", badLine, "--ledger", path.join(tmp, "bad-ledger.jsonl"), "--dry-run"]);
verdict("d", r5.code === 2 && !(r5.out + r5.err).includes("sk-FAKE"), `invalid line error does not echo file contents: "${r5.err.trim()}"`);
const okLine = path.join(tmp, "extra.jsonl"); fs.writeFileSync(okLine, '{"schema":"token-watcher-usage.v1","pool":"codex","period":"2026-10-05","source":"s","apiKey":"sk-FAKE_IN_FILE_555","dollars":1}\n');
runMain(["collect", "--input", okLine, "--ledger", path.join(tmp, "extra-ledger.jsonl")]);
verdict("d", !fs.readFileSync(path.join(tmp, "extra-ledger.jsonl"), "utf8").includes("sk-FAKE"), "unknown extra fields (apiKey) whitelisted out of the ledger");

// ---------- e) gitignore ----------
log("== e) gitignore and fixtures");
const gi = fs.readFileSync(`${WT}/.gitignore`, "utf8"); verdict("e", gi.includes("evals/spend-ledger/*.jsonl"), ".gitignore contains evals/spend-ledger/*.jsonl");
for (const p of ["evals/spend-ledger/ledger.jsonl", "evals/spend-ledger/2026-10.jsonl"]) {
  const r = spawnSync("git", ["-C", WT, "check-ignore", "-v", p], { encoding: "utf8" }); verdict("e", r.status === 0, `git check-ignore ${p}: ${r.stdout.trim()}`);
}
// default-ledger collect inside the worktree then git status
const before = execFileSync("git", ["-C", WT, "status", "--porcelain"], { encoding: "utf8" });
const so = cap(), se = cap(); const cd = cli.main(["collect", "--input", `${fx}/usage.jsonl`], { stdout: so, stderr: se, cwd: WT });
const after = execFileSync("git", ["-C", WT, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
verdict("e", cd === 0 && fs.existsSync(`${WT}/evals/spend-ledger/ledger.jsonl`) && !after.includes("spend-ledger"), `default collect wrote ${WT}/evals/spend-ledger/ledger.jsonl; git status shows it? ${after.includes("spend-ledger")} (status before="${before.trim()}", after="${after.trim()}")`);
fs.rmSync(`${WT}/evals/spend-ledger`, { recursive: true, force: true }); try { fs.rmdirSync(`${WT}/evals`); } catch {}
const tracked = execFileSync("git", ["-C", WT, "ls-files", "scripts/fixtures/spend-ledger", "evals"], { encoding: "utf8" }).trim().split("\n");
log("  tracked fixture/evals files:", tracked);
const fxText = tracked.filter((f) => f.startsWith("scripts/fixtures/spend-ledger")).map((f) => fs.readFileSync(`${WT}/${f}`, "utf8")).join("\n");
const sources = [...fxText.matchAll(/"source":"([^"]+)"/g)].map((m) => m[1]);
verdict("e", sources.every((s) => s === "synthetic") && /Synthetic test data only/.test(fxText) && !tracked.some((f) => f.startsWith("evals/spend-ledger")), `fixtures: sources=${[...new Set(sources)]}, README says synthetic, no tracked evals/spend-ledger files`);

// ---------- f) #835 export compatibility + #841 attribution ----------
log("== f) export compatibility with #835 @76c5c038 and #841 @d0509324");
const exportFile = path.join(tmp, "evals.jsonl");
const ex = runMain(["export-evals", "--ledger", path.join(tmp, "fx-ledger.jsonl"), "--out", exportFile]);
const exported = fs.readFileSync(exportFile, "utf8"); log("  export-evals:", ex, "\n" + exported);
const loaded = ev.loadLedger([exportFile]); log("  #835 loadLedger ->", loaded);
verdict("f", loaded.length === 3 && exported.trim().split("\n").length === 3, `#835 loadLedger accepted all ${loaded.length} exported lines (3 valued of 4 fixture records; 1 unvalued skipped: "${ex.err.trim()}")`);
const exRows = exported.trim().split("\n").map((l) => JSON.parse(l));
const fieldsOk = exRows.every((r) => typeof r.ts === "string" && /Z$/.test(r.ts) && Number.isFinite(r.usd) && r.usd >= 0 && (r.pr == null || Number.isInteger(r.pr)) && (r.issue == null || /^OVD-\d+$/.test(r.issue)));
log("  #845 export keys:", [...new Set(exRows.flatMap(Object.keys))], " #835 documented keys: ts,usd,pr,issue,agent,source; #835 loadLedger keeps: ts,usd,pr,issue");
verdict("f", fieldsOk, "field-by-field: ts(ISO Z) usd(finite>=0) pr(int>0, optional) issue(OVD-n, optional) match #835 validator; agent/source documented by #835, pool is extra and ignored");
// canonical ledger fed directly to #835 fails (doc warns)
let rawErr = null; try { ev.loadLedger([path.join(tmp, "fx-ledger.jsonl")]); } catch (e) { rawErr = e.message; }
log("  #835 loadLedger on canonical spend-ledger.v1 (with an unvalued row):", rawErr);
// #835 buildReport-level: total spend uses exported valued lines only
const totalExported = loaded.reduce((s, l) => s + l.usd, 0);
log(`  exported total usd = ${totalExported}; canonical ledger has 1 unvalued jev record that #835 cannot see (stderr-only note)`);

// #841 botAttribution
const snapPath = path.join(tmp, "trust-snapshot.json");
execFileSync("node", ["scripts/trust-metrics.mjs", "--window-end", "2026-10-04", "--prs-json", "scripts/fixtures/trust-metrics/bots-prs.json", "--comments-json", "scripts/fixtures/trust-metrics/bots-comments.json", "--out", snapPath], { cwd: "/workspace/qa-batch/wt841-845", stdio: ["ignore", "ignore", "ignore"] });
const snap = JSON.parse(fs.readFileSync(snapPath, "utf8")); log("  #841 snapshot keys:", Object.keys(snap), "botAttribution:", snap.botAttribution);
const prsFx = `${fx}/prs.json`;
const fA = runMain(["weekly", "--from", "2026-10-05", "--to", "2026-10-11", "--ledger", path.join(tmp, "fx-ledger.jsonl"), "--prs-json", prsFx, "--attribution", snapPath]);
log("  #845 weekly --attribution <#841 snapshot> ->", { code: fA.code, err: fA.err.trim() });
verdict("f", fA.code === 2, `#841 trust snapshot is not accepted directly as --attribution (exit ${fA.code}: ${fA.err.trim()}); needs pr-pool-attribution.v1 adapter (follow-up)`);
const fB = runMain(["weekly", "--from", "2026-10-05", "--to", "2026-10-11", "--ledger", path.join(tmp, "fx-ledger.jsonl"), "--prs-json", prsFx]);
const repF = JSON.parse(fB.out);
log("  without --attribution:", { code: fB.code, prs: repF.prs, sources: repF.sources });
verdict("f", fB.code === 0 && repF.sources.attributionLoaded === false && repF.prs.find((p) => p.number === 100).pool === "unknown", "attribution file absent -> runs, PRs without labels stay pool unknown/no_signal");

// ---------- g) npm run spend:ledger end-to-end ----------
log("== g) npm run spend:ledger on fixtures");
const L = path.join(tmp, "g-ledger.jsonl");
const npm = (args) => { const r = spawnSync("npm", ["run", "--silent", "spend:ledger", "--", ...args], { cwd: WT, encoding: "utf8" }); log(`  $ npm run spend:ledger -- ${args.join(" ")}\n  exit=${r.status}\n${r.stdout}${r.stderr ? "  stderr: " + r.stderr : ""}`); return r; };
const g1 = npm(["collect", "--input", "scripts/fixtures/spend-ledger/usage.jsonl", "--ledger", L]);
const g1b = npm(["collect", "--input", "scripts/fixtures/spend-ledger/usage.jsonl", "--ledger", L]);
const g2 = npm(["weekly", "--from", "2026-10-05", "--to", "2026-10-11", "--ledger", L, "--prs-json", "scripts/fixtures/spend-ledger/prs.json", "--attribution", "scripts/fixtures/spend-ledger/attribution.json", "--generated-at", "2026-10-12T00:00:00Z", "--format", "md"]);
const g3 = npm(["weekly", "--from", "2026-10-05", "--to", "2026-10-11", "--ledger", L, "--prs-json", "scripts/fixtures/spend-ledger/prs.json", "--attribution", "scripts/fixtures/spend-ledger/attribution.json", "--generated-at", "2026-10-12T00:00:00Z"]);
const g4 = npm(["export-evals", "--ledger", L]);
verdict("g", [g1, g1b, g2, g3, g4].every((r) => r.status === 0) && g1.stdout === g1b.stdout && JSON.parse(g3.stdout).schema === "spend-per-pr.v1" && !g2.stdout.includes("$0.00"), "collect (idempotent re-run), weekly md+json, export-evals all exit 0; md has no $0.00");

// ---------- h) new r2 probes ----------
log("== h) opus/sonnet -> claude pool");
const hp = [{ number: 201, mergedAt: "2026-10-06T00:00:00Z", labels: ["model:opus"] }, { number: 202, mergedAt: "2026-10-06T00:00:00Z", labels: [{ name: "model:sonnet" }] },
  { number: 203, mergedAt: "2026-10-06T00:00:00Z", labels: [] }, { number: 204, mergedAt: "2026-10-06T00:00:00Z", labels: [] }, { number: 205, mergedAt: "2026-10-06T00:00:00Z", labels: ["model:opus", "model:codex"] },
  { number: 206, mergedAt: "2026-10-06T00:00:00Z", labels: [] }, { number: 207, mergedAt: "2026-10-06T00:00:00Z", labels: [] }];
let attr; try { attr = lib.parseAttribution({ schema: "pr-pool-attribution.v1", prs: { "203": { bot: "opus" }, "204": { bot: "Sonnet" }, "206": { bot: "OPUS" } } }); } catch (e) { log("  parseAttribution shape err", e.message); }
if (!attr) { const doc = JSON.parse(fs.readFileSync(`${fx}/attribution.json`, "utf8")); log("  fixture attribution shape:", doc); }
const hl = [lib.usageToLedger({ ...base, pool: "claude", dollars: 10, period: "2026-10-06" })];
const hr = lib.weeklyReport({ ledger: hl, prs: hp, from: "2026-10-05", to: "2026-10-11", attribution: attr ?? {}, minSample: 1 });
for (const p of hr.prs) log("  pr", p.number, p.pool, p.attribution ?? p.reason ?? "");
const pool = (n) => hr.prs.find((p) => p.number === n)?.pool;
verdict("h", pool(201) === "claude" && pool(202) === "claude", `labels model:opus->${pool(201)}, model:sonnet->${pool(202)}`);
verdict("h", !attr || (pool(203) === "claude" && pool(204) === "claude" && pool(206) === "claude"), `attribution bots opus->${pool(203)} Sonnet->${pool(204)} OPUS->${pool(206)}`);
verdict("h", pool(205) !== "claude" && pool(205) !== "codex", `model:opus+model:codex -> ${pool(205)} (conflicting, not guessed)`);
try { lib.usageToLedger({ ...base, pool: "opus", dollars: 1 }, "p:1"); verdict("h", false, "pool:opus accepted as pool value"); } catch (e) { verdict("h", true, `pool value 'opus' rejected: ${e.message}`); }
log("== i) export completeness fields");
const il = path.join(tmp, "i-ledger.jsonl");
fs.writeFileSync(path.join(tmp, "i.jsonl"), [{ ...base, pool: "claude", dollars: 2 }, { ...base, pool: "codex", dollars: 1 }, { ...base, pool: "jev" }, { ...base, pool: "cursor", subscriptionShare: 0.1 , subscriptionUsd: 20 }, { ...base, pool: "cursor", period: "2026-10-06" }].map((r) => JSON.stringify(r)).join("\n"));
runMain(["collect", "--input", path.join(tmp, "i.jsonl"), "--ledger", il]);
const ie = runMain(["export-evals", "--ledger", il]); const iRows = ie.out.trim().split("\n").map((l) => JSON.parse(l));
log("  export:", ie.code, iRows, ie.err.trim());
verdict("i", ie.code === 0 && iRows.length === 3 && iRows.every((r) => r.exportUnvaluedRecords === 2 && r.exportComplete === false), "mixed ledger (3 valued, 2 unvalued): 3 lines, each exportUnvaluedRecords=2 exportComplete=false");
const ce = runMain(["export-evals", "--ledger", path.join(tmp, "fx-ledger.jsonl")]);
const fl = path.join(tmp, "full.jsonl"); fs.writeFileSync(path.join(tmp, "full-in.jsonl"), JSON.stringify({ ...base, pool: "claude", dollars: 2 }) + "\n"); runMain(["collect", "--input", path.join(tmp, "full-in.jsonl"), "--ledger", fl]);
const fe = runMain(["export-evals", "--ledger", fl]); const fRows = fe.out.trim().split("\n").map((l) => JSON.parse(l));
verdict("i", fe.code === 0 && fRows.every((r) => r.exportUnvaluedRecords === 0 && r.exportComplete === true), `all-valued ledger: exportUnvaluedRecords=0 exportComplete=true on every line (${JSON.stringify(fRows)})`);
log("== j) all-unvalued export exits 3");
const ul = path.join(tmp, "u.jsonl"); fs.writeFileSync(path.join(tmp, "u-in.jsonl"), [{ ...base, pool: "jev" }, { ...base, pool: "codex" }].map((r) => JSON.stringify(r)).join("\n")); runMain(["collect", "--input", path.join(tmp, "u-in.jsonl"), "--ledger", ul]);
const uo = path.join(tmp, "u-out.jsonl"); const ue = runMain(["export-evals", "--ledger", ul]); const ue2 = runMain(["export-evals", "--ledger", ul, "--out", uo]);
const ue3 = spawnSync("npm", ["run", "--silent", "spend:ledger", "--", "export-evals", "--ledger", ul], { cwd: WT, encoding: "utf8" });
log("  in-process:", ue, " --out:", ue2, fs.existsSync(uo) ? JSON.stringify(fs.readFileSync(uo, "utf8")) : "no file", " npm exit:", ue3.status, ue3.stderr.trim());
verdict("j", ue.code === 3 && ue.out === "" && ue3.status === 3 && /No valued records/.test(ue.err), `all-unvalued export exit ${ue.code} (npm ${ue3.status}), stdout empty, stderr "${ue.err.trim().replace(/\n/g, " | ")}"`);
const emptyL = path.join(tmp, "empty.jsonl"); fs.writeFileSync(emptyL, ""); const ee = runMain(["export-evals", "--ledger", emptyL]); log("  empty ledger export:", ee);
log("== k) #835 reader (head 76c5c038) accepts new export lines");
const kf = path.join(tmp, "k.jsonl"); fs.writeFileSync(kf, ie.out); const kl = ev.loadLedger([kf]); log("  loadLedger(mixed):", kl);
const kf2 = path.join(tmp, "k2.jsonl"); fs.writeFileSync(kf2, fe.out); const kl2 = ev.loadLedger([kf2]);
verdict("k", kl.length === 3 && kl2.length === fRows.length, `#835 loadLedger accepted ${kl.length}/3 mixed and ${kl2.length}/${fRows.length} complete lines with extra fields`);

log("== SUMMARY"); for (const [k, v] of Object.entries(results)) if (Array.isArray(v)) log(`${k}: ${v.every((x) => x.ok) ? "PASS" : "FAIL"} (${v.filter((x) => x.ok).length}/${v.length})`);
fs.rmSync(tmp, { recursive: true, force: true });
