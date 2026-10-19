// Homepage Studio UI. Talks only to the JSON API (/api/*): no filesystem
// assumptions, no local paths. Works locally and hosted, mouse, keyboard and touch.
import { lintCopy, lintContextForField } from "/api/shared/lint.mjs";
import { wordDiff } from "/api/shared/diff.mjs";

const $ = (s, r = document) => r.querySelector(s);
const BASELINE_ANCHOR = { hero: "", mission: "#mission", roadmap: "#roadmap", final: "#try" };
const FINAL = new Set(["succeeded", "failed", "blocked", "cancelled", "timed_out"]);
const STATE_LABEL = { queued: "Queued", running: "Running", succeeded: "Succeeded", failed: "Failed", blocked: "Blocked", cancelled: "Cancelled", timed_out: "Timed out" };

const state = {
  me: null, data: null, sectionId: "hero", baselineId: "v9", toolId: null, engineId: null, model: "sonnet",
  theme: "dark", previewMode: {}, previewVersion: {}, drafts: {}, notes: {}, instr: {}, prompts: {}, jobs: {},
  open: new Set(), diffs: new Set(), cmp: [], confirm: new Set(),
};

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== undefined && kid !== null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, { method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch {
    return { ok: false, status: 0, data: { message: "Network error: could not reach the studio." } };
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-json */
  }
  if (res.status === 401) showLogin();
  return { ok: res.ok, status: res.status, data };
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $("#toast");
  t.replaceChildren(h("p", { class: bad ? "bad" : "", text: msg }));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.replaceChildren(), 6000);
}

const fmtTime = (iso) => {
  try {
    return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
};

/* ---------- theme ---------- */
function applyTheme(t, persist = true) {
  state.theme = t;
  document.documentElement.dataset.theme = t;
  const b = $("#theme");
  b.setAttribute("aria-checked", String(t === "dark"));
  $("#themeLabel").textContent = t === "dark" ? "Dark mode" : "Light mode";
  if (persist) {
    try {
      localStorage.setItem("od-studio-theme", t);
    } catch {
      /* storage may be blocked */
    }
  }
  postTheme();
}
function postTheme() {
  for (const f of document.querySelectorAll("iframe")) {
    try {
      f.contentWindow?.postMessage({ type: "od-studio-theme", theme: state.theme }, "*");
    } catch {
      /* frame not ready */
    }
  }
}
function initTheme() {
  let t = null;
  try {
    t = localStorage.getItem("od-studio-theme");
  } catch {
    /* ignore */
  }
  if (t !== "dark" && t !== "light") t = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  applyTheme(t, false);
  $("#theme").addEventListener("click", () => applyTheme(state.theme === "dark" ? "light" : "dark"));
}

/* ---------- modals ---------- */
let modal = null;
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
function openModal(el, opener, closable = true) {
  closeModal(false);
  modal = { el, opener: opener || document.activeElement, closable };
  el.hidden = false;
  $("#modalBk").hidden = false;
  const first = el.querySelector("[data-close]") || el.querySelector(FOCUSABLE) || el;
  first.focus();
}
function closeModal(restore = true) {
  if (!modal) return;
  const { el, opener } = modal;
  el.hidden = true;
  $("#modalBk").hidden = true;
  modal = null;
  if (restore && opener && document.contains(opener)) opener.focus();
}
document.addEventListener("keydown", (e) => {
  if (!modal) return;
  if (e.key === "Escape" && modal.closable) {
    e.preventDefault();
    closeModal();
  } else if (e.key === "Tab") {
    const items = [...modal.el.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});
$("#modalBk").addEventListener("click", () => modal?.closable && closeModal());
for (const el of document.querySelectorAll("[data-close]")) el.addEventListener("click", () => closeModal());

/* ---------- derived data ---------- */
const project = () => state.data.project;
const section = () => project().sections.find((s) => s.id === state.sectionId);
const assetOf = (sid = state.sectionId) => project().assets[`asset-${sid}`];
const curAsset = (sid = state.sectionId) => {
  const a = assetOf(sid);
  return a.versions.find((v) => v.id === a.currentVersionId) || null;
};
const toolById = (id) => state.data.tools.find((t) => t.id === id);
const engineById = (id) => state.data.engines.find((e) => e.id === id);
const fieldsOf = (sid = state.sectionId) => Object.values(project().fields).filter((f) => f.sectionId === sid);
const curVer = (ent) => ent.versions.find((v) => v.id === ent.currentVersionId);

function receipt(v) {
  const bits = [v.engine, v.tool].filter((x) => x && x !== "none");
  let s = bits.join(" / ");
  if (v.model && v.model !== "none") s += (s ? " / " : "") + v.model;
  const cost = v.usage && v.usage.total_cost_usd;
  if (typeof cost === "number") s += ` / $${cost.toFixed(2)}`;
  return s || "manual";
}

/* ---------- top bar ---------- */
function renderTop() {
  $("#brand").textContent = state.data.studioName || "Homepage Studio";
  document.title = state.data.studioName || "Homepage Studio";
  const engine = engineById(state.engineId);
  const tool = $("#tool");
  tool.replaceChildren(
    ...state.data.tools.map((t) => {
      const st = t.availability[state.engineId] || { ok: true };
      return h("option", { value: t.id, text: st.ok ? t.label : `${t.label} (unavailable)`, selected: t.id === state.toolId });
    }),
  );
  const base = $("#baseline");
  base.replaceChildren(...project().baselines.map((b) => h("option", { value: b.id, text: b.label, selected: b.id === state.baselineId })));
  const t = toolById(state.toolId);
  const st = t.availability[state.engineId] || { ok: true };
  const info = $("#toolinfo");
  info.className = st.ok ? "toolinfo" : "toolinfo bad";
  info.textContent = st.ok
    ? `${t.label}: ${t.description} Good for: ${t.goodFor}${engine && engine.id === "template-demo" && t.usesSkill ? " (The demo engine ignores the skill.)" : ""}`
    : st.reason;
  const banner = $("#banner");
  if (state.data.storage.ephemeral) {
    banner.hidden = false;
    banner.className = "banner warn";
    banner.textContent = "Temporary storage: changes are lost when the server restarts. Set STUDIO_DATA_REPO and GITHUB_TOKEN to keep them (see HOSTING.md).";
  } else banner.hidden = true;
  $("#logout").hidden = state.data.mode !== "hosted";
}
$("#tool").addEventListener("change", (e) => {
  state.toolId = e.target.value;
  renderTop();
  renderGen();
});
$("#baseline").addEventListener("change", (e) => {
  state.baselineId = e.target.value;
  state.previewMode[state.sectionId] = "baseline";
  renderStage();
});

/* ---------- rail ---------- */
function renderRail() {
  const list = $("#sectionList");
  list.replaceChildren(
    ...project().sections.map((s) => {
      const n = assetOf(s.id).versions.length;
      return h("li", {}, h("button", { type: "button", "aria-current": s.id === state.sectionId ? "true" : "false", onclick: () => selectSection(s.id) }, h("span", { text: s.label }), n ? h("span", { class: "dot", text: `${n} asset${n === 1 ? "" : "s"}` }) : null));
    }),
  );
  const pick = $("#sectionPicker");
  pick.replaceChildren(...project().sections.map((s) => h("option", { value: s.id, text: s.label, selected: s.id === state.sectionId })));
}
$("#sectionPicker").addEventListener("change", (e) => selectSection(e.target.value));
function selectSection(id) {
  state.sectionId = id;
  renderRail();
  renderStage();
  renderCopy();
  renderGen();
}

/* ---------- stage ---------- */
function previewKey() {
  const mode = state.previewMode[state.sectionId] || (curAsset() ? "asset" : "baseline");
  const ver = state.previewVersion[state.sectionId] || (curAsset() && curAsset().id);
  return mode === "asset" && ver ? { mode: "asset", ver } : { mode: "baseline" };
}
function renderStage() {
  const k = previewKey();
  const a = assetOf();
  const frame = $("#preview");
  let key;
  let src;
  if (k.mode === "asset") {
    key = `asset:${k.ver}`;
    src = `/api/preview/asset/${k.ver}?theme=${state.theme}`;
    const v = a.versions.find((x) => x.id === k.ver);
    $("#stageLabel").textContent = `Asset version ${k.ver.slice(-8)} · ${v ? receipt(v) : ""}${v && v.id !== a.currentVersionId ? " · not current" : ""}`;
    frame.title = `Preview of ${section().label}: generated asset`;
  } else {
    const anchor = state.sectionId.startsWith("ch") ? "#story" : BASELINE_ANCHOR[state.sectionId] || "";
    key = `baseline:${state.baselineId}`;
    src = `/api/preview/baseline/${state.baselineId}?theme=${state.theme}${anchor}`;
    $("#stageLabel").textContent = `Baseline page ${state.baselineId} · ${section().label}`;
    frame.title = `Preview of baseline page ${state.baselineId}`;
  }
  if (frame.dataset.key !== key) {
    frame.dataset.key = key;
    frame.src = src;
  } else if (k.mode === "baseline") {
    const want = new URL(src, location.href);
    const have = frame.src ? new URL(frame.src) : null;
    if (!have || have.hash !== want.hash) frame.src = src;
  }
  $("#showBaseline").setAttribute("aria-pressed", String(k.mode === "baseline"));
  $("#showAsset").setAttribute("aria-pressed", String(k.mode === "asset"));
  $("#showAsset").disabled = !curAsset();
  const hb = $("#historyBtn");
  hb.hidden = a.versions.length === 0;
  $("#histCount").textContent = String(a.versions.length);
}
$("#preview").addEventListener("load", postTheme);
$("#showBaseline").addEventListener("click", () => {
  state.previewMode[state.sectionId] = "baseline";
  renderStage();
});
$("#showAsset").addEventListener("click", () => {
  state.previewMode[state.sectionId] = "asset";
  delete state.previewVersion[state.sectionId];
  renderStage();
});
$("#historyBtn").addEventListener("click", (e) => openDrawer(e.currentTarget));

/* ---------- asset version history drawer ---------- */
function openDrawer(opener) {
  renderDrawer();
  openModal($("#drawer"), opener);
}
function renderDrawer() {
  const a = assetOf();
  $("#drawerTitle").textContent = `Version history: ${section().label}`;
  $("#drawerHint").textContent = `${a.versions.length} saved. Nothing is ever deleted: Restore adds a new version that points at the old one.`;
  const list = $("#drawerList");
  list.replaceChildren(
    ...[...a.versions].reverse().map((v) => {
      const failed = v.kind === "failed";
      const thumb = failed || !v.assetPath
        ? h("div", { class: "thumb none", text: failed ? "No output" : "No preview" })
        : h("div", { class: "thumb" }, h("iframe", { sandbox: "allow-scripts", loading: "lazy", tabindex: "-1", "aria-hidden": "true", title: "", src: `/api/preview/asset/${v.id}?theme=${state.theme}` }));
      const cmpOn = state.cmp.includes(v.id);
      return h(
        "li",
        { class: v.isCurrent ? "cur" : "" },
        h(
          "div",
          { class: "vtop" },
          thumb,
          h(
            "div",
            { class: "vmeta" },
            h("div", { class: "row" }, h("span", { class: `badge ${failed ? "bad" : ""}`, text: v.kind }), v.isCurrent ? h("span", { class: "badge cur", text: "current" }) : null, v.starred ? h("span", { class: "badge", text: "starred" }) : null),
            h("span", { class: "meta", text: fmtTime(v.createdAt) }),
            h("span", { class: "meta", text: receipt(v) }),
          ),
        ),
        v.prompt ? h("p", { class: "vprompt", text: `Prompt: ${v.prompt}` }) : null,
        v.note ? h("p", { class: "meta", text: v.note }) : null,
        h(
          "div",
          { class: "row" },
          !failed ? h("button", { type: "button", class: "btn", onclick: () => previewVersion(v.id) }, "Preview") : null,
          !failed && !v.isCurrent ? h("button", { type: "button", class: "btn", onclick: () => restoreAsset(v.id) }, "Restore") : null,
          h("button", { type: "button", class: "btn", "aria-pressed": String(v.starred), onclick: () => starAsset(v.id, !v.starred) }, v.starred ? "Unstar" : "Star"),
          !failed ? h("button", { type: "button", class: "btn", "aria-pressed": String(cmpOn), onclick: () => toggleCompare(v.id) }, cmpOn ? "Picked for compare" : "Compare") : null,
          v.prompt ? h("button", { type: "button", class: "btn", onclick: () => usePrompt(v.prompt) }, "Use prompt") : null,
          failed && v.logPath ? h("button", { type: "button", class: "btn", onclick: (ev) => showLog(v.id, ev.currentTarget) }, "Show log") : null,
        ),
      );
    }),
  );
  postTheme();
}
function previewVersion(id) {
  state.previewMode[state.sectionId] = "asset";
  state.previewVersion[state.sectionId] = id;
  closeModal();
  renderStage();
  $("#main").focus();
}
async function restoreAsset(id) {
  const r = await api("POST", `/api/asset/${state.sectionId}/restore`, { versionId: id });
  if (!r.ok) return toast(r.data?.message || "Restore failed.", true);
  toast("Restored as a new version.");
  delete state.previewVersion[state.sectionId];
  state.previewMode[state.sectionId] = "asset";
  await loadAll();
  renderDrawer();
}
async function starAsset(id, starred) {
  const r = await api("POST", `/api/asset/${state.sectionId}/star`, { versionId: id, starred });
  if (!r.ok) return toast(r.data?.message || "Star failed.", true);
  await loadAll();
  renderDrawer();
}
function usePrompt(p) {
  state.prompts[state.sectionId] = p;
  closeModal();
  renderGen();
  const ta = $("#genPrompt");
  if (ta) ta.focus();
  toast("Prompt loaded into the generation panel.");
}
async function showLog(id, opener) {
  const res = await fetch(`/api/log/${id}`, { credentials: "same-origin" });
  const text = res.ok ? await res.text() : "Log unavailable.";
  $("#noteTitle").textContent = "Job log";
  $("#noteText").value = text;
  $("#noteCopy").hidden = true;
  openModal($("#note"), opener);
}
function toggleCompare(id) {
  const i = state.cmp.indexOf(id);
  if (i >= 0) state.cmp.splice(i, 1);
  else state.cmp.push(id);
  if (state.cmp.length > 2) state.cmp.shift();
  if (state.cmp.length === 2) {
    const [a, b] = state.cmp;
    const A = assetOf().versions.find((v) => v.id === a);
    const B = assetOf().versions.find((v) => v.id === b);
    $("#cmpA").textContent = `A: ${a.slice(-8)} · ${receipt(A)} · ${fmtTime(A.createdAt)}`;
    $("#cmpB").textContent = `B: ${b.slice(-8)} · ${receipt(B)} · ${fmtTime(B.createdAt)}`;
    $("#cmpFrameA").src = `/api/preview/asset/${a}?theme=${state.theme}`;
    $("#cmpFrameB").src = `/api/preview/asset/${b}?theme=${state.theme}`;
    state.cmp = [];
    openModal($("#compare"), $("#historyBtn"));
  } else renderDrawer();
}
for (const id of ["cmpFrameA", "cmpFrameB"]) document.getElementById(id).addEventListener("load", postTheme);

/* ---------- copy panel ---------- */
function lintHtml(res) {
  const out = [];
  for (const e of res.errors) out.push(h("p", { class: "e", text: e.message }));
  for (const w of res.warnings) out.push(h("p", { class: "w", text: w.message }));
  return out;
}

function renderCopy() {
  const host = $("#copyFields");
  host.replaceChildren(...fieldsOf().map(fieldCard));
}

function fieldCard(f) {
  const cur = curVer(f);
  const draft = state.drafts[f.id] ?? cur.text;
  const tid = `txt-${f.id}`;
  const lintId = `lint-${f.id}`;
  const lintOut = h("div", { class: "lintout", id: lintId, "aria-live": "polite" });
  const saveBtn = h("button", { type: "button", class: "btn primary" }, "Save");
  const revert = h("button", { type: "button", class: "btn", onclick: () => { delete state.drafts[f.id]; renderCopy(); } }, "Revert edits");
  const ta = h("textarea", { id: tid, rows: f.multiline ? 4 : 2, "aria-describedby": lintId, value: draft, spellcheck: "true" });
  const note = h("input", { id: `note-${f.id}`, type: "text", maxlength: "500", value: state.notes[f.id] || "", placeholder: "Why this change (optional)" });

  const recompute = () => {
    const text = ta.value;
    state.drafts[f.id] = text;
    const changed = text !== cur.text;
    const res = lintCopy(text, lintContextForField(project(), f));
    lintOut.replaceChildren(...lintHtml(res));
    saveBtn.disabled = !changed || res.errors.length > 0 || !text.trim();
    saveBtn.textContent = res.errors.length === 0 && res.warnings.length > 0 ? "Save anyway (warnings)" : "Save";
    revert.hidden = !changed;
    return res;
  };
  ta.addEventListener("input", recompute);
  note.addEventListener("input", () => (state.notes[f.id] = note.value));
  saveBtn.addEventListener("click", async () => {
    const res = recompute();
    if (res.errors.length) return;
    const r = await api("POST", `/api/copy/${f.id}/save`, { text: ta.value, note: note.value, overrideWarnings: res.warnings.length > 0 });
    if (r.status === 422) return lintOut.replaceChildren(...lintHtml(r.data.lint));
    if (!r.ok) return toast(r.data?.message || "Save failed.", true);
    delete state.drafts[f.id];
    delete state.notes[f.id];
    toast(r.data.unchanged ? "No change to save." : "Saved as a new version.");
    await loadAll();
    document.getElementById(tid)?.focus();
  });

  const hist = f.versions.length;
  const histDetails = h("details", { open: state.open.has(`h:${f.id}`) || undefined }, h("summary", { text: `Version history (${hist})` }));
  histDetails.addEventListener("toggle", () => (histDetails.open ? state.open.add(`h:${f.id}`) : state.open.delete(`h:${f.id}`)));
  histDetails.append(h("div", { class: "inner" }, h("ol", { class: "timeline", "aria-label": `Versions of ${f.label}, newest first` }, ...[...f.versions].reverse().map((v) => timelineItem(f, v, ta)))));

  const instr = h("textarea", { id: `instr-${f.id}`, rows: 2, placeholder: "For example: shorter, more concrete", value: state.instr[f.id] || "", "aria-label": `Regenerate instruction for ${f.label}` });
  instr.addEventListener("input", () => (state.instr[f.id] = instr.value));
  const jobHost = h("div", { class: "jobhost", id: `job-copy-${f.id}`, "aria-live": "polite" });
  const regen = h("details", { open: state.open.has(`r:${f.id}`) || undefined }, h("summary", { text: "Regenerate copy" }));
  regen.addEventListener("toggle", () => (regen.open ? state.open.add(`r:${f.id}`) : state.open.delete(`r:${f.id}`)));
  regen.append(
    h("div", { class: "inner" },
      h("label", { for: `instr-${f.id}`, text: "Instruction" }),
      instr,
      h("p", { class: "meta", text: `Uses the engine and tool selected for generation (${engineById(state.engineId)?.label || state.engineId}).` }),
      h("div", { class: "row" }, h("button", { type: "button", class: "btn", onclick: () => startJob({ kind: "copy", fieldId: f.id, prompt: instr.value }) }, "Regenerate")),
      jobHost,
    ),
  );
  const job = state.jobs[`copy:${f.id}`];
  if (job) renderJob(jobHost, job);

  const el = h("article", { class: "field" },
    h("div", {}, h("label", { for: tid, text: f.label }), h("span", { class: "meta", text: `v${hist} · ${cur.author} · ${cur.kind}` })),
    ta, lintOut,
    h("div", {}, h("label", { for: `note-${f.id}`, text: "Note" }), note),
    h("div", { class: "row" }, saveBtn, revert),
    histDetails, regen,
  );
  recompute();
  revert.hidden = ta.value === cur.text;
  return el;
}

function timelineItem(f, v, ta) {
  const diffKey = `${f.id}:${v.id}`;
  const failed = v.kind === "failed";
  const li = h("li", { class: v.isCurrent ? "cur" : "" },
    h("div", { class: "row" },
      h("span", { class: `badge ${failed ? "bad" : ""}`, text: v.kind }),
      v.isCurrent ? h("span", { class: "badge cur", text: "current" }) : null,
      v.starred ? h("span", { class: "badge", text: "starred" }) : null,
      h("span", { class: "meta", text: `${v.author} · ${receipt(v)} · ${fmtTime(v.createdAt)}` }),
    ),
    h("p", { class: "txt", text: failed ? `Rejected candidate: ${v.text || "(none)"}` : v.text }),
    v.prompt ? h("p", { class: "meta", text: `Prompt: ${v.prompt}` }) : null,
    v.note ? h("p", { class: "meta", text: v.note }) : null,
    v.lint?.warnings?.length ? h("p", { class: "meta", text: `Saved with warnings: ${v.lint.warnings.join(" ")}` }) : null,
  );
  if (state.diffs.has(diffKey) && !failed) {
    const d = wordDiff(v.text, ta.value);
    li.append(h("p", { class: "meta", text: "Changes from this version to the text in the editor:" }), h("p", { class: "diff" }, ...d.map((p) => (p.type === "ins" ? h("ins", { text: p.value }) : p.type === "del" ? h("del", { text: p.value }) : document.createTextNode(p.value)))));
  }
  li.append(
    h("div", { class: "row" },
      !failed ? h("button", { type: "button", class: "btn", "aria-pressed": String(state.diffs.has(diffKey)), onclick: () => { state.diffs.has(diffKey) ? state.diffs.delete(diffKey) : state.diffs.add(diffKey); renderCopy(); } }, "Diff vs editor") : null,
      !failed && !v.isCurrent ? h("button", { type: "button", class: "btn", onclick: () => restoreCopy(f.id, v.id) }, "Restore") : null,
      h("button", { type: "button", class: "btn", "aria-pressed": String(v.starred), onclick: () => starCopy(f.id, v.id, !v.starred) }, v.starred ? "Unstar" : "Star"),
      v.prompt ? h("button", { type: "button", class: "btn", onclick: () => { state.instr[f.id] = v.prompt; state.open.add(`r:${f.id}`); renderCopy(); } }, "Use prompt") : null,
    ),
  );
  return li;
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
  await loadAll();
}
async function starCopy(fieldId, versionId, starred) {
  const r = await api("POST", `/api/copy/${fieldId}/star`, { versionId, starred });
  if (!r.ok) return toast(r.data?.message || "Star failed.", true);
  await loadAll();
}

/* ---------- jobs ---------- */
function renderJob(host, job) {
  const parts = [h("p", {}, h("span", { class: "pill", text: STATE_LABEL[job.state] || job.state }), job.demo ? " · demo engine, not generated by a model" : "", job.message ? ` · ${job.message}` : "")];
  if (job.recovery && job.state !== "succeeded") parts.push(h("p", { text: `What to do: ${job.recovery}` }));
  if (job.runUrl) parts.push(h("p", { class: "meta" }, h("a", { href: job.runUrl, target: "_blank", rel: "noopener noreferrer", text: "Open worker run" })));
  const btns = [];
  if (!FINAL.has(job.state) && job.engine !== "github-actions") btns.push(h("button", { type: "button", class: "btn", onclick: () => api("POST", `/api/jobs/${job.id}/cancel`).then((r) => !r.ok && toast(r.data?.message || "Cancel failed.", true)) }, "Cancel"));
  if (["failed", "blocked", "timed_out", "cancelled"].includes(job.state)) {
    btns.push(h("button", { type: "button", class: "btn", onclick: () => retryJob(job, {}) }, "Retry"));
    if (job.engine !== "template-demo") btns.push(h("button", { type: "button", class: "btn", onclick: () => retryJob(job, { engine: "template-demo", tool: "hand-built" }) }, "Retry with demo engine"));
  }
  if (job.state === "succeeded" && job.kind === "asset") btns.push(h("button", { type: "button", class: "btn", onclick: () => { state.previewMode[job.sectionId] = "asset"; delete state.previewVersion[job.sectionId]; renderStage(); $("#main").focus(); } }, "Preview result"));
  if (btns.length) parts.push(h("div", { class: "row" }, btns));
  if (job.log?.length) parts.push(h("details", {}, h("summary", { text: "Log" }), h("div", { class: "inner" }, h("pre", { class: "log", text: job.log.join("\n") }))));
  host.replaceChildren(h("div", { class: "status", "data-state": job.state }, parts));
}

function jobKey(job) {
  return job.kind === "copy" ? `copy:${job.fieldId}` : `asset:${job.sectionId}`;
}

async function startJob(partial) {
  const body = { kind: "asset", sectionId: state.sectionId, tool: state.toolId, engine: state.engineId, model: state.model, ...partial };
  const r = await api("POST", "/api/generate", body);
  if (!r.ok) return toast(r.data?.message || "Could not start the job.", true);
  trackJob(r.data.job);
}
async function retryJob(job, overrides) {
  const r = await api("POST", `/api/jobs/${job.id}/retry`, overrides);
  if (!r.ok) return toast(r.data?.message || "Retry failed.", true);
  trackJob(r.data.job);
}

const pollers = new Map();
function trackJob(job) {
  state.jobs[jobKey(job)] = job;
  paintJob(job);
  if (FINAL.has(job.state)) return finishJob(job);
  clearTimeout(pollers.get(job.id));
  const delay = job.engine === "github-actions" ? 5000 : 800;
  pollers.set(job.id, setTimeout(async () => {
    const r = await api("GET", `/api/jobs/${job.id}`);
    if (r.ok) trackJob(r.data.job);
    else if (r.status === 404) trackJob({ ...job, state: "failed", message: "Job record not found.", recovery: "Retry." });
    else trackJob(job);
  }, delay));
}
function paintJob(job) {
  const host = job.kind === "copy" ? document.getElementById(`job-copy-${job.fieldId}`) : $("#jobHost");
  if (host && job.sectionId === state.sectionId) renderJob(host, job);
}
async function finishJob(job) {
  if (job.state === "succeeded") {
    toast(job.kind === "asset" ? "New asset version saved." : "New copy version saved.");
    if (job.kind === "asset") {
      state.previewMode[job.sectionId] = "asset";
      delete state.previewVersion[job.sectionId];
    }
  }
  await loadAll(false);
  paintJob(job);
}

/* ---------- generation panel ---------- */
function renderGen() {
  const host = $("#genPanel");
  const a = assetOf();
  const eng = engineById(state.engineId);
  const engineSel = h("select", { id: "genEngine" }, ...state.data.engines.map((e) => h("option", { value: e.id, text: e.available ? e.label : `${e.label} (unavailable)`, selected: e.id === state.engineId })));
  engineSel.addEventListener("change", () => {
    state.engineId = engineSel.value;
    renderTop();
    renderGen();
    renderCopy();
  });
  const modelSel = h("select", { id: "genModel" }, h("option", { value: "sonnet", text: "Sonnet", selected: state.model === "sonnet" }), h("option", { value: "opus", text: "Opus", selected: state.model === "opus" }));
  modelSel.addEventListener("change", () => (state.model = modelSel.value));
  const prompt = h("textarea", { id: "genPrompt", rows: 5, placeholder: "Describe the asset: what it shows, what it should explain.", value: state.prompts[state.sectionId] || "" });
  prompt.addEventListener("input", () => (state.prompts[state.sectionId] = prompt.value));
  const jobHost = h("div", { id: "jobHost", "aria-live": "polite" });
  const job = state.jobs[`asset:${state.sectionId}`];
  if (job) renderJob(jobHost, job);

  host.replaceChildren(
    h("div", { class: "field" },
      h("div", {}, h("label", { for: "genEngine", text: "Engine" }), engineSel),
      eng && !eng.available ? h("p", { class: "meta", text: `${eng.reason} You can still start a job to see it blocked, or switch engine.` }) : eng ? h("p", { class: "meta", text: eng.description }) : null,
      eng && eng.id !== "template-demo" ? h("div", {}, h("label", { for: "genModel", text: "Model" }), modelSel) : null,
      h("div", {}, h("label", { for: "genPrompt", text: "Prompt for the asset" }), prompt),
      h("div", { class: "row" },
        h("button", { type: "button", class: "btn primary", onclick: () => startJob({ prompt: prompt.value }) }, "Generate asset"),
        h("button", { type: "button", class: "btn", onclick: (ev) => openDrawer(ev.currentTarget), disabled: a.versions.length === 0 }, `Version history (${a.versions.length})`),
      ),
      jobHost,
    ),
    h("details", {}, h("summary", { text: "Tool status" }),
      h("div", { class: "inner" }, h("ul", { class: "toollist" }, ...state.data.tools.map((t) => {
        const st = t.availability[state.engineId] || { ok: true };
        return h("li", { class: st.ok ? "" : "bad", text: st.ok ? `${t.label}: available` : st.reason });
      })))),
  );
}

/* ---------- export ---------- */
$("#handoff").addEventListener("click", async (e) => {
  const opener = e.currentTarget;
  const res = await fetch("/api/export/handoff.md", { credentials: "same-origin" });
  if (!res.ok) return toast("Could not build the handoff note.", true);
  $("#noteTitle").textContent = "Handoff note";
  $("#noteText").value = await res.text();
  $("#noteCopy").hidden = false;
  $("#noteMsg").textContent = "";
  openModal($("#note"), opener);
});
$("#noteCopy").addEventListener("click", async () => {
  const t = $("#noteText");
  t.select();
  try {
    await navigator.clipboard.writeText(t.value);
    $("#noteMsg").textContent = "Copied.";
  } catch {
    $("#noteMsg").textContent = "Select the text and use Copy from the system menu.";
  }
});

/* ---------- login / boot ---------- */
function showLogin() {
  if (!$("#login").hidden) return;
  openModal($("#login"), null, false);
  $("#loginPw").focus();
}
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await fetch("/api/login", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: $("#loginPw").value }) });
  if (r.ok) {
    $("#loginPw").value = "";
    $("#loginErr").textContent = "";
    closeModal(false);
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

async function loadAll(rerender = true) {
  const r = await api("GET", "/api/project");
  if (!r.ok) {
    if (r.status !== 401) toast(r.data?.message || "Could not load the project.", true);
    return false;
  }
  state.data = r.data;
  if (!state.toolId) state.toolId = r.data.defaultTool;
  if (!state.engineId) {
    const pick = ["claude-cli", "github-actions", "template-demo"].find((id) => r.data.engines.find((e) => e.id === id && e.available));
    state.engineId = pick || "template-demo";
  }
  if (!project().sections.some((s) => s.id === state.sectionId)) state.sectionId = project().sections[0].id;
  if (rerender || true) {
    renderTop();
    renderRail();
    renderStage();
    renderCopy();
    renderGen();
    if (modal && modal.el.id === "drawer") renderDrawer();
  }
  return true;
}

async function boot() {
  const me = await api("GET", "/api/me");
  if (me.status === 503) {
    const b = $("#banner");
    b.hidden = false;
    b.className = "banner warn";
    b.textContent = me.data?.message || "Studio is not configured.";
    return;
  }
  state.me = me.data;
  if (me.data && me.data.authenticated === false) return showLogin();
  if (!(await loadAll())) return;
  const jr = await api("GET", "/api/jobs?limit=8");
  if (jr.ok) for (const j of jr.data.jobs) if (!FINAL.has(j.state) && !pollers.has(j.id)) trackJob(j);
}

initTheme();
boot();
