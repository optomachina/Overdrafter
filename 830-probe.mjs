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
