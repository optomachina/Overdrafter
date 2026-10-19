// postMessage protocol between the studio shell (parent) and the page editor injected into the
// sandboxed baseline page. Pure and browser-safe, no imports: the parent imports it as a module and
// the editor script gets a copy of it inlined (lib/editor-inject.mjs). The page runs in an opaque
// origin, so every message is validated against a strict schema and the sender is checked.

export const PROTOCOL_VERSION = 1;
export const MAX_TEXT = 5000;
export const MAX_HTML = 1_500_000;

const ID_RE = /^[a-z0-9-]{1,80}$/;
const REQ_RE = /^[A-Za-z0-9_-]{1,40}$/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const isId = (v) => typeof v === "string" && ID_RE.test(v);
const isText = (v) => typeof v === "string" && v.length <= MAX_TEXT;

const T = {
  id: isId,
  req: (v) => typeof v === "string" && REQ_RE.test(v),
  text: isText,
  bool: (v) => typeof v === "boolean",
  theme: (v) => v === "dark" || v === "light",
  int: (v) => Number.isInteger(v) && v >= 0 && v <= 100000,
  kind: (v) => v === "asset" || v === "copy",
  html: (v) => typeof v === "string" && v.length <= MAX_HTML,
  idOrNull: (v) => v === null || isId(v),
  strlist: (v) => Array.isArray(v) && v.length <= 200 && v.every(isId),
  msglist: (v) => Array.isArray(v) && v.length <= 50 && v.every((m) => typeof m === "string" && m.length <= 600),
  values: (v) => isObj(v) && Object.keys(v).length <= 200 && Object.entries(v).every(([k, x]) => isId(k) && isText(x)),
  assets: (v) => isObj(v) && Object.keys(v).length <= 50 && Object.entries(v).every(([k, x]) => isId(k) && isObj(x) && T.int(x.count) && T.idOrNull(x.versionId) && Object.keys(x).length === 2),
  fields: (v) =>
    Array.isArray(v) &&
    v.length <= 200 &&
    v.every(
      (f) =>
        isObj(f) &&
        isId(f.id) &&
        isId(f.sectionId) &&
        typeof f.multiline === "boolean" &&
        isText(f.text) &&
        (f.label === undefined || (typeof f.label === "string" && f.label.length <= 200)) &&
        Array.isArray(f.alts) && f.alts.length <= 30 && f.alts.every(isText) &&
        Object.keys(f).every((k) => ["id", "sectionId", "multiline", "text", "label", "alts"].includes(k)),
    ),
};

// type -> { required: {key: validator}, optional: {key: validator} }
const TO_PAGE = {
  init: { required: { fields: "fields", values: "values", theme: "theme", editMode: "bool", hintDismissed: "bool", assets: "assets" }, optional: {} },
  "apply-copy": { required: { values: "values" }, optional: {} },
  theme: { required: { theme: "theme" }, optional: {} },
  "edit-mode": { required: { on: "bool" }, optional: {} },
  "lint-result": { required: { reqId: "req", errors: "msglist", warnings: "msglist" }, optional: {} },
  "save-result": { required: { reqId: "req", ok: "bool" }, optional: { unchanged: "bool", needsConfirm: "bool", message: "text", errors: "msglist", warnings: "msglist" } },
  "asset-state": { required: { assets: "assets" }, optional: {} },
  "asset-html": { required: { sectionId: "id", versionId: "id", html: "html" }, optional: {} },
};
const TO_PARENT = {
  ready: { required: {}, optional: {} },
  "unmatched-report": { required: { matched: "strlist", unmatched: "strlist" }, optional: {} },
  "lint-request": { required: { reqId: "req", fieldId: "id", text: "text" }, optional: {} },
  "edit-save": { required: { reqId: "req", fieldId: "id", text: "text", overrideWarnings: "bool" }, optional: {} },
  "open-copy-history": { required: { fieldId: "id" }, optional: {} },
  "open-asset-history": { required: { sectionId: "id" }, optional: {} },
  "open-generate": { required: { kind: "kind" }, optional: { sectionId: "id", fieldId: "id" } },
  "asset-html-request": { required: { sectionId: "id", versionId: "id" }, optional: {} },
  "hint-dismissed": { required: {}, optional: {} },
  "theme-changed": { required: { theme: "theme" }, optional: {} },
};

function validate(msg, table) {
  if (!isObj(msg)) return { ok: false, error: "not a plain object" };
  if (msg.v !== PROTOCOL_VERSION) return { ok: false, error: "bad version" };
  if (typeof msg.type !== "string" || !Object.prototype.hasOwnProperty.call(table, msg.type)) return { ok: false, error: "unknown type" };
  const spec = table[msg.type];
  for (const k of Object.keys(msg)) {
    if (k === "v" || k === "type") continue;
    if (!Object.prototype.hasOwnProperty.call(spec.required, k) && !Object.prototype.hasOwnProperty.call(spec.optional, k)) return { ok: false, error: `unexpected key ${k}` };
  }
  for (const [k, vt] of Object.entries(spec.required)) {
    if (!(k in msg) || !T[vt](msg[k])) return { ok: false, error: `bad or missing ${k}` };
  }
  for (const [k, vt] of Object.entries(spec.optional)) {
    if (k in msg && !T[vt](msg[k])) return { ok: false, error: `bad ${k}` };
  }
  if (msg.type === "open-generate" && msg.kind === "asset" && !msg.sectionId) return { ok: false, error: "sectionId required" };
  if (msg.type === "open-generate" && msg.kind === "copy" && !msg.fieldId) return { ok: false, error: "fieldId required" };
  return { ok: true, msg };
}

/** The parent validates what the page sends. */
export const validatePageMessage = (msg) => validate(msg, TO_PARENT);
/** The page validates what the parent sends. */
export const validateParentMessage = (msg) => validate(msg, TO_PAGE);

/**
 * Sender check. `expectedSource` is the window the message must come from (the iframe's contentWindow on
 * the parent side, `window.parent` on the page side). `expectedOrigin` is "null" for the sandboxed page
 * (an opaque origin reports the string "null") and the studio origin for the parent.
 */
export function isTrustedMessage(event, expectedSource, expectedOrigin) {
  return !!event && !!expectedSource && event.source === expectedSource && event.origin === expectedOrigin;
}

export const makeMessage = (type, body = {}) => ({ v: PROTOCOL_VERSION, type, ...body });

/**
 * Plan which mapped elements need new text. values: {fieldId: text}; mapping: {fieldId: elementKey};
 * applied: {fieldId: text last written (or null if untouched)}. A field being edited right now is never touched.
 */
export function planCopyApply({ values, mapping, applied = {}, editingFieldId = null }) {
  const ops = [];
  const unmapped = [];
  for (const [fieldId, text] of Object.entries(values)) {
    if (fieldId === editingFieldId) continue;
    const elementKey = mapping[fieldId];
    if (!elementKey) {
      unmapped.push(fieldId);
      continue;
    }
    if (applied[fieldId] === text) continue;
    ops.push({ fieldId, elementKey, text });
  }
  return { ops, unmapped };
}

/** Clean text read from an editable element for a single-line or multi-line field. */
export function cleanEditedText(raw, multiline) {
  let t = String(raw ?? "").replace(/ /g, " ").replace(/\r\n?/g, "\n");
  if (multiline) {
    t = t.split("\n").map((l) => l.replace(/[ \t]+$/g, "").replace(/^[ \t]+/g, "")).join("\n").replace(/\n{3,}/g, "\n\n");
  } else {
    t = t.replace(/\s*\n\s*/g, " ").replace(/[ \t]{2,}/g, " ");
  }
  return t.trim();
}
