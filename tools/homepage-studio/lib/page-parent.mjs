// Parent-side (studio shell) message handling that needs the copy lint. Browser-safe; the shell imports it
// from /api/shared/page-parent.mjs and the tests import it directly.
import { lintCopy, lintContextForField } from "./lint.mjs";
import { makeMessage } from "./page-protocol.mjs";

/** Answer a page "lint-request" with a "lint-result". Unknown field and empty text are errors, never silent. */
export function handleLintRequest(project, msg) {
  const field = project && project.fields ? project.fields[msg.fieldId] : null;
  if (!field) return makeMessage("lint-result", { reqId: msg.reqId, errors: ["This text is not a known copy field."], warnings: [] });
  if (!String(msg.text).trim()) return makeMessage("lint-result", { reqId: msg.reqId, errors: ["Copy cannot be empty."], warnings: [] });
  const res = lintCopy(msg.text, lintContextForField(project, field));
  return makeMessage("lint-result", { reqId: msg.reqId, errors: res.errors.map((e) => e.message), warnings: res.warnings.map((w) => w.message) });
}

/** Turn the copy-save API response into the "save-result" the page understands. */
export function saveResultMessage(reqId, { ok, status, data }) {
  const d = data || {};
  if (ok) return makeMessage("save-result", { reqId, ok: true, ...(d.unchanged ? { unchanged: true } : {}) });
  if (status === 422 && d.lint) return makeMessage("save-result", { reqId, ok: false, errors: d.lint.errors.map((e) => e.message), warnings: (d.lint.warnings || []).map((w) => w.message) });
  if (status === 409 && d.needsConfirm && d.lint) return makeMessage("save-result", { reqId, ok: false, needsConfirm: true, warnings: d.lint.warnings.map((w) => w.message) });
  return makeMessage("save-result", { reqId, ok: false, message: String(d.message || "Save failed.").slice(0, 500) });
}

/** What the page needs to find each field: the text it was built with plus older saved texts as alternates. */
export function fieldsForPage(project) {
  return Object.values(project.fields).map((f) => {
    const real = f.versions.filter((v) => v.kind !== "failed" && typeof v.text === "string");
    const first = real[0] ? real[0].text : "";
    const alts = [];
    for (const v of [...real].reverse()) if (v.text !== first && !alts.includes(v.text) && v.text.length <= 5000 && alts.length < 12) alts.push(v.text);
    return { id: f.id, sectionId: f.sectionId, label: String(f.label || "").slice(0, 200), multiline: !!f.multiline, text: first, alts };
  });
}
export function currentValues(project) {
  const out = {};
  for (const f of Object.values(project.fields)) {
    const cur = f.versions.find((v) => v.id === f.currentVersionId);
    if (cur) out[f.id] = cur.text;
  }
  return out;
}
