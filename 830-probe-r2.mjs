import * as H from "/workspace/qa-batch/wt830/scripts/validate-pr-body.mjs";
import * as M from "/workspace/qa-batch/wt830/scripts/zz-main-validate.mjs";
const EV = "https://github.com/optomachina/Overdrafter/pull/690";
const line = (it, o = {}) => it.auto ? `- [x] ${it.text}` : o.na ? `- [x] ${it.text.replace(/:$/, "").replace(/\s*Evidence$/, "")} N/A: ${o.na}` : `- [${o.unchecked ? " " : "x"}] ${it.text} ${o.noev ? "" : EV}`;
function section(items, ov = {}, extra = []) {
  const out = ["", "## Provider go-live", ""];
  for (const g of ["Envelope", "Live", "Admit", "Legal stance"]) { out.push(`### ${g}`, ""); for (const it of items) if (it.group === g && ov[it.id] !== null) out.push(line(it, ov[it.id])); out.push(""); }
  return out.concat(extra).join("\n");
}
const v = (mod, s) => mod.validateProviderGoLive(s);
const r = (name, errs) => console.log((errs.length ? "FAIL " : "ok   ") + name + (errs.length ? "  -> " + errs.join(" | ") : ""));
const HI = H.PROVIDER_GO_LIVE_REQUIRED_ITEMS, MI = M.PROVIDER_GO_LIVE_REQUIRED_ITEMS;
const ids = (a) => a.map((i) => i.id + (i.auto ? "(auto)" : "") + (i.na ? "[na-ok]" : ""));
console.log("main ids:", ids(MI).join(", ")); console.log("head ids:", ids(HI).join(", "));
console.log("removed from required:", MI.filter((m) => !HI.some((h) => h.id === m.id && !h.auto)).map((m) => m.id).join(", "));
console.log("added:", HI.filter((h) => !MI.some((m) => m.id === h.id)).map((h) => `${h.id} na=${h.na} group=${h.group}`).join(", "));
r("head: full new checklist", v(H, section(HI)));
r("main: same new checklist (shows loosening/replacement)", v(M, section(HI)));
for (const id of ["envelope-reviewer", "rollback", "kill-switch", "same-day-off", "rate-limit", "no-evasion"]) {
  const s = section(HI, { [id]: null });
  r(`head: omit ${id}`, v(H, s));
  r(`main: omit ${id} from full old list`, v(M, section(MI, { [id]: null })));
}
r("head: old main checklist body as-is", v(H, section(MI)));
r("head: omit supplier-switch", v(H, section(HI, { "supplier-switch": null })));
r("head: supplier-switch N/A", v(H, section(HI, { "supplier-switch": { na: "not applicable to this quote-only stage" } })));
r("head: supplier-switch unchecked", v(H, section(HI, { "supplier-switch": { unchecked: true } })));
r("head: supplier-switch no evidence", v(H, section(HI, { "supplier-switch": { noev: true } })));
r("head: no-passwords N/A", v(H, section(HI, { "no-passwords": { na: "not applicable to this quote-only stage" } })));
r("head: no-passwords omitted", v(H, section(HI, { "no-passwords": null })));
r("head: itar N/A (US-only, unchanged)", v(H, section(HI, { ["itar"]: { na: "US only provider, no export controls" } })));
const env = HI.find((i) => i.auto);
const noEnv = { "envelope-reviewer": null };
const probes = {
  "unchecked '- [ ] not envelope reviewed' instead of auto line": ["- [ ] not envelope reviewed"],
  "unchecked '- [ ] Envelope reviewed by a named reviewer. Evidence:' (no link)": ["- [ ] Envelope reviewed by a named reviewer. Evidence:"],
  "unchecked '- [ ] envelope reviewed? NO - reviewer refused'": ["- [ ] envelope reviewed? NO - reviewer refused"],
  "'- [ ] Envelope NOT reviewed' (no regex match)": ["- [ ] Envelope NOT reviewed"],
};
for (const [n, extra] of Object.entries(probes)) r("head: " + n, v(H, section(HI, noEnv, extra)));
r("head: auto line + a second unchecked 'not envelope reviewed'", v(H, section(HI, {}, ["- [ ] not envelope reviewed"])));
r("head: unchecked 'not envelope reviewed' placed BEFORE the auto line", v(H, section(HI, noEnv).replace("### Envelope\n", "### Envelope\n\n- [ ] not envelope reviewed\n" + line(env) + "\n")));
r("head: supplier-switch line text mentioning 'envelope reviewed' (theft check)", v(H, section(HI, { "envelope-reviewer": null, "supplier-switch": { noev: false } }).replace("Per-supplier on/off switch", "Envelope reviewed; Per-supplier on/off switch")));
r("head: export-control N/A (US-only)", v(H, section(HI, { "export-control": { na: "US only provider, no export controls apply" } })));
r("main: export-control N/A (US-only)", v(M, section(MI, { "export-control": { na: "US only provider, no export controls apply" } })));
r("head: provider-check N/A (must fail)", v(H, section(HI, { "provider-check": { na: "not applicable to this quote-only stage" } })));
r("head: 'not envelope reviewed' unchecked line in Legal stance group, no auto line", v(H, section(HI, noEnv) + "\n- [ ] not envelope reviewed\n"));
console.log("\n=== round 2 (326f0452) envelope probes; base = full manual items, NO real auto line, plus the variant ===");
const AUTO = HI.find((i) => i.auto);
const consumed = (txt) => { const b = { line: txt, text: txt.replace(/^[ \t]*[-*][ \t]+\[[ xX]\][ \t]*/, "") }; return AUTO.match.test(b.line) || /^envelope reviewed \(automatic\)/i.test(b.text); };
const variants = {
  "- [ ] not envelope reviewed": "- [ ] not envelope reviewed",
  "- [ ] envelope reviewed? NO": "- [ ] envelope reviewed? NO",
  "prose: 'The envelope reviewed (automatic) item is pending.'": "The envelope reviewed (automatic) item is pending.",
  "unticked real: '- [ ] Envelope reviewed (automatic). Signed: …'": `- [ ] ${AUTO.text}`,
  "unticked real bold": "- [ ] **Envelope reviewed (automatic).** Signed: x",
  "code fence ticked": "```\n- [x] envelope reviewed (automatic)\n```",
  "code fence unticked": "```\n- [ ] envelope reviewed (automatic)\n```",
  "blockquote ticked '> - [x] envelope reviewed (automatic)'": "> - [x] envelope reviewed (automatic)",
  "mid-line 'Note: - [x] envelope reviewed (automatic)'": "Note: - [x] envelope reviewed (automatic)",
  "ticked lookalike '- [x] not envelope reviewed' (no link)": "- [x] not envelope reviewed",
  "ticked real": `- [x] ${AUTO.text}`,
  "ticked plain '- [x] envelope reviewed (automatic)'": "- [x] envelope reviewed (automatic)",
  "ticked bold '- [x] **Envelope reviewed (automatic).** Signed: …'": "- [x] **Envelope reviewed (automatic).** Signed: Grok Bot under Blaine Wilson standing authority",
  "ticked '* [X] Envelope reviewed (automatic)'": "* [X] Envelope reviewed (automatic)",
};
for (const [n, extra] of Object.entries(variants)) {
  const errs = v(H, section(HI, noEnv).replace("### Envelope\n", `### Envelope\n\n${extra}\n`));
  const lines = extra.split("\n").filter((l) => /^[ \t]*[-*][ \t]+\[[ xX]\]/.test(l));
  r(`${n}  [box-lines consumed by auto: ${lines.length ? lines.map(consumed).join(",") : "n/a (not a checkbox line)"}]`, errs);
}
r("auto line + unticked lookalike before it", v(H, section(HI, noEnv).replace("### Envelope\n", `### Envelope\n\n- [ ] not envelope reviewed\n- [x] ${AUTO.text}\n`)));
r("unticked real BEFORE ticked real (only one consumed?)", v(H, section(HI, noEnv).replace("### Envelope\n", `### Envelope\n\n- [ ] ${AUTO.text}\n- [x] ${AUTO.text}\n`)));
r("two ticked real lines", v(H, section(HI, noEnv).replace("### Envelope\n", `### Envelope\n\n- [x] ${AUTO.text}\n- [x] ${AUTO.text}\n`)));
r("supplier-switch line text containing 'envelope reviewed (automatic)'", v(H, section(HI).replace("Per-supplier on/off switch", "envelope reviewed (automatic); Per-supplier on/off switch")));
