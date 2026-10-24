// QA probes for #813 (read-only, local). Run from the PR worktree.
import { loadConfig, classifyPath, classifySql, detect, detectGateLoosening, compileConfig } from "./scripts/sensitive-class-detect.mjs";
import { createMatcher, parseSensitivePaths, readSensitivePathsText, findGateLoosening } from "./scripts/lib/sensitive-paths.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
let pass=0, fail=0;
const ok=(name,cond,info="")=>{ (cond?pass++:fail++); console.log(`${cond?"PASS":"FAIL"} ${name}${info?" :: "+info:""}`); };
const { config, errors } = loadConfig({ root: process.cwd() });
ok("P0 config loads", config && errors.length===0, JSON.stringify(errors));
// P1 verify-result-judge globs
const mainText = execFileSync("git",["show","origin/main:docs/sensitive-paths.json"],{encoding:"utf8"});
const mainM = createMatcher(parseSensitivePaths(mainText));
for (const p of ["scripts/verify-result-judge.mjs","scripts/verify-result-judge.test.mjs","scripts/verify-result-judge-v2.mjs","scripts/verify-result-judge/lib.mjs"]) {
  const r = classifyPath(p, config); const m = mainM.match(p).map(e=>e.class);
  ok(`P1 ${p} infra_ci at head`, r.classes.includes("infra_ci"), `head=${JSON.stringify(r.classes)} reasons=${r.reasons.join(",")} main=${JSON.stringify(m)}`);
}
ok("P1 near-miss scripts/verify-result.mjs not caught by judge glob", !classifyPath("scripts/verify-result.mjs",config).reasons.some(r=>r.includes("verify-result-judge")), JSON.stringify(classifyPath("scripts/verify-result.mjs",config)));
// verify.yml runs base/scripts/verify-result-judge.mjs
const vy = fs.readFileSync(".github/workflows/verify.yml","utf8");
ok("P1 verify.yml invokes scripts/verify-result-judge.mjs", /node base\/scripts\/verify-result-judge\.mjs/.test(vy));
// P2 classes table rows
const rows = { "supabase/migrations/20260101_x.sql":"migrations", "src/features/auth/x.tsx":"auth", "src/pages/checkout/a.tsx":"payments", "worker/src/adapters/x.ts":"provider_dispatch", ".env.local":"secrets", ".github/workflows/x.yml":"infra_ci", "package-lock.json":"deps", "scripts/deploy-x.sh":"infra_ci", "docs/migration-drafts/x.sql":"schema" };
for (const [p,c] of Object.entries(rows)) { const r=classifyPath(p,config); ok(`P2 ${p} -> ${c}`, r.classes.includes(c), JSON.stringify(r.classes)); }
ok("P2 e2e/fixtures/a.sql not tests category", classifyPath("e2e/fixtures/a.sql",config).category!=="tests", JSON.stringify(classifyPath("e2e/fixtures/a.sql",config)));
ok("P2 docs/guide.md -> docs safe", (r=>r.classes.length===0 && r.category==="docs")(classifyPath("docs/guide.md",config)), JSON.stringify(classifyPath("docs/guide.md",config)));
// P3 SQL
const s = (t)=>classifySql(t,config);
ok("P3 policy -> rls", JSON.stringify(s("create policy p on t using (true);")).includes("rls"), JSON.stringify(s("create policy p on t using (true);")));
ok("P3 definer -> definer", JSON.stringify(s("create function f() returns int language sql security definer as 'select 1';")).includes("definer"));
ok("P3 definer in -- comment -> no definer", !JSON.stringify(s("-- security definer\nselect 1;")).includes("definer"), JSON.stringify(s("-- security definer\nselect 1;")));
ok("P3 definer in /* */ -> no definer", !JSON.stringify(s("/* security definer */ select 1;")).includes("definer"));
ok("P3 $$ string: flagged (documented fail-closed deviation)", JSON.stringify(s("select $$ security definer $$;")).includes("definer"));
// P4 detect: unknown, rename, delete, multi, errors
const read = async (p)=> p.endsWith(".sql") ? "create policy p on t;" : "";
let r = await detect({ files:[{filename:"worker/foo.go",status:"added"}], readHeadFile:read, config, sha:"a".repeat(40) });
ok("P4 worker/foo.go -> unclassified, counts sensitive", r.status==="ok" && r.unclassified.includes("worker/foo.go") && r.classes.includes("unclassified"), JSON.stringify({c:r.classes,u:r.unclassified,n:r.sensitive_count}));
r = await detect({ files:[{filename:"docs/x.md",status:"renamed",previous_filename:"src/features/auth/x.md"}], readHeadFile:read, config });
ok("P4 rename from sensitive old path counts", r.classes.includes("auth"), JSON.stringify(r.classes));
r = await detect({ files:[{filename:"supabase/migrations/1_x.sql",status:"removed"}], readHeadFile:read, config });
ok("P4 deleted migration still classified", r.classes.includes("migrations"), JSON.stringify(r.classes));
r = await detect({ files:[{filename:"src/features/auth/a.ts",status:"modified"},{filename:"package.json",status:"modified"}], readHeadFile:read, config });
ok("P4 multi_class", r.multi_class===true, JSON.stringify(r.classes));
r = await detect({ files:[], readHeadFile:read, config });
ok("P4 empty list -> error", r.status==="error", JSON.stringify(r.errors));
r = await detect({ files:[{filename:"",status:"added"}], readHeadFile:read, config });
ok("P4 blank path -> error", r.status==="error");
const bad = compileConfig({ version:1, classes:{}, sql_content:{paths:[],rules:[]}, safe_categories:{} });
ok("P4 config with classes section / unknown key -> errors", bad.errors.length>0, bad.errors[0]);
const bad2 = compileConfig({ version:1, sql_content:{paths:["**/*.sql"],rules:[]}, safe_categories:{}, bogus:1 });
ok("P4 unknown rule key -> errors", bad2.errors.length>0, bad2.errors[0]);
// P5 gate_loosening
const baseRaw = JSON.parse(fs.readFileSync("scripts/sensitive-classes.json","utf8"));
const rm = structuredClone(baseRaw); rm.sql_content.rules = rm.sql_content.rules.filter(x=>x.class!=="definer");
let g = detectGateLoosening({ baseRaw, headRaw: rm, gateFiles:[{path:"scripts/sensitive-classes.json",status:"modified"}] });
ok("P5 removing SQL rule -> gate_loosening", g.detected===true, JSON.stringify(g.reasons.map(x=>x.kind)));
const add = structuredClone(baseRaw); add.sql_content.rules.push({class:"rls",tokens:["grant"]});
g = detectGateLoosening({ baseRaw, headRaw: add, gateFiles:[{path:"scripts/sensitive-classes.json",status:"modified"}] });
ok("P5 adding SQL rule -> no gate_loosening", g.detected===false, JSON.stringify(g.reasons.map(x=>x.kind)));
const mv = structuredClone(baseRaw); const k0 = Object.keys(mv.safe_categories)[0]; mv.safe_categories[k0].paths = [...(mv.safe_categories[k0].paths||[]), "worker/**"];
g = detectGateLoosening({ baseRaw, headRaw: mv, gateFiles:[{path:"scripts/sensitive-classes.json",status:"modified"}] });
ok("P5 moving a path into a safe category -> gate_loosening", g.detected===true, JSON.stringify(g.reasons.map(x=>x.kind)));
const headText = readSensitivePathsText({ root: process.cwd() });
const noJudge = JSON.parse(headText); noJudge.globs = noJudge.globs.filter(x=>x.glob!=="scripts/verify-result-judge*");
const fl = findGateLoosening({ baseText: headText, headText: JSON.stringify(noJudge), changedFiles:["docs/sensitive-paths.json"] });
ok("P5 removing verify-result-judge* glob from shared list -> loosening (glob_removed)", JSON.stringify(fl).includes("glob_removed"), JSON.stringify(fl).slice(0,200));
const vsMain = findGateLoosening({ baseText: mainText, headText, changedFiles:["docs/sensitive-paths.json"] });
ok("P5 head list vs main: no glob loosening", !/glob_(removed|narrowed|reclassified)/.test(JSON.stringify(vsMain)), JSON.stringify(vsMain).slice(0,200));
const mg = JSON.parse(mainText).globs.length, hg = JSON.parse(headText).globs.length;
ok("P5 glob counts main->head", hg>=mg, `${mg} -> ${hg}`);
console.log(`\nprobes: ${pass} pass, ${fail} fail`);
