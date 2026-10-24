// QA round 3 probe for PR #830 at 989892dc. Head vs round-2 (326f0452) vs main validators.
import fs from "node:fs";
import * as H from "/workspace/qa-batch/wt830c/scripts/validate-pr-body.mjs";
import * as R2 from "/workspace/qa-batch/wt830c/scripts/zz-r2-validate.mjs";
import * as M from "/workspace/qa-batch/wt830c/scripts/zz-main-validate.mjs";
import { renderPrBody } from "/workspace/qa-batch/wt830c/scripts/render-pr-body.mjs";

const EV = "https://github.com/optomachina/Overdrafter/pull/690";
const HI = H.PROVIDER_GO_LIVE_REQUIRED_ITEMS, MI = M.PROVIDER_GO_LIVE_REQUIRED_ITEMS;
const AUTO = HI.find((i) => i.auto);
const REAL = `- [x] ${AUTO.text}`;
const line = (it, o = {}) => it.auto ? `- [x] ${it.text}` : o.na ? `- [x] ${it.text.replace(/:$/, "").replace(/\s*Evidence$/, "")} N/A: ${o.na}` : `- [${o.unchecked ? " " : "x"}] ${it.text} ${o.noev ? "" : EV}`;
function section(items, ov = {}, extra = []) {
  const out = ["", "## Provider go-live", ""];
  for (const g of ["Envelope", "Live", "Admit", "Legal stance"]) { out.push(`### ${g}`, ""); for (const it of items) if (it.group === g && ov[it.id] !== null) out.push(line(it, ov[it.id])); out.push(""); }
  return out.concat(extra).join("\n");
}
const noEnv = { "envelope-reviewer": null };
const inject = (txt, base = section(HI, noEnv)) => base.replace("### Envelope\n", `### Envelope\n\n${txt}\n`);
const v = (mod, s) => mod.validateProviderGoLive(s);
const st = (e) => (e.length ? "FAIL" : "ok");
const rows = []; const blockers = []; const obs = [];
function c(group, name, body, expect, opts = {}) {
  const h = v(H, body), r2 = v(R2, body);
  const got = st(h);
  const pass = expect === "any" ? true : got === expect && (!opts.err || h.some((e) => e.includes(opts.err)));
  if (!pass && expect === "FAIL" && got === "ok") blockers.push(`${name}: expected FAIL, got ok`);
  if (st(r2) === "FAIL" && got === "ok" && expect !== "ok" ) blockers.push(`${name}: FAIL at 326f -> ok at head`);
  if (opts.obs) obs.push(`${name}: head=${got} r2=${st(r2)} ${opts.obs}`);
  rows.push({ group, name, expect, head: got, r2: st(r2), result: pass ? "PASS" : "MISMATCH", errs: h.join(" | ") });
}

// A. envelope auto line
c("A auto", "unticked real '- [ ] Envelope reviewed (automatic). Signed: ...'", inject(`- [ ] ${AUTO.text}`), "FAIL", { err: '"envelope reviewed (automatic)" must be ticked' });
c("A auto", "unticked plain '- [ ] envelope reviewed (automatic)'", inject("- [ ] envelope reviewed (automatic)"), "FAIL", { err: "must be ticked" });
c("A auto", "unticked bold '- [ ] **Envelope reviewed (automatic).** Signed: x'", inject("- [ ] **Envelope reviewed (automatic).** Signed: x"), "FAIL", { err: "must be ticked" });
c("A auto", "unticked '* [ ] Envelope reviewed (automatic)'", inject("* [ ] Envelope reviewed (automatic)"), "FAIL", { err: "must be ticked" });
c("A auto", "missing auto line", section(HI, noEnv), "FAIL", { err: 'missing Provider go-live item "envelope reviewed (automatic)"' });
c("A auto", "auto text only on continuation line", inject("- [x] Signed: Grok Bot\n  Envelope reviewed (automatic)"), "FAIL", { err: "missing Provider go-live item" });
c("A auto", "prose only 'Envelope reviewed (automatic) is pending.'", inject("Envelope reviewed (automatic) is pending."), "FAIL");
c("A auto", "quoted '> - [x] envelope reviewed (automatic)' only", inject("> - [x] envelope reviewed (automatic)"), "FAIL");
c("A auto", "mid-line 'Note: - [x] envelope reviewed (automatic)'", inject("Note: - [x] envelope reviewed (automatic)"), "FAIL");
c("A auto", "unticked real + ticked real", inject(`- [ ] ${AUTO.text}\n${REAL}`), "FAIL");
c("A auto", "two ticked real lines", inject(`${REAL}\n${REAL}`), "FAIL");
c("A auto", "'- [ ] not envelope reviewed' only", inject("- [ ] not envelope reviewed"), "FAIL");
c("A auto", "'- [ ] envelope reviewed? NO' only", inject("- [ ] envelope reviewed? NO"), "FAIL");
c("A auto", "'- [x] not envelope reviewed' (no link) only", inject("- [x] not envelope reviewed"), "FAIL");
c("A auto", "real + '- [ ] not envelope reviewed' before it", inject(`- [ ] not envelope reviewed\n${REAL}`), "FAIL");
c("A auto", "<!-- comment-only text --> after box: '- [x] <!-- envelope reviewed (automatic) -->'", inject("- [x] <!-- envelope reviewed (automatic) -->"), "FAIL");
// B. ticked forms pass
c("B ticked", "full rendered checklist (ticked real)", section(HI), "ok");
c("B ticked", "ticked plain '- [x] envelope reviewed (automatic)'", inject("- [x] envelope reviewed (automatic)"), "ok");
c("B ticked", "ticked bold '- [x] **Envelope reviewed (automatic).** Signed: Grok Bot ...'", inject(`- [x] **Envelope reviewed (automatic).** Signed: ${H.PROVIDER_GO_LIVE_AUTO_SIGNATURE}`), "ok");
c("B ticked", "ticked '__Envelope reviewed (automatic)__'", inject("- [x] __Envelope reviewed (automatic)__"), "ok");
c("B ticked", "'* [X] Envelope reviewed (automatic)'", inject("* [X] Envelope reviewed (automatic)"), "ok");
c("B ticked", "'+ [x] Envelope reviewed (automatic)'", inject("+ [x] Envelope reviewed (automatic)"), "ok");
c("B ticked", "'1. [x] Envelope reviewed (automatic)'", inject("1. [x] Envelope reviewed (automatic)"), "ok");
c("B ticked", "'1) [x] Envelope reviewed (automatic)'", inject("1) [x] Envelope reviewed (automatic)"), "ok");
c("B ticked", "nested '  - [x] Envelope reviewed (automatic)'", inject("  - [x] Envelope reviewed (automatic)"), "ok");
c("B ticked", "real line + trailing <!-- note -->", inject(`${REAL} <!-- note -->`), "ok");
c("B ticked", "bare ticked auto line, no signature (accepted)", inject("- [x] Envelope reviewed (automatic)"), "ok");
c("B ticked", "manual items with '+' / '1.' markers", section(HI).replace(/^- \[x\] (provider:check)/m, "+ [x] $1").replace(/^- \[x\] (No stored)/m, "1. [x] $1"), "ok");
c("B ticked", "manual item unticked with '+' marker", section(HI).replace(/^- \[x\] (provider:check)/m, "+ [ ] $1"), "FAIL");
c("B ticked", "manual item nested '- - [ ]' unticked", section(HI).replace(/^- \[x\] (No stored)/m, "- - [ ] $1"), "FAIL");
// C. fences
const F = (open, inner, close = open) => `${open}\n${inner}\n${close}`;
c("C fence", "``` ticked auto inside, no real", inject(F("```", "- [x] envelope reviewed (automatic)")), "FAIL", { err: "missing Provider go-live item" });
c("C fence", "``` unticked auto inside, no real", inject(F("```", "- [ ] envelope reviewed (automatic)")), "FAIL", { err: "missing Provider go-live item" });
c("C fence", "~~~ ticked auto inside, no real", inject(F("~~~", "- [x] envelope reviewed (automatic)")), "FAIL", { err: "missing Provider go-live item" });
c("C fence", "```` longer fence with inner ``` and ticked auto, no real", inject(F("````md", "```\n- [x] envelope reviewed (automatic)\n```", "````")), "FAIL", { err: "missing Provider go-live item \"envelope reviewed (automatic)\"" });
c("C fence", "```` longer fence (closed by ````) + real outside", inject(`${F("````md", "```\n- [ ] envelope reviewed (automatic)\n```", "````")}\n${REAL}`), "ok");
c("C fence", "~~~~ longer tilde fence with ~~~ inside, no real", inject(F("~~~~", "~~~\n- [x] envelope reviewed (automatic)\n~~~")), "FAIL");
c("C fence", "``` ticked auto inside + real ticked outside", inject(`${F("```", "- [x] envelope reviewed (automatic)")}\n${REAL}`), "ok");
c("C fence", "``` unticked auto inside + real ticked outside", inject(`${F("```", "- [ ] envelope reviewed (automatic)")}\n${REAL}`), "ok");
c("C fence", "~~~ unticked real inside + real ticked outside", inject(`${F("~~~", `- [ ] ${AUTO.text}`)}\n${REAL}`), "ok");
c("C fence", "3-space indented ``` fence, ticked inside, no real", inject(F("   ```", "- [x] envelope reviewed (automatic)", "   ```")), "FAIL");
c("C fence", "3-space indented ~~~ fence + real outside", inject(`${F("   ~~~", "- [ ] envelope reviewed (automatic)", "   ~~~")}\n${REAL}`), "ok");
c("C fence", "fence in list item, ticked inside, no real", inject("- item\n  ```\n  - [x] envelope reviewed (automatic)\n  ```"), "FAIL");
c("C fence", "fence opened after list marker '- ```', no real", inject("- ```\n  - [x] envelope reviewed (automatic)\n  ```"), "FAIL");
c("C fence", "fence in list item + real outside", inject(`- item\n  \`\`\`\n  - [ ] envelope reviewed (automatic)\n  \`\`\`\n${REAL}`), "ok");
c("C fence", "fence in blockquote, ticked inside, no real", inject("> ```\n> - [x] envelope reviewed (automatic)\n> ```"), "FAIL");
c("C fence", "fence in blockquote + real outside", inject(`> \`\`\`\n> - [ ] envelope reviewed (automatic)\n> \`\`\`\n\n${REAL}`), "ok");
c("C fence", "unclosed ``` fence then auto line", inject("```\n- [x] envelope reviewed (automatic)"), "FAIL");
c("C fence", "~~~ not closed by ```, auto after", inject("~~~\n```\n- [x] envelope reviewed (automatic)"), "FAIL");
c("C fence", "manual item only inside fence (real one removed)", section(HI, { "provider-check": null }).replace("### Live\n", "### Live\n\n```\n- [x] provider:check green. Evidence: " + EV + "\n```\n"), "FAIL", { err: "missing Provider go-live item" });
c("C fence", "ambiguous fence end (accepted fail-closed)", inject(`- a\n    - b\n  \`\`\`\n  x\n    \`\`\`\n${REAL}`), "any", { obs: "(ambiguous fence end; accepted safe-side rejection if FAIL)" });
c("C fence", "4-space-indented ``` then real line (accepted safe-side)", inject(`para\n\n    \`\`\`\n\n${REAL}`), "any", { obs: "(4-space ``` is indented code on GitHub; accepted safe-side rejection if FAIL)" });
c("C fence", "4-space indented code block holding ticked auto line (not a fence)", inject("Para text.\n\n    - [x] envelope reviewed (automatic)"), "any", { obs: "(GitHub renders this as an indented code block; pre-existing, also on main/326f)" });
// D. HTML comments
c("D comment", "single-line <!-- - [x] envelope reviewed (automatic) -->, no real", inject("<!-- - [x] envelope reviewed (automatic) -->"), "FAIL");
c("D comment", "multi-line comment with ticked auto, no real", inject("<!--\n- [x] envelope reviewed (automatic)\n-->"), "FAIL");
c("D comment", "multi-line comment with real ticked auto line, no real", inject(`<!--\n${REAL}\n-->`), "FAIL");
c("D comment", "manual item only inside comment", section(HI, { "provider-check": null }).replace("### Live\n", "### Live\n\n<!--\n- [x] provider:check green. Evidence: " + EV + "\n-->\n"), "FAIL");
c("D comment", "comment with unticked auto + real outside", inject(`<!-- - [ ] envelope reviewed (automatic) -->\n${REAL}`), "ok");
c("D comment", "evidence link only inside comment on manual item", section(HI).replace(`provider:check green. Evidence: ${EV}`, `provider:check green. Evidence: <!-- ${EV} -->`), "FAIL");
// E. duplicate headings
const full = section(HI);
c("E dup", "second '## Provider go-live' section", full + "\n" + full, "FAIL", { err: "appears 2 times" });
c("E dup", "second '### Provider go-live' heading", full + "\n### Provider go-live\n\n- [ ] x\n", "FAIL", { err: "appears" });
c("E dup", "<h2>Provider go-live</h2>", full + "\n<h2>Provider go-live</h2>\n", "FAIL", { err: "appears" });
c("E dup", "setext 'Provider go-live\\n---'", full + "\n\nProvider go-live\n---\n", "FAIL", { err: "appears" });
c("E dup", "'> ## Provider go-live' in blockquote", full + "\n> ## Provider go-live\n", "FAIL", { err: "appears" });
c("E dup", "heading inside ``` fence (must not count)", full + "\n```\n## Provider go-live\n```\n", "ok");
c("E dup", "single-line <!-- ## Provider go-live --> (not a heading)", full + "\n<!-- ## Provider go-live -->\n", "any", { obs: "(not a heading line)" });
c("E dup", "multi-line commented-out heading (accepted safe-side)", full + "\n<!--\n## Provider go-live\n-->\n", "any", { obs: "(commented-out heading; accepted safe-side rejection if FAIL)" });
c("E dup", "go-live section placed inside an HTML comment, real one absent", "## Summary\n\nx\n\n<!--" + full + "\n-->\n", "FAIL");
// F. removed items / supplier-switch / N/A rules
for (const id of ["envelope-reviewer", "rollback", "kill-switch", "same-day-off", "rate-limit", "no-evasion"]) {
  if (id === "envelope-reviewer") continue; // auto now; covered in A
  c("F items", `omit removed item ${id} (old list minus it, new list)`, section(HI), "ok");
  const mm = st(v(M, section(MI, { [id]: null })));
  rows.push({ group: "F items", name: `main: omit ${id} from old list`, expect: "FAIL", head: "-", r2: "-", result: mm === "FAIL" ? "PASS" : "MISMATCH", errs: "main=" + mm });
}
c("F items", "old named-reviewer line 'Envelope reviewed by a named reviewer' instead of auto", section(MI).includes("named reviewer") ? section(HI, noEnv).replace("### Envelope\n", `### Envelope\n\n- [x] Envelope reviewed by a named reviewer. Evidence: ${EV}\n`) : "", "FAIL");
c("F items", "supplier-switch omitted", section(HI, { "supplier-switch": null }), "FAIL");
c("F items", "supplier-switch N/A", section(HI, { "supplier-switch": { na: "not applicable to this quote-only stage" } }), "FAIL");
c("F items", "supplier-switch unticked", section(HI, { "supplier-switch": { unchecked: true } }), "FAIL");
c("F items", "supplier-switch no evidence", section(HI, { "supplier-switch": { noev: true } }), "FAIL");
c("F items", "no-passwords N/A", section(HI, { "no-passwords": { na: "not applicable to this quote-only stage" } }), "FAIL");
c("F items", "no-passwords omitted", section(HI, { "no-passwords": null }), "FAIL");
c("F items", "provider-check N/A", section(HI, { "provider-check": { na: "not applicable to this quote-only stage" } }), "FAIL");
c("F items", "export-control N/A (US-only, allowed)", section(HI, { "export-control": { na: "US only provider, no export controls apply" } }), "ok");
c("F items", "supplier-switch text containing 'envelope reviewed (automatic)'", full.replace("Per-supplier on/off switch", "envelope reviewed (automatic); Per-supplier on/off switch"), "ok");
const mNew = st(v(M, full));
rows.push({ group: "F items", name: "main validator on new checklist (loosening/replacement)", expect: "FAIL", head: "-", r2: "-", result: mNew === "FAIL" ? "PASS" : "MISMATCH", errs: "main=" + mNew });

// G. PR's own body, rendered body, template
const prBody = fs.readFileSync("/workspace/qa-batch/830-body-r3.md", "utf8");
const changedFiles = [".codex/skills/add-quote-provider/SKILL.md", ".github/pull_request_template.md", "docs/checklists/provider-go-live-checklist.md", "scripts/render-pr-body.mjs", "scripts/render-pr-body.test.mjs", "scripts/validate-pr-body.mjs", "scripts/validate-pr-body.test.mjs"];
const own = H.validatePrBody(prBody, { changedFiles }), ownM = M.validatePrBody(prBody, { changedFiles });
rows.push({ group: "G own", name: "PR #830 body, validatePrBody(changedFiles) head", expect: "ok", head: own.ok ? "ok" : "FAIL", r2: "-", result: own.ok ? "PASS" : "MISMATCH", errs: own.errors.join(" | ") });
rows.push({ group: "G own", name: "PR #830 body, validatePrBody(changedFiles) main (what CI runs)", expect: "ok", head: ownM.ok ? "ok" : "FAIL", r2: "-", result: ownM.ok ? "PASS" : "MISMATCH", errs: ownM.errors.join(" | ") });
const pgl = Object.fromEntries(HI.filter((i) => !i.auto).map((i) => [i.id, { evidence: EV }]));
const input = { summary: ["s"], problem: ["p"], scope: ["sc"], verification: { allPassed: true, usedVerify: false, usedNarrowVerification: true, hasOtherVerification: true, commands: ["npm test"], results: ["All listed verification passed."] }, tests: ["t"], migrationNotes: { hasImpact: false }, rollbackRisks: ["r"], documentation: { updated: false }, providerGoLive: pgl };
const rendered = renderPrBody(input);
c("G own", "render-pr-body output, all evidence", rendered, "ok");
const vr = H.validatePrBody(rendered);
rows.push({ group: "G own", name: "render-pr-body output, validatePrBody", expect: "ok", head: vr.ok ? "ok" : "FAIL", r2: "-", result: vr.ok ? "PASS" : "MISMATCH", errs: vr.errors.join(" | ") });
const pglNa = { ...pgl, "worker-secret": { na: "not applicable to this quote-only stage" } };
c("G own", "render-pr-body output with a valid N/A", renderPrBody({ ...input, providerGoLive: pglNa }), "ok");
const tpl = fs.readFileSync("/workspace/qa-batch/wt830c/.github/pull_request_template.md", "utf8");
const filled = tpl.replace(/^(- )\[ \] (.*(?:Evidence:|evidence:))$/gm, `$1[x] $2 ${EV}`);
c("G own", "PR template Provider go-live, items ticked + evidence (auto pre-checked as shipped)", filled, "ok");
c("G own", "PR template as shipped (unfilled)", tpl, "FAIL");

// H. recent PR bodies: head vs main
const dir = "/workspace/qa-batch/830-r3-bodies";
let same = 0, diff = [], n = 0, glN = 0;
for (const f of fs.readdirSync(dir).sort()) {
  const b = fs.readFileSync(`${dir}/${f}`, "utf8"); n++;
  const h = H.validatePrBody(b), m = M.validatePrBody(b);
  const hs = h.ok + "|" + h.errors.join("|"), ms = m.ok + "|" + m.errors.join("|");
  let gl = "";
  if (/provider go-live/i.test(b)) { glN++; gl = ` gl head=${st(v(H, b))} main=${st(v(M, b))}`; }
  if (hs === ms) same++; else diff.push(`${f}: head ok=${h.ok} main ok=${m.ok} :: head[${h.errors.join("; ")}] main[${m.errors.join("; ")}]`);
  if (gl) obs.push(`body ${f}:${gl}`);
}
rows.push({ group: "H recent", name: `${n} recent PR bodies (98 merged + 18 open), validatePrBody head vs main`, expect: "same", head: `${same}/${n} identical`, r2: "-", result: diff.length ? "DIFF" : "PASS", errs: diff.join(" || ") });

// output
const pad = (s, w) => String(s).padEnd(w);
for (const r of rows) console.log(`${pad(r.result, 9)}${pad(r.group, 11)}exp=${pad(r.expect, 5)} head=${pad(r.head, 5)} r2=${pad(r.r2, 5)} ${r.name}${r.errs ? "  -> " + r.errs.slice(0, 400) : ""}`);
console.log("\nSUMMARY:", rows.filter((r) => r.result === "PASS").length, "PASS /", rows.length, "rows; mismatches:", rows.filter((r) => !["PASS"].includes(r.result)).map((r) => r.name).join("; ") || "none");
console.log("BLOCKERS (FAIL->ok):", blockers.length ? blockers.join("; ") : "none");
console.log("OBSERVATIONS:\n  " + obs.join("\n  "));
