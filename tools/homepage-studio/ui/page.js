// Homepage Studio, Page mode: the landing page fills the viewport in one sandboxed iframe and is edited in
// place. The page editor (ui/page-editor.js, injected by the API into baseline previews only) and this shell
// talk ONLY through validated postMessage (lib/page-protocol.mjs). All data goes through the same /api/*
// endpoints as the Outline view.
import { lintCopy, lintContextForField } from "/api/shared/lint";
import { validatePageMessage, isTrustedMessage, makeMessage, MAX_HTML } from "/api/shared/page-protocol";
import { handleLintRequest, saveResultMessage, fieldsForPage, currentValues } from "/api/shared/page-parent";
import { h, api, onUnauthorized, makeToast, fmtTime, receipt, readStoredTheme, storeTheme, defaultEngineId, lintHtml, renderJob, jobKey, createJobTracker, copyTimelineItem, FINAL } from "/core.js";

const $ = (s, r = document) => r.querySelector(s);
const HINT_KEY = "od-studio-hint-dismissed";

const state = {
  me: null, data: null, baselineId: "v9", toolId: null, engineId: null, model: "sonnet", theme: "dark",
  editMode: true, ready: false, sheet: null, unmatched: [], matched: [], loadFail: "", jobs: {}, drafts: {}, notes: {}, instr: {}, prompts: {},
  diffs: new Set(), open: new Set(), previewVersion: {}, htmlCache: new Map(), hintDismissed: false, frameKey: "", readyTimer: 0, opener: null,
};

const frame = $("#pageFrame");
const toast = makeToast($("#toast"));
const project = () => state.data.project;
const toolById = (id) => state.data.tools.find((t) => t.id === id);
const engineById = (id) => state.data.engines.find((e) => e.id === id);
const sectionLabel = (sid) => project().sections.find((s) => s.id === sid)?.label || sid;
const curVer = (ent) => ent.versions.find((v) => v.id === ent.currentVersionId);

/* ---------- save status ---------- */
let saveSeq = 0;
function setSave(kind, detail = "") {
  const el = $("#saveStatus");
  el.dataset.state = kind;
  $("#saveText").textContent = kind === "saved" ? "Saved" : kind === "saving" ? "Saving..." : kind === "unsaved" ? "Not saved" : `Failed: ${detail}`;
  el.title = detail || "";
}

/* ---------- theme (studio chrome and page always match) ---------- */
function applyTheme(t, { persist = true, tellPage = true } = {}) {
  state.theme = t;
  document.documentElement.dataset.theme = t;
  const b = $("#theme");
  b.setAttribute("aria-checked", String(t === "dark"));
  $("#themeLabel").textContent = t === "dark" ? "Dark" : "Light";
  b.title = t === "dark" ? "Dark mode (page and studio)" : "Light mode (page and studio)";
  if (persist) storeTheme(t);
  if (tellPage) send("theme", { theme: t });
}
$("#theme").addEventListener("click", () => applyTheme(state.theme === "dark" ? "light" : "dark"));

/* ---------- messaging with the sandboxed page ---------- */
const bodyOf = (msg) => {
  const o = { ...msg };
  delete o.v;
  delete o.type;
  return o;
};
function send(type, body = {}) {
  if (!state.ready || !frame.contentWindow) return;
  frame.contentWindow.postMessage(makeMessage(type, body), "*"); // the page's origin is opaque: "*" is the only possible target
}
function assetState() {
  const out = {};
  for (const s of project().sections) {
    const a = project().assets[`asset-${s.id}`];
    if (!a) continue;
    const real = a.versions.filter((v) => v.kind !== "failed" && v.assetPath);
    const pv = state.previewVersion[s.id];
    const cur = a.versions.find((v) => v.id === a.currentVersionId);
    const showId = pv && real.some((v) => v.id === pv) ? pv : cur && cur.kind !== "failed" && cur.assetPath ? cur.id : null;
    out[s.id] = { count: real.length, versionId: showId };
  }
  return out;
}
function sendInit() {
  send("init", { fields: fieldsForPage(project()), values: currentValues(project()), theme: state.theme, editMode: state.editMode, hintDismissed: state.hintDismissed, assets: assetState() });
}
function pushCopy() {
  send("apply-copy", { values: currentValues(project()) });
}
function pushAssets() {
  send("asset-state", { assets: assetState() });
}

async function assetHtml(versionId) {
  if (state.htmlCache.has(versionId)) return state.htmlCache.get(versionId);
  const res = await fetch(`/api/preview/asset/${versionId}?theme=${state.theme}`, { credentials: "same-origin" });
  if (!res.ok) return null;
  const html = await res.text();
  if (html.length > MAX_HTML) return null;
  state.htmlCache.set(versionId, html);
  return html;
}

window.addEventListener("message", async (event) => {
  // Only the page iframe, and only from its opaque ("null") origin. Everything else is dropped silently.
  if (!isTrustedMessage(event, frame.contentWindow, "null")) return;
  const v = validatePageMessage(event.data);
  if (!v.ok || !state.data) return;
  const m = v.msg;
  switch (m.type) {
    case "ready":
      clearTimeout(state.readyTimer);
      state.ready = true;
      state.loadFail = "";
      updateStrip();
      sendInit();
      break;
    case "unmatched-report":
      state.unmatched = m.unmatched;
      state.matched = m.matched;
      if (state.sheet?.kind === "history") renderSheet();
      break;
    case "lint-request":
      send("lint-result", bodyOf(handleLintRequest(project(), m)));
      break;
    case "edit-save":
      await saveFromPage(m);
      break;
    case "open-copy-history":
      if (project().fields[m.fieldId]) openSheet("copy", { fieldId: m.fieldId });
      break;
    case "open-asset-history":
      if (project().assets[`asset-${m.sectionId}`]) openSheet("asset", { sectionId: m.sectionId });
      break;
    case "open-generate":
      if (m.kind === "copy" && project().fields[m.fieldId]) {
        state.open.add(`r:${m.fieldId}`);
        openSheet("copy", { fieldId: m.fieldId, focusRegen: true });
      } else if (m.kind === "asset" && project().assets[`asset-${m.sectionId}`]) openSheet("generate", { sectionId: m.sectionId });
      break;
    case "asset-html-request": {
      const a = project().assets[`asset-${m.sectionId}`];
      if (!a || !a.versions.some((x) => x.id === m.versionId && x.assetPath)) break;
      const html = await assetHtml(m.versionId);
      if (html) send("asset-html", { sectionId: m.sectionId, versionId: m.versionId, html });
      break;
    }
    case "hint-dismissed":
      state.hintDismissed = true;
      try {
        localStorage.setItem(HINT_KEY, "1");
      } catch {
        /* storage may be blocked */
      }
      break;
    case "theme-changed":
      if (m.theme !== state.theme) applyTheme(m.theme, { tellPage: false });
      break;
    default:
      break;
  }
});

function stripText() {
  const parts = [];
  if (state.data?.storage?.ephemeral) parts.push("Temporary storage: changes are lost when the server restarts. Set STUDIO_DATA_REPO and GITHUB_TOKEN to keep them (see HOSTING.md).");
  const t = state.data && toolById(state.toolId);
  const st = t && (t.availability[state.engineId] || { ok: true });
  if (st && !st.ok) parts.push(st.reason);
  return parts;
}
function updateStrip() {
  const el = $("#strip");
  const msgs = state.loadFail ? [state.loadFail] : stripText();
  el.hidden = msgs.length === 0;
  el.textContent = msgs.join(" ");
  el.className = state.loadFail ? "strip bad" : "strip";
  if (state.loadFail && state.retryable) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn";
    b.textContent = "Retry";
    b.addEventListener("click", () => {
      setSave("saving");
      boot();
    });
    el.append(" ", b);
  }
}

async function saveFromPage(m) {
  const seq = ++saveSeq;
  setSave("saving");
  const r = await api("POST", `/api/copy/${m.fieldId}/save`, { text: m.text, overrideWarnings: m.overrideWarnings });
  const msg = saveResultMessage(m.reqId, r);
  send("save-result", bodyOf(msg));
  if (r.ok) {
    if (seq === saveSeq) setSave("saved");
    if (!r.data?.unchanged) toast("Saved as a new version.");
    await loadProject();
    pushCopy();
  } else if (r.status === 422 || (r.status === 409 && r.data?.needsConfirm)) {
    // A lint outcome: nothing was written, so never claim "Saved". The page keeps the edit open and shows the lint message.
    if (seq === saveSeq) setSave("unsaved", "the copy check needs attention");
  } else if (seq === saveSeq) {
    setSave("failed", r.data?.message || "could not save");
  }
  // Any other failure (including a 409 conflict_exhausted) is a real failed write: "Failed: <reason>"; the edit stays open.
}

/* ---------- loading ---------- */
async function loadProject() {
  const r = await api("GET", "/api/project");
  if (!r.ok) {
    if (r.status !== 401) {
      // A failed load must never look like an empty studio that says "Saved": keep the reason on screen and offer Retry.
      const why = r.data?.message || (r.status === 0 ? "Network error: could not reach the studio." : "Could not load the project.");
      state.loadFail = `Could not load the project: ${why}`;
      state.retryable = true;
      setSave("failed", "the project did not load");
      updateStrip();
      toast(why, true);
    }
    return false;
  }
  if (state.retryable) {
    state.retryable = false;
    state.loadFail = "";
    updateStrip();
  }
  if (!state.loadedOnce) {
    state.loadedOnce = true;
    setSave("saved");
  }
  state.data = r.data;
  if (!state.toolId) state.toolId = r.data.defaultTool;
  if (!state.engineId) state.engineId = defaultEngineId(r.data);
  renderBar();
  if (state.sheet) renderSheet();
  return true;
}
async function afterProjectChange() {
  await loadProject();
  pushCopy();
  pushAssets();
}

function frameSrc() {
  return `/api/preview/baseline/${state.baselineId}?theme=${state.theme}`;
}
function loadFrame() {
  const key = frameSrc();
  if (state.frameKey === key) return;
  state.frameKey = key;
  state.ready = false;
  clearTimeout(state.readyTimer);
  frame.src = key;
  state.readyTimer = setTimeout(() => {
    if (!state.ready) {
      state.loadFail = `The page ${state.baselineId} did not start the editor. If this baseline is not available here, pick another page, or use the Outline view for bulk edits.`;
      updateStrip();
    }
  }, 9000);
}

/* ---------- top bar ---------- */
function renderBar() {
  $("#brand .brand-t").textContent = state.data.studioName || "Homepage Studio";
  document.title = state.data.studioName || "Homepage Studio";
  const base = $("#baseline");
  base.replaceChildren(...project().baselines.map((b) => h("option", { value: b.id, text: b.label, selected: b.id === state.baselineId })));
  const tool = $("#tool");
  tool.replaceChildren(...state.data.tools.map((t) => {
    const st = t.availability[state.engineId] || { ok: true };
    return h("option", { value: t.id, text: st.ok ? t.label : `${t.label} (unavailable)`, selected: t.id === state.toolId });
  }));
  const eng = $("#engine");
  eng.replaceChildren(...state.data.engines.map((e) => h("option", { value: e.id, text: e.available ? e.label : `${e.label} (unavailable)`, selected: e.id === state.engineId })));
  const t = toolById(state.toolId);
  tool.title = t ? `${t.label}: ${t.description}` : "";
  const en = engineById(state.engineId);
  eng.title = en ? (en.available ? en.description : en.reason) : "";
  $("#logout").hidden = state.data.mode !== "hosted";
  updateStrip();
  const running = Object.values(state.jobs).filter((j) => !FINAL.has(j.state));
  const pill = $("#jobPill");
  pill.hidden = running.length === 0;
  if (running.length) {
    const j = running[0];
    pill.textContent = `Generating ${j.kind === "copy" ? "copy" : sectionLabel(j.sectionId)}...`;
    pill.onclick = () => (j.kind === "copy" ? openSheet("copy", { fieldId: j.fieldId }) : openSheet("generate", { sectionId: j.sectionId }));
  }
}
$("#baseline").addEventListener("change", (e) => {
  state.baselineId = e.target.value;
  state.loadFail = "";
  updateStrip();
  loadFrame();
});
$("#tool").addEventListener("change", (e) => {
  state.toolId = e.target.value;
  renderBar();
  if (state.sheet?.kind === "generate") renderSheet();
});
$("#engine").addEventListener("change", (e) => {
  state.engineId = e.target.value;
  renderBar();
  if (state.sheet) renderSheet();
});
$("#interact").addEventListener("click", (e) => {
  const on = e.currentTarget.getAttribute("aria-pressed") !== "true";
  e.currentTarget.setAttribute("aria-pressed", String(on));
  state.editMode = !on;
  e.currentTarget.title = on ? "Interact mode is on: the page behaves normally. Tap again to edit text." : "Interact: use the page's own prompt bar, panels and chapters";
  send("edit-mode", { on: state.editMode });
  toast(on ? "Interact mode: the page works normally. Tap Interact again to edit text." : "Editing is on: tap any text.");
});
$("#settingsBtn").addEventListener("click", (e) => {
  const open = !$("#barMenu").classList.contains("open");
  $("#barMenu").classList.toggle("open", open);
  e.currentTarget.setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (e) => {
  const menu = $("#barMenu");
  if (menu.classList.contains("open") && !menu.contains(e.target) && !$("#settingsBtn").contains(e.target)) {
    menu.classList.remove("open");
    $("#settingsBtn").setAttribute("aria-expanded", "false");
  }
});
$("#historyBtn").addEventListener("click", (e) => openSheet("history", {}, e.currentTarget));

/* ---------- sheet (bottom sheet on narrow or touch layouts, right drawer on wide) ---------- */
const mqSheet = matchMedia("(max-width: 899px), (pointer: coarse)");
function openSheet(kind, params = {}, opener = null) {
  state.sheet = { kind, ...params };
  if (opener) state.opener = opener;
  const sheet = $("#sheet");
  const wasHidden = sheet.hidden;
  sheet.hidden = false;
  sheet.style.transform = "";
  sheet.setAttribute("aria-modal", String(mqSheet.matches));
  $("#sheetBk").hidden = !mqSheet.matches;
  renderSheet();
  if (wasHidden || params.focusRegen) {
    const target = params.focusRegen ? $("#regenInstr") : $("#sheetClose");
    (target || $("#sheetClose")).focus();
  }
}
function closeSheet() {
  if (!state.sheet) return;
  state.sheet = null;
  $("#sheet").hidden = true;
  $("#sheetBk").hidden = true;
  const o = state.opener;
  state.opener = null;
  if (o && document.contains(o)) o.focus();
  else frame.focus();
}
$("#sheetClose").addEventListener("click", closeSheet);
$("#sheetBk").addEventListener("click", closeSheet);
const SHEET_FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
document.addEventListener("keydown", (e) => {
  if (!state.sheet) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closeSheet();
  } else if (e.key === "Tab" && $("#sheet").getAttribute("aria-modal") === "true") {
    // Focus trap for the modal (bottom sheet) layout: Tab and Shift+Tab loop inside the sheet. The wide drawer is not modal and is not trapped.
    const sheet = $("#sheet");
    const items = [...sheet.querySelectorAll(SHEET_FOCUSABLE)].filter((x) => x.offsetParent !== null);
    if (!items.length) return e.preventDefault();
    const first = items[0];
    const last = items[items.length - 1];
    const a = document.activeElement;
    if (!sheet.contains(a)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && (a === first || a === sheet)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && a === last) {
      e.preventDefault();
      first.focus();
    }
  }
});
// Drag handle: swipe down to close.
(() => {
  const grip = $("#sheetGrip");
  let startY = null;
  grip.addEventListener("pointerdown", (e) => {
    startY = e.clientY;
    grip.setPointerCapture(e.pointerId);
    $("#sheet").style.transition = "none";
  });
  grip.addEventListener("pointermove", (e) => {
    if (startY === null) return;
    $("#sheet").style.transform = `translateY(${Math.max(0, e.clientY - startY)}px)`;
  });
  const end = (e) => {
    if (startY === null) return;
    const dy = e.clientY - startY;
    startY = null;
    $("#sheet").style.transition = "";
    if (dy > 80) closeSheet();
    else $("#sheet").style.transform = "";
  };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
})();
// Keep sheets above the soft keyboard (visual viewport) and cap their height.
function syncViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement.style;
  if (!vv) return;
  root.setProperty("--vvh", `${vv.height}px`);
  root.setProperty("--kb", `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px`);
}
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", syncViewport);
  window.visualViewport.addEventListener("scroll", syncViewport);
}
syncViewport();

function renderSheet() {
  const s = state.sheet;
  if (!s || !state.data) return;
  const body = $("#sheetBody");
  const top = body.scrollTop;
  const focusId = document.activeElement && body.contains(document.activeElement) ? document.activeElement.id : null;
  if (s.kind === "history") {
    $("#sheetTitle").textContent = "History";
    body.replaceChildren(...historyView());
  } else if (s.kind === "copy") {
    const f = project().fields[s.fieldId];
    $("#sheetTitle").textContent = `Copy: ${f.label}`;
    body.replaceChildren(...copyView(f));
  } else if (s.kind === "asset") {
    $("#sheetTitle").textContent = `Figure versions: ${sectionLabel(s.sectionId)}`;
    body.replaceChildren(...assetView(s.sectionId));
  } else if (s.kind === "generate") {
    $("#sheetTitle").textContent = `Generate figure: ${sectionLabel(s.sectionId)}`;
    body.replaceChildren(...generateView(s.sectionId));
  }
  body.scrollTop = top;
  if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
}

/* ----- global History sheet ----- */
function historyView() {
  const fields = Object.values(project().fields);
  const recent = fields
    .flatMap((f) => f.versions.filter((v) => v.kind !== "failed" && f.versions.indexOf(v) > 0).map((v) => ({ f, v })))
    .sort((a, b) => (a.v.createdAt < b.v.createdAt ? 1 : -1))
    .slice(0, 12);
  const unmatched = state.unmatched.map((id) => project().fields[id]).filter(Boolean);
  return [
    h("section", {}, h("h3", { text: "Recent copy changes" }),
      recent.length
        ? h("ul", { class: "plain" }, recent.map(({ f, v }) => h("li", { class: "field" },
          h("p", { class: "meta", text: `${f.label} · ${v.kind} · ${v.author} · ${fmtTime(v.createdAt)}` }),
          h("p", { text: v.text.length > 140 ? `${v.text.slice(0, 140)}...` : v.text }),
          h("button", { type: "button", class: "btn", onclick: () => openSheet("copy", { fieldId: f.id }) }, "Open timeline"),
        )))
        : h("p", { class: "meta", text: "No edits yet. Tap any text on the page to edit it." })),
    h("section", {}, h("h3", { text: "Figures" }),
      h("ul", { class: "plain" }, project().sections.map((s) => {
        const a = project().assets[`asset-${s.id}`];
        const n = a ? a.versions.filter((v) => v.kind !== "failed").length : 0;
        return h("li", { class: "row" },
          h("span", { text: s.label }), h("span", { class: "meta", text: `${n} version${n === 1 ? "" : "s"}` }),
          h("button", { type: "button", class: "btn", onclick: () => openSheet("asset", { sectionId: s.id }) }, n ? "Versions" : "Open"),
          h("button", { type: "button", class: "btn", onclick: () => openSheet("generate", { sectionId: s.id }) }, "Regenerate"));
      }))),
    h("section", {}, h("h3", { text: `Not editable in place yet (${unmatched.length})` }),
      h("p", { class: "meta", text: `${state.matched.length} of ${Object.keys(project().fields).length} fields are editable on this page. Nothing is lost: the rest are edited in the Outline view.` }),
      unmatched.length
        ? h("ul", { class: "plain unmatched" }, unmatched.map((f) => h("li", {},
          h("strong", { text: f.label }), h("span", { class: "meta", text: `${sectionLabel(f.sectionId)} · not editable in place yet: edit in Outline view` }),
          h("a", { class: "btn", href: `/outline.html#section=${f.sectionId}`, text: "Edit in Outline view" }))))
        : h("p", { class: "meta", text: "Every field was found on this page." })),
  ];
}

/* ----- copy sheet: edit, timeline, diff, restore, regenerate ----- */
function copyView(f) {
  const cur = curVer(f);
  const draft = state.drafts[f.id] ?? cur.text;
  const lintOut = h("div", { class: "lintout", id: "copyLint", "aria-live": "polite" });
  const saveBtn = h("button", { type: "button", class: "btn primary", id: "copySave" }, "Save");
  const ta = h("textarea", { id: "copyText", rows: f.multiline ? 4 : 2, "aria-label": `Text of ${f.label}`, value: draft, spellcheck: "true" });
  const note = h("input", { id: "copyNote", type: "text", maxlength: "500", value: state.notes[f.id] || "", placeholder: "Why this change (optional)", "aria-label": "Note" });
  const revert = h("button", { type: "button", class: "btn", onclick: () => { delete state.drafts[f.id]; renderSheet(); } }, "Revert edits");
  const recompute = () => {
    state.drafts[f.id] = ta.value;
    const changed = ta.value !== cur.text;
    const res = lintCopy(ta.value, lintContextForField(project(), f));
    lintOut.replaceChildren(...lintHtml(res));
    saveBtn.disabled = !changed || res.errors.length > 0 || !ta.value.trim();
    saveBtn.textContent = res.errors.length === 0 && res.warnings.length > 0 ? "Save anyway (warnings)" : "Save";
    revert.hidden = !changed;
    return res;
  };
  ta.addEventListener("input", recompute);
  note.addEventListener("input", () => (state.notes[f.id] = note.value));
  saveBtn.addEventListener("click", async () => {
    const res = recompute();
    if (res.errors.length) return;
    setSave("saving");
    const r = await api("POST", `/api/copy/${f.id}/save`, { text: ta.value, note: note.value, overrideWarnings: res.warnings.length > 0 });
    if (r.status === 422) {
      setSave("unsaved", "the copy check needs attention");
      return lintOut.replaceChildren(...lintHtml(r.data.lint));
    }
    if (!r.ok) {
      setSave("failed", r.data?.message || "could not save");
      return toast(r.data?.message || "Save failed.", true);
    }
    setSave("saved");
    delete state.drafts[f.id];
    delete state.notes[f.id];
    toast(r.data.unchanged ? "No change to save." : "Saved as a new version.");
    await afterProjectChange();
  });

  const instr = h("textarea", { id: "regenInstr", rows: 2, placeholder: "For example: shorter, more concrete", value: state.instr[f.id] || "", "aria-label": `Regenerate instruction for ${f.label}` });
  instr.addEventListener("input", () => (state.instr[f.id] = instr.value));
  const jobHost = h("div", { id: `job-copy-${f.id}`, "aria-live": "polite" });
  const job = state.jobs[`copy:${f.id}`];
  if (job) renderJob(jobHost, job, jobActions);
  const en = engineById(state.engineId);
  const regen = h("details", { open: state.open.has(`r:${f.id}`) || undefined }, h("summary", { text: "Regenerate copy" }));
  regen.addEventListener("toggle", () => (regen.open ? state.open.add(`r:${f.id}`) : state.open.delete(`r:${f.id}`)));
  regen.append(h("div", { class: "inner" },
    h("label", { for: "regenInstr", text: "Instruction" }), instr,
    h("p", { class: "meta", text: `Uses the engine and tool in the top bar (${en?.label || state.engineId}).` }),
    h("div", { class: "row" }, h("button", { type: "button", class: "btn", onclick: () => startJob({ kind: "copy", sectionId: f.sectionId, fieldId: f.id, prompt: instr.value }) }, "Regenerate")),
    jobHost,
  ));

  const list = h("ol", { class: "timeline", "aria-label": `Versions of ${f.label}, newest first` },
    ...[...f.versions].reverse().map((v) => {
      const key = `${f.id}:${v.id}`;
      return copyTimelineItem(v, {
        editorText: ta.value,
        diffOn: state.diffs.has(key),
        onDiff: () => { state.diffs.has(key) ? state.diffs.delete(key) : state.diffs.add(key); renderSheet(); },
        onRestore: () => restoreCopy(f.id, v.id),
        onStar: (starred) => starCopy(f.id, v.id, starred),
        onUsePrompt: (p) => { state.instr[f.id] = p; state.open.add(`r:${f.id}`); renderSheet(); },
      });
    }));

  const out = [
    h("div", { class: "field" },
      h("p", { class: "meta", text: `${sectionLabel(f.sectionId)} · v${f.versions.length} · ${cur.author} · ${cur.kind}` }),
      h("label", { for: "copyText", text: "Edit text" }), ta, lintOut,
      h("label", { for: "copyNote", text: "Note" }), note,
      h("div", { class: "row" }, saveBtn, revert)),
    regen,
    h("section", {}, h("h3", { text: `Versions (${f.versions.length}), newest first` }), list),
  ];
  recompute();
  revert.hidden = ta.value === cur.text;
  return out;
}
async function restoreCopy(fieldId, versionId) {
  const r = await api("POST", `/api/copy/${fieldId}/restore`, { versionId });
  if (r.status === 422) return toast("Cannot restore: this older text now fails copy lint. " + r.data.lint.errors.map((e) => e.message).join(" "), true);
  if (r.status === 409 && r.data.needsConfirm) {
    const again = await api("POST", `/api/copy/${fieldId}/restore`, { versionId, overrideWarnings: true });
    if (!again.ok) return toast(again.data?.message || "Restore failed.", true);
  } else if (!r.ok) return toast(r.data?.message || "Restore failed.", true);
  delete state.drafts[fieldId];
  toast("Restored as a new version.");
  await afterProjectChange();
}
async function starCopy(fieldId, versionId, starred) {
  const r = await api("POST", `/api/copy/${fieldId}/star`, { versionId, starred });
  if (!r.ok) return toast(r.data?.message || "Star failed.", true);
  await loadProject();
}

/* ----- asset sheet: scroll back through figure versions ----- */
function assetView(sid) {
  const a = project().assets[`asset-${sid}`];
  const pv = state.previewVersion[sid];
  return [
    h("p", { class: "meta", text: `${a.versions.length} saved. Nothing is ever deleted: Restore adds a new version that points at the old one.` }),
    h("div", { class: "row" },
      h("button", { type: "button", class: "btn primary", onclick: () => openSheet("generate", { sectionId: sid }) }, "Generate a new figure"),
      pv ? h("button", { type: "button", class: "btn", onclick: () => { delete state.previewVersion[sid]; pushAssets(); renderSheet(); } }, "Show current in page") : null),
    a.versions.length === 0 ? h("p", { text: "No generated figures yet. The page shows its built-in figure." }) : null,
    h("ol", { class: "versions", "aria-label": `Figure versions of ${sectionLabel(sid)}, newest first` },
      ...[...a.versions].reverse().map((v) => {
        const failed = v.kind === "failed";
        const thumb = failed || !v.assetPath
          ? h("div", { class: "thumb none", text: failed ? "No output" : "No preview" })
          : h("div", { class: "thumb" }, h("iframe", { sandbox: "allow-scripts", loading: "lazy", tabindex: "-1", "aria-hidden": "true", title: "", src: `/api/preview/asset/${v.id}?theme=${state.theme}` }));
        const shown = pv === v.id;
        return h("li", { class: v.isCurrent ? "cur" : "" },
          h("div", { class: "vtop" }, thumb,
            h("div", { class: "vmeta" },
              h("div", { class: "row" }, h("span", { class: `badge ${failed ? "bad" : ""}`, text: v.kind }), v.isCurrent ? h("span", { class: "badge cur", text: "current" }) : null, v.starred ? h("span", { class: "badge", text: "starred" }) : null, shown ? h("span", { class: "badge", text: "showing in page" }) : null),
              h("span", { class: "meta", text: fmtTime(v.createdAt) }), h("span", { class: "meta", text: receipt(v) }))),
          v.prompt ? h("p", { class: "vprompt", text: `Prompt: ${v.prompt}` }) : null,
          v.note ? h("p", { class: "meta", text: v.note }) : null,
          h("div", { class: "row" },
            !failed && v.assetPath ? h("button", { type: "button", class: "btn", "aria-pressed": String(shown), onclick: () => { state.previewVersion[sid] = v.id; pushAssets(); renderSheet(); } }, "Show in page") : null,
            !failed && !v.isCurrent ? h("button", { type: "button", class: "btn", onclick: () => restoreAsset(sid, v.id) }, "Restore") : null,
            h("button", { type: "button", class: "btn", "aria-pressed": String(!!v.starred), onclick: () => starAsset(sid, v.id, !v.starred) }, v.starred ? "Unstar" : "Star"),
            v.prompt ? h("button", { type: "button", class: "btn", onclick: () => { state.prompts[sid] = v.prompt; openSheet("generate", { sectionId: sid }); } }, "Use prompt") : null,
            failed && v.logPath ? h("button", { type: "button", class: "btn", onclick: () => showLog(v.id) }, "Show log") : null));
      })),
    h("pre", { class: "log", id: "logBox", hidden: true }),
  ];
}
async function restoreAsset(sid, versionId) {
  const r = await api("POST", `/api/asset/${sid}/restore`, { versionId });
  if (!r.ok) return toast(r.data?.message || "Restore failed.", true);
  toast("Restored as a new version.");
  delete state.previewVersion[sid];
  await afterProjectChange();
}
async function starAsset(sid, versionId, starred) {
  const r = await api("POST", `/api/asset/${sid}/star`, { versionId, starred });
  if (!r.ok) return toast(r.data?.message || "Star failed.", true);
  await loadProject();
}
async function showLog(id) {
  const res = await fetch(`/api/log/${id}`, { credentials: "same-origin" });
  const box = $("#logBox");
  box.textContent = res.ok ? await res.text() : "Log unavailable.";
  box.hidden = false;
  box.scrollIntoView({ block: "nearest" });
}

/* ----- generate sheet ----- */
function generateView(sid) {
  const a = project().assets[`asset-${sid}`];
  const en = engineById(state.engineId);
  const t = toolById(state.toolId);
  const st = t ? t.availability[state.engineId] || { ok: true } : { ok: true };
  const toolSel = h("select", { id: "genTool" }, ...state.data.tools.map((x) => h("option", { value: x.id, text: (x.availability[state.engineId] || { ok: true }).ok ? x.label : `${x.label} (unavailable)`, selected: x.id === state.toolId })));
  toolSel.addEventListener("change", () => { state.toolId = toolSel.value; renderBar(); renderSheet(); });
  const engSel = h("select", { id: "genEngine" }, ...state.data.engines.map((e) => h("option", { value: e.id, text: e.available ? e.label : `${e.label} (unavailable)`, selected: e.id === state.engineId })));
  engSel.addEventListener("change", () => { state.engineId = engSel.value; renderBar(); renderSheet(); });
  const modelSel = h("select", { id: "genModel" }, h("option", { value: "sonnet", text: "Sonnet", selected: state.model === "sonnet" }), h("option", { value: "opus", text: "Opus", selected: state.model === "opus" }));
  modelSel.addEventListener("change", () => (state.model = modelSel.value));
  const prompt = h("textarea", { id: "genPrompt", rows: 5, placeholder: "Describe the figure: what it shows, what it should explain.", value: state.prompts[sid] || "" });
  prompt.addEventListener("input", () => (state.prompts[sid] = prompt.value));
  const jobHost = h("div", { id: `job-asset-${sid}`, "aria-live": "polite" });
  const job = state.jobs[`asset:${sid}`];
  if (job) renderJob(jobHost, job, jobActions);
  return [
    h("div", { class: "field" },
      h("div", {}, h("label", { for: "genTool", text: "Tool" }), toolSel),
      !st.ok ? h("p", { class: "meta", text: st.reason }) : t ? h("p", { class: "meta", text: `${t.description} Good for: ${t.goodFor}${en && en.id === "template-demo" && t.usesSkill ? " (The demo engine ignores the skill.)" : ""}` }) : null,
      h("div", {}, h("label", { for: "genEngine", text: "Engine" }), engSel),
      en && !en.available ? h("p", { class: "meta", text: `${en.reason} You can still start a job to see it blocked, or switch engine.` }) : en ? h("p", { class: "meta", text: en.description }) : null,
      en && en.id !== "template-demo" ? h("div", {}, h("label", { for: "genModel", text: "Model" }), modelSel) : null,
      h("div", {}, h("label", { for: "genPrompt", text: "Prompt for the figure" }), prompt),
      h("div", { class: "row" },
        h("button", { type: "button", class: "btn primary", id: "genGo", onclick: () => startJob({ kind: "asset", sectionId: sid, prompt: prompt.value }) }, "Generate figure"),
        h("button", { type: "button", class: "btn", onclick: () => openSheet("asset", { sectionId: sid }) }, `Versions (${a.versions.length})`)),
      jobHost),
  ];
}

/* ---------- jobs ---------- */
const jobActions = {
  cancel: (job) => api("POST", `/api/jobs/${job.id}/cancel`).then((r) => !r.ok && toast(r.data?.message || "Cancel failed.", true)),
  retry: async (job, overrides) => {
    const r = await api("POST", `/api/jobs/${job.id}/retry`, overrides);
    if (!r.ok) return toast(r.data?.message || "Retry failed.", true);
    tracker.track(r.data.job);
  },
  preview: (job) => {
    delete state.previewVersion[job.sectionId];
    pushAssets();
    closeSheet();
  },
};
const tracker = createJobTracker({
  onUpdate: (job) => {
    state.jobs[jobKey(job)] = job;
    const host = document.getElementById(job.kind === "copy" ? `job-copy-${job.fieldId}` : `job-asset-${job.sectionId}`);
    if (host) renderJob(host, job, jobActions);
    if (state.data) renderBar();
  },
  onFinal: async (job) => {
    if (job.state === "succeeded") {
      toast(job.kind === "asset" ? `New figure version saved for ${sectionLabel(job.sectionId)}.` : "New copy version saved.");
      if (job.kind === "asset") delete state.previewVersion[job.sectionId];
    } else if (job.state === "blocked" || job.state === "failed" || job.state === "timed_out") {
      toast(`${job.message || "The job did not finish."}${job.recovery ? ` ${job.recovery}` : ""}`, true);
    }
    await afterProjectChange(); // new versions appear in the page live
  },
});
async function startJob(partial) {
  const body = { tool: state.toolId, engine: state.engineId, model: state.model, ...partial };
  const r = await api("POST", "/api/generate", body);
  if (!r.ok) return toast(r.data?.message || "Could not start the job.", true);
  tracker.track(r.data.job);
}

/* ---------- login / boot ---------- */
onUnauthorized(() => showLogin());
let loginOpen = false;
function showLogin() {
  if (loginOpen) return;
  loginOpen = true;
  $("#login").hidden = false;
  $("#modalBk").hidden = false;
  $("#loginPw").focus();
}
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await fetch("/api/login", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: $("#loginPw").value }) });
  if (r.ok) {
    $("#loginPw").value = "";
    $("#loginErr").textContent = "";
    $("#login").hidden = true;
    $("#modalBk").hidden = true;
    loginOpen = false;
    await boot();
  } else {
    let m = "Login failed.";
    try {
      m = (await r.json()).message || m;
    } catch {
      /* ignore */
    }
    $("#loginErr").textContent = m;
  }
});
$("#logout").addEventListener("click", async () => {
  await api("POST", "/api/logout", {});
  location.reload();
});

async function boot() {
  const me = await api("GET", "/api/me");
  if (me.status === 503) {
    state.loadFail = me.data?.message || "Studio is not configured.";
    updateStrip();
    return;
  }
  state.me = me.data;
  if (me.data && me.data.authenticated === false) return showLogin();
  if (!(await loadProject())) return;
  loadFrame();
  const jr = await api("GET", "/api/jobs?limit=8");
  if (jr.ok) for (const j of jr.data.jobs) if (!FINAL.has(j.state) && !tracker.has(j.id)) tracker.track(j);
}

try {
  state.hintDismissed = localStorage.getItem(HINT_KEY) === "1";
} catch {
  /* storage may be blocked */
}
applyTheme(readStoredTheme(), { persist: false, tellPage: false });
boot();
