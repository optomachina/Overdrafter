// Page editor. Injected by the studio API into BASELINE previews only (never into generated assets).
// It runs inside the sandboxed iframe (opaque origin, no network, no storage) and talks to the studio
// shell ONLY by validated postMessage. Plain script: lib/field-match.mjs and lib/page-protocol.mjs are
// concatenated in front of this file (see lib/editor-inject.mjs), so their exports are in scope, as is
// __OD_PARENT_ORIGIN__ (the one origin allowed to send us messages and to receive ours).
/* global __OD_PARENT_ORIGIN__, matchFields, normalizeText, validateParentMessage, makeMessage, planCopyApply, cleanEditedText, isTrustedMessage */

function odEditorMain() {
  const doc = document;
  const $ = (s, r = doc) => r.querySelector(s);
  const ACCENT = "#f27a45";
  const S = {
    fields: [], byId: {}, values: {}, theme: "dark", editMode: true, hintDismissed: false, assets: {},
    fieldEl: {}, els: new Map(), promptField: {}, editing: null, reported: "", reapplyQ: false, remapQ: false,
    assetHtml: {}, assetAsked: {}, inited: false, reqN: 0, pendingLint: {}, pendingSave: {},
  };
  const plaintext = (() => {
    const d = doc.createElement("div");
    d.setAttribute("contenteditable", "plaintext-only");
    return d.contentEditable === "plaintext-only";
  })();

  const post = (type, body) => {
    try {
      window.parent.postMessage(makeMessage(type, body), __OD_PARENT_ORIGIN__);
    } catch (e) {
      /* parent gone */
    }
  };
  const newReq = () => "r" + Date.now().toString(36) + (++S.reqN).toString(36);

  /* ---------- styles for the page itself (outlines only; no layout changes) ---------- */
  const style = doc.createElement("style");
  style.setAttribute("data-od-editor-style", "1");
  style.textContent =
    ".od-edit [data-od-field]{cursor:text}" +
    ".od-edit [data-od-field]:hover,.od-edit [data-od-field]:focus-visible,.od-edit .ptext:hover .pt,.od-edit .pc-t:hover{outline:1px dashed " + ACCENT + ";outline-offset:3px}" +
    "[data-od-editing]{outline:2px solid " + ACCENT + "!important;outline-offset:3px;-webkit-user-select:text;user-select:text;-webkit-touch-callout:default;caret-color:" + ACCENT + ";cursor:text;min-width:1ch}" +
    "[data-od-editing]::selection{background:rgba(242,122,69,.35)}";
  (doc.head || doc.documentElement).appendChild(style);

  /* ---------- shadow-DOM UI hosts (isolated from the page's CSS) ---------- */
  const PAL = {
    dark: "--bg:#151513;--ink:#f2efe8;--muted:#a8a397;--rule:#4a4740;--acc:#c2410c;--err:#ff9d88;--hov:#26241f;",
    light: "--bg:#f7f4ed;--ink:#1c1b19;--muted:#5b5850;--rule:#a49d8c;--acc:#c2410c;--err:#a3280f;--hov:#e8e4d8;",
  };
  const BASE_CSS =
    ":host{all:initial}*{box-sizing:border-box}" +
    "button{font:600 14px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg);border:1px solid var(--rule);border-radius:0;min-height:44px;min-width:44px;padding:0 14px;display:inline-flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;touch-action:manipulation}" +
    "button:hover{background:var(--hov)}button:focus-visible{outline:2px solid " + ACCENT + ";outline-offset:1px}" +
    "button.primary{background:var(--acc);border-color:var(--acc);color:#fff}button[disabled]{opacity:.5;cursor:not-allowed}" +
    "svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}";
  const ICON = {
    scroll: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 4h10a2 2 0 0 1 2 2v12a2 2 0 0 0 2 2H8a2 2 0 0 1-2-2z"/><path d="M6 4a2 2 0 0 0-2 2v1h2M10 9h5M10 13h5"/></svg>',
    clock: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    sparkle: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z"/><path d="M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></svg>',
  };
  function makeHost(css, html, hostStyle) {
    const host = doc.createElement("div");
    host.setAttribute("data-od-ui", "1");
    host.style.cssText = hostStyle;
    const root = host.attachShadow({ mode: "open" });
    const st = doc.createElement("style");
    st.textContent = BASE_CSS + css;
    const wrap = doc.createElement("div");
    wrap.className = "root";
    wrap.innerHTML = html;
    root.append(st, wrap);
    return { host, root, wrap };
  }
  const paintPalette = (ui) => ui.wrap.setAttribute("style", PAL[S.theme] || PAL.dark);
  const isMine = (n) => !!(n && n.closest && n.closest("[data-od-ui]"));

  /* ---------- toolbar ---------- */
  const tb = makeHost(
    ".tb{background:var(--bg);color:var(--ink);border:1px solid var(--rule);border-left:4px solid var(--acc);padding:8px;display:flex;flex-direction:column;gap:8px;width:min(420px,calc(100vw - 16px));font:13px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}" +
      ".lab{font:600 11px/1.3 ui-monospace,Menlo,monospace;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}" +
      ".btns{display:flex;flex-wrap:wrap;gap:6px}.sp{flex:1}" +
      ".msg{min-height:0}.msg p{margin:2px 0}.msg .e{color:var(--err)}.msg .e::before{content:'Error: ';font-weight:700}.msg .w::before{content:'Warning: ';font-weight:700}",
    '<div class="tb" role="toolbar" aria-label="Edit text"><div class="lab" id="lab"></div><div class="btns">' +
      '<button type="button" class="primary" id="save">Save</button><button type="button" id="cancel">Cancel</button><span class="sp"></span>' +
      '<button type="button" id="hist" aria-label="Copy history" title="Copy history">' + ICON.clock + '</button>' +
      '<button type="button" id="regen" aria-label="Regenerate copy" title="Regenerate copy">' + ICON.sparkle + "</button></div>" +
      '<div class="msg" id="msg" role="status" aria-live="polite"></div></div>',
    "position:fixed;left:8px;top:8px;z-index:2147483646;display:none",
  );
  const tbq = (id) => tb.root.getElementById ? tb.root.getElementById(id) : tb.root.querySelector("#" + id);

  /* ---------- hint ---------- */
  const hint = makeHost(
    ".h{display:flex;align-items:center;gap:4px;background:var(--bg);color:var(--ink);border:1px solid var(--rule);border-left:4px solid var(--acc);padding:2px 2px 2px 12px;font:600 14px/1.3 system-ui,-apple-system,sans-serif}",
    '<div class="h" role="status"><span>Tap any text to edit</span><button type="button" id="x" aria-label="Dismiss hint">Got it</button></div>',
    "position:fixed;left:50%;transform:translateX(-50%);bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:2147483645;display:none",
  );

  doc.documentElement.append(tb.host, hint.host);
  const paintAll = () => {
    paintPalette(tb);
    paintPalette(hint);
    for (const c of controls) paintPalette(c.ui);
  };

  /* ---------- text helpers ---------- */
  function elText(el) {
    const ls = [...el.children].filter((c) => c.classList && c.classList.contains("l"));
    if (ls.length >= 2) return { text: ls.map((l) => l.textContent).join("\n"), lockup: true, classes: ls.map((l) => l.className) };
    return { text: el.textContent, lockup: false, classes: [] };
  }
  function extractText(root) {
    let out = "";
    (function walk(n) {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) out += c.data;
        else if (c.nodeName === "BR") out += "\n";
        else if (c.nodeType === 1) {
          const blk = c.nodeName === "DIV" || c.nodeName === "P";
          if (blk && out && !out.endsWith("\n")) out += "\n";
          walk(c);
        }
      }
    })(root);
    return out;
  }
  const writeEl = (el, meta, text) => {
    if (meta.lockup) {
      const lines = text.split("\n");
      el.textContent = "";
      lines.forEach((ln, i) => {
        const s = doc.createElement("span");
        s.className = meta.classes[Math.min(i, meta.classes.length - 1)] || "l";
        s.textContent = ln;
        el.appendChild(s);
      });
    } else {
      el.textContent = text;
      el.style.whiteSpace = text.indexOf("\n") >= 0 ? "pre-line" : "";
    }
  };

  /* ---------- mapping: copy fields -> live DOM ---------- */
  function regions() {
    const out = [["hero", $(".hero")]];
    doc.querySelectorAll("article.chap").forEach((a, i) => {
      const c = a.classList.contains("outcome") ? 6 : parseInt(a.dataset.c, 10);
      out.push(["ch" + ((isNaN(c) ? i : c) + 1), a]);
    });
    out.push(["mission", $("#mission")], ["roadmap", $("#roadmap")], ["final", $("#try")]);
    return out.filter((r) => r[1]);
  }
  const CAND_SEL = "h1,h2,h3,h4,p,a,button,li,figcaption,label,dt,dd,summary";
  function gather() {
    const cands = [];
    const els = new Map();
    let order = 0;
    for (const [sid, root] of regions()) {
      for (const el of root.querySelectorAll(CAND_SEL)) {
        if (isMine(el)) continue;
        const t = elText(el);
        if (!t.text || !t.text.trim()) continue;
        const key = "e" + order;
        cands.push({ elementKey: key, text: t.text, order: order++, sectionId: sid });
        els.set(key, { el, lockup: t.lockup, classes: t.classes });
      }
    }
    // Example prompts are rendered by the page from window.PROMPTS (one typed bar plus chips), so they
    // are matched as data and edited where they are shown.
    if (Array.isArray(window.PROMPTS)) {
      window.PROMPTS.forEach((p, i) => {
        if (p && typeof p.text === "string") cands.push({ elementKey: "prompt:" + p.id, text: p.text, order: 100000 + i, sectionId: "ch" + p.chapter });
      });
    }
    return { cands, els };
  }
  function remap() {
    if (S.editing) {
      S.remapQ = true;
      return;
    }
    const { cands, els } = gather();
    const fields = S.fields.map((f) => ({ id: f.id, sectionId: f.sectionId, text: f.text, alts: [S.values[f.id], ...f.alts].filter((x) => typeof x === "string") }));
    const res = matchFields(fields, cands);
    doc.querySelectorAll("[data-od-field]").forEach((n) => n.removeAttribute("data-od-field"));
    S.els = els;
    S.fieldEl = res.mapping;
    S.promptField = {};
    for (const [fid, key] of Object.entries(res.mapping)) {
      if (key.indexOf("prompt:") === 0) S.promptField[key.slice(7)] = fid;
      else if (els.has(key)) els.get(key).el.setAttribute("data-od-field", fid);
    }
    const matched = Object.keys(res.mapping).sort();
    const sig = matched.join(",") + "|" + res.unmatched.slice().sort().join(",");
    if (sig !== S.reported) {
      S.reported = sig;
      post("unmatched-report", { matched, unmatched: res.unmatched });
    }
  }
  function currentDomValue(fid) {
    const key = S.fieldEl[fid];
    if (!key) return null;
    if (key.indexOf("prompt:") === 0) {
      const p = (window.PROMPTS || []).find((x) => x.id === key.slice(7));
      return p ? p.text : null;
    }
    const m = S.els.get(key);
    return m && m.el.isConnected ? elText(m.el).text : null;
  }
  function patchPromptDom(oldText, newText) {
    const o = normalizeText(oldText);
    doc.querySelectorAll(".pt,.pghost,.pc-t").forEach((n) => {
      if (normalizeText(n.textContent) === o) n.textContent = newText;
    });
    doc.querySelectorAll(".pfull").forEach((n) => {
      if (n.textContent.indexOf(oldText) >= 0) n.textContent = n.textContent.split(oldText).join(newText);
    });
  }
  function applyValues() {
    if (!S.inited) return;
    // Any mapped element that the page replaced (re-render) means the map is stale.
    let stale = false;
    for (const key of Object.values(S.fieldEl)) if (key.indexOf("prompt:") !== 0 && !(S.els.get(key) && S.els.get(key).el.isConnected)) stale = true;
    if (stale) remap();
    const applied = {};
    for (const fid of Object.keys(S.values)) applied[fid] = currentDomValue(fid);
    const plan = planCopyApply({ values: S.values, mapping: S.fieldEl, applied, editingFieldId: S.editing ? S.editing.fieldId : null });
    for (const op of plan.ops) {
      if (op.elementKey.indexOf("prompt:") === 0) {
        const p = (window.PROMPTS || []).find((x) => x.id === op.elementKey.slice(7));
        if (p) {
          const old = p.text;
          p.text = op.text;
          patchPromptDom(old, op.text);
        }
      } else {
        const m = S.els.get(op.elementKey);
        if (m && m.el.isConnected) writeEl(m.el, m, op.text);
      }
    }
  }
  function scheduleReapply() {
    if (S.reapplyQ) return;
    S.reapplyQ = true;
    requestAnimationFrame(() => {
      S.reapplyQ = false;
      applyValues();
      refreshAssets();
    });
  }

  /* ---------- editing ---------- */
  function resolveHit(t) {
    const direct = t.closest && t.closest("[data-od-field]");
    if (direct) return { fieldId: direct.getAttribute("data-od-field"), el: direct, meta: S.els.get(S.fieldEl[direct.getAttribute("data-od-field")]) || { lockup: false, classes: [] } };
    const chip = t.closest && t.closest(".pc-t");
    const typed = t.closest && t.closest(".ptext");
    let text = null;
    let el = null;
    if (chip) {
      text = chip.textContent;
      el = chip;
    } else if (typed) {
      const ghost = $(".pghost", typed);
      text = ghost ? ghost.textContent : null;
      el = $(".pt", typed);
    }
    if (text && el) {
      const p = (window.PROMPTS || []).find((x) => normalizeText(x.text) === normalizeText(text));
      const fid = p ? S.promptField[p.id] : null;
      if (fid) return { fieldId: fid, el, meta: { lockup: false, classes: [] }, prompt: p };
    }
    return null;
  }

  function placeCaret(target, x, y) {
    const sel = window.getSelection();
    if (!sel) return;
    let r = null;
    try {
      if (doc.caretRangeFromPoint) r = doc.caretRangeFromPoint(x, y);
      else if (doc.caretPositionFromPoint) {
        const p = doc.caretPositionFromPoint(x, y);
        if (p) {
          r = doc.createRange();
          r.setStart(p.offsetNode, p.offset);
        }
      }
    } catch (e) {
      r = null;
    }
    if (!(r && target.contains(r.startContainer))) {
      r = doc.createRange();
      r.selectNodeContents(target);
      r.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(r);
  }

  const dirty = () => !!S.editing && currentText() !== S.editing.start;
  function currentText() {
    const e = S.editing;
    return cleanEditedText(extractText(e.target), e.f.multiline);
  }

  function beginEdit(hit, ev) {
    if (S.editing) {
      if (S.editing.fieldId === hit.fieldId) return;
      if (dirty()) {
        flashMsg("Save or Cancel the open edit first.");
        return;
      }
      cancelEdit();
    }
    const f = S.byId[hit.fieldId];
    if (!f) return;
    const start = typeof S.values[f.id] === "string" ? S.values[f.id] : elText(hit.el).text;
    const snap = { html: hit.el.innerHTML, ws: hit.el.style.whiteSpace };
    let target = hit.el;
    if (hit.el.tagName === "BUTTON") {
      target = doc.createElement("span");
      target.textContent = start;
      hit.el.textContent = "";
      hit.el.appendChild(target);
    } else {
      target.textContent = start;
    }
    target.style.whiteSpace = f.multiline ? "pre-wrap" : "normal";
    target.setAttribute("data-od-editing", "1");
    target.setAttribute("contenteditable", plaintext ? "plaintext-only" : "true");
    target.setAttribute("spellcheck", "true");
    target.setAttribute("role", "textbox");
    target.setAttribute("aria-label", "Editing " + (f.label || f.id));
    S.editing = { fieldId: f.id, f, el: hit.el, target, snap, start, meta: hit.meta, prompt: hit.prompt || null, lint: null, lintText: null, warnShown: false, lintTimer: 0, saving: false };
    target.addEventListener("keydown", onEditKey);
    target.addEventListener("keyup", onEditKeyUp);
    target.addEventListener("input", onEditInput);
    if (!plaintext) target.addEventListener("paste", onPaste);
    target.focus({ preventScroll: true });
    placeCaret(target, ev ? ev.clientX : 0, ev ? ev.clientY : 0);
    dismissHint();
    openToolbar();
    scheduleLint();
  }
  function endEdit() {
    const e = S.editing;
    if (!e) return;
    clearTimeout(e.lintTimer);
    e.target.removeEventListener("keydown", onEditKey);
    e.target.removeEventListener("keyup", onEditKeyUp);
    e.target.removeEventListener("input", onEditInput);
    e.target.removeEventListener("paste", onPaste);
    ["data-od-editing", "contenteditable", "spellcheck", "role", "aria-label"].forEach((a) => e.target.removeAttribute(a));
    S.editing = null;
    tb.host.style.display = "none";
    const blurry = doc.activeElement;
    if (blurry && blurry.blur && !isMine(blurry)) blurry.blur();
    if (S.remapQ) {
      S.remapQ = false;
      remap();
    }
  }
  function cancelEdit() {
    const e = S.editing;
    if (!e) return;
    e.el.innerHTML = e.snap.html;
    e.el.style.whiteSpace = e.snap.ws;
    endEdit();
    scheduleReapply();
  }
  function finishSaved(text) {
    const e = S.editing;
    if (!e) return;
    S.values[e.fieldId] = text;
    e.el.innerHTML = e.snap.html;
    e.el.style.whiteSpace = e.snap.ws;
    endEdit();
    applyValues();
  }

  function onEditKey(ev) {
    const e = S.editing;
    if (!e) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      cancelEdit();
    } else if (ev.key === "Enter") {
      if (!e.f.multiline || ev.metaKey || ev.ctrlKey) {
        ev.preventDefault();
        ev.stopPropagation();
        save();
      } else if (!plaintext) {
        ev.preventDefault();
        doc.execCommand("insertLineBreak");
      }
    }
    ev.stopPropagation(); // the page's own key handlers (chapter arrows, tour stop) never see edit keys
  }
  function onEditKeyUp(ev) {
    if (ev.key === " " || ev.key === "Enter") ev.preventDefault(); // a button ancestor must not activate on keyup
    ev.stopPropagation();
  }
  function onPaste(ev) {
    ev.preventDefault();
    const t = (ev.clipboardData || window.clipboardData).getData("text/plain");
    doc.execCommand("insertText", false, t);
  }
  function onEditInput() {
    const e = S.editing;
    if (!e) return;
    e.warnShown = false;
    updateSaveState();
    scheduleLint();
  }

  /* ---------- lint round trip (the parent owns lib/lint.mjs) ---------- */
  function scheduleLint() {
    const e = S.editing;
    if (!e) return;
    clearTimeout(e.lintTimer);
    e.lintTimer = setTimeout(() => requestLint(), 180);
  }
  function requestLint() {
    const e = S.editing;
    if (!e) return Promise.resolve(null);
    const text = currentText();
    if (!text) {
      e.lint = { errors: ["Copy cannot be empty."], warnings: [] };
      e.lintText = text;
      renderMsg();
      return Promise.resolve(e.lint);
    }
    const reqId = newReq();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        delete S.pendingLint[reqId];
        resolve(null);
      }, 6000);
      S.pendingLint[reqId] = { text, resolve: (res) => { clearTimeout(timer); resolve(res); } };
      post("lint-request", { reqId, fieldId: e.fieldId, text });
    });
  }
  function onLintResult(m) {
    const p = S.pendingLint[m.reqId];
    if (!p) return;
    delete S.pendingLint[m.reqId];
    const e = S.editing;
    const res = { errors: m.errors, warnings: m.warnings };
    if (e && currentText() === p.text) {
      e.lint = res;
      e.lintText = p.text;
      renderMsg();
    }
    p.resolve(res);
  }
  function renderMsg(extra) {
    const e = S.editing;
    const box = tbq("msg");
    box.textContent = "";
    const add = (cls, text) => {
      const p = doc.createElement("p");
      p.className = cls;
      p.textContent = text;
      box.appendChild(p);
    };
    if (extra) add("w", extra);
    if (e && e.lint) {
      e.lint.errors.forEach((m) => add("e", m));
      e.lint.warnings.forEach((m) => add("w", m));
    }
    updateSaveState();
    placeToolbar();
  }
  function flashMsg(text) {
    renderMsg(text);
  }
  function updateSaveState() {
    const e = S.editing;
    const btn = tbq("save");
    if (!e) return;
    const text = currentText();
    const changed = text !== e.start;
    const lintOk = !(e.lint && e.lintText === text && e.lint.errors.length > 0);
    btn.disabled = !changed || !text || !lintOk || e.saving;
    const warn = e.lint && e.lintText === text && e.lint.warnings.length > 0 && e.lint.errors.length === 0;
    btn.textContent = e.saving ? "Saving..." : warn ? "Save anyway" : "Save";
  }

  async function save() {
    const e = S.editing;
    if (!e || e.saving) return;
    const text = currentText();
    if (text === e.start) return cancelEdit();
    let lint = e.lintText === text ? e.lint : null;
    if (!lint) {
      lint = await requestLint();
      if (!S.editing || currentText() !== text) return;
    }
    if (!lint) return renderMsg("The copy check did not answer. Try again.");
    if (lint.errors.length) return renderMsg();
    const warned = lint.warnings.length > 0;
    if (warned && !e.warnShown) {
      e.warnShown = true; // show the warnings first; a second tap on "Save anyway" confirms
      renderMsg();
      return;
    }
    e.saving = true;
    updateSaveState();
    const reqId = newReq();
    S.pendingSave[reqId] = { text, timer: setTimeout(() => onSaveResult({ reqId, ok: false, message: "The save did not finish. Check the status in the top bar." }), 20000) };
    post("edit-save", { reqId, fieldId: e.fieldId, text, overrideWarnings: warned });
  }
  function onSaveResult(m) {
    const p = S.pendingSave[m.reqId];
    if (!p) return;
    clearTimeout(p.timer);
    delete S.pendingSave[m.reqId];
    const e = S.editing;
    if (m.ok) {
      finishSaved(p.text);
      return;
    }
    if (!e) return;
    e.saving = false;
    if (m.errors || m.warnings || m.needsConfirm) {
      e.lint = { errors: m.errors || [], warnings: m.warnings || [] };
      e.lintText = p.text;
      e.warnShown = !!m.needsConfirm;
    }
    renderMsg(m.message);
  }

  /* ---------- toolbar placement (stays in view with the soft keyboard) ---------- */
  function viewport() {
    const vv = window.visualViewport;
    return vv ? { top: vv.offsetTop, left: vv.offsetLeft, w: vv.width, h: vv.height } : { top: 0, left: 0, w: innerWidth, h: innerHeight };
  }
  function openToolbar() {
    const e = S.editing;
    tbq("lab").textContent = e.f.label || e.f.id;
    tbq("msg").textContent = "";
    paintPalette(tb);
    tb.host.style.display = "block";
    updateSaveState();
    ensureVisible();
    placeToolbar();
  }
  function ensureVisible() {
    const e = S.editing;
    if (!e) return;
    const vp = viewport();
    const tbH = tb.host.offsetHeight || 120;
    const r = e.target.getBoundingClientRect();
    const bottom = vp.top + vp.h - tbH - 20;
    const top = vp.top + 12;
    if (r.bottom > bottom) window.scrollBy(0, Math.min(r.bottom - bottom, Math.max(0, r.top - top)));
    else if (r.top < top) window.scrollBy(0, r.top - top - 24);
  }
  function placeToolbar() {
    const e = S.editing;
    if (!e) return;
    const vp = viewport();
    const r = e.target.getBoundingClientRect();
    const w = tb.host.offsetWidth || 320;
    const h = tb.host.offsetHeight || 120;
    let top = r.bottom + 10;
    if (top + h > vp.top + vp.h - 8) top = r.top - h - 10;
    top = Math.max(vp.top + 8, Math.min(top, vp.top + vp.h - h - 8));
    const left = Math.max(vp.left + 8, Math.min(r.left, vp.left + vp.w - w - 8));
    tb.host.style.top = top + "px";
    tb.host.style.left = left + "px";
  }
  window.addEventListener("scroll", () => S.editing && placeToolbar(), { passive: true });
  window.addEventListener("resize", () => S.editing && (ensureVisible(), placeToolbar()));
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => S.editing && (ensureVisible(), placeToolbar()));
    window.visualViewport.addEventListener("scroll", () => S.editing && placeToolbar());
  }

  tb.root.addEventListener("mousedown", (ev) => ev.preventDefault()); // keep the caret and the keyboard
  tbq("save").addEventListener("click", save);
  tbq("cancel").addEventListener("click", cancelEdit);
  tbq("hist").addEventListener("click", () => S.editing && post("open-copy-history", { fieldId: S.editing.fieldId }));
  tbq("regen").addEventListener("click", () => S.editing && post("open-generate", { kind: "copy", fieldId: S.editing.fieldId }));

  /* ---------- hint ---------- */
  function showHintIfNeeded() {
    hint.host.style.display = S.editMode && !S.hintDismissed && !S.editing ? "block" : "none";
    paintPalette(hint);
  }
  function dismissHint() {
    if (S.hintDismissed) return;
    S.hintDismissed = true;
    hint.host.style.display = "none";
    post("hint-dismissed", {});
  }
  hint.root.querySelector("#x").addEventListener("click", dismissHint);
  hint.root.addEventListener("mousedown", (ev) => ev.preventDefault());

  /* ---------- edit mode: capture-phase interception of the page's own clicks ---------- */
  function setEditMode(on) {
    S.editMode = on;
    doc.documentElement.classList.toggle("od-edit", on);
    showHintIfNeeded();
  }
  function onClickCapture(ev) {
    if (!S.editMode) return;
    if (isMine(ev.target) || ev.composedPath().some((n) => n && n.nodeType === 1 && n.hasAttribute && n.hasAttribute("data-od-ui"))) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const e = S.editing;
    if (e && e.target.contains(ev.target)) return;
    const hit = resolveHit(ev.target);
    if (hit) beginEdit(hit, ev);
  }
  for (const type of ["click", "dblclick", "auxclick"]) doc.addEventListener(type, onClickCapture, true);
  doc.addEventListener("submit", (ev) => { if (S.editMode) { ev.preventDefault(); ev.stopImmediatePropagation(); } }, true);
  doc.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && S.editing && !S.editing.target.contains(ev.target)) {
      ev.preventDefault();
      cancelEdit();
    }
  }, true);

  /* ---------- asset areas: corner controls + generated-asset overlay ---------- */
  const controls = [];
  const sectionLabel = (sid) => (sid === "hero" ? "Hero" : sid.indexOf("ch") === 0 ? "Chapter " + sid.slice(2) : sid);
  function activeSection() {
    const a = $("article.chap.is-active");
    const c = a ? (a.classList.contains("outcome") ? 6 : parseInt(a.dataset.c, 10) || 0) : 0;
    return "ch" + (c + 1);
  }
  function areaList() {
    const out = [];
    const hp = $("#heroPanel");
    if (hp && $("svg.fig", hp)) out.push({ key: "hero", panel: hp, svg: $("svg.fig", hp), section: () => "hero" });
    const sp = $("#panel");
    if (sp && $("svg.fig", sp)) out.push({ key: "story", panel: sp, svg: $("svg.fig", sp), section: activeSection });
    doc.querySelectorAll("article.chap").forEach((a, i) => {
      const fig = $(".rmfig", a);
      const svg = fig && $("svg.fig", fig);
      if (fig && svg && fig.offsetParent !== null) out.push({ key: "rm" + i, panel: fig, svg, section: () => "ch" + (a.classList.contains("outcome") ? 7 : i + 1) });
    });
    return out;
  }
  function ensureControls(area) {
    let c = controls.find((x) => x.key === area.key);
    if (c && c.panel === area.panel) return c;
    if (c) {
      c.ui.host.remove();
      if (c.frames) c.frames.remove();
      controls.splice(controls.indexOf(c), 1);
    }
    if (getComputedStyle(area.panel).position === "static") area.panel.style.position = "relative";
    const ui = makeHost(
      ".g{display:flex;gap:6px}button{position:relative;background:var(--bg)}.n{position:absolute;right:3px;bottom:2px;font:700 10px/1 ui-monospace,Menlo,monospace;color:var(--acc)}",
      '<div class="g"><button type="button" id="h"></button><button type="button" id="r" title="Regenerate"></button></div>',
      "position:absolute;z-index:30;width:94px;height:44px;top:0;left:0",
    );
    const frames = doc.createElement("div");
    frames.setAttribute("data-od-ui", "1");
    frames.style.cssText = "position:absolute;z-index:20;display:none;overflow:hidden;background:transparent";
    area.panel.append(frames, ui.host);
    c = { key: area.key, panel: area.panel, svg: area.svg, section: area.section, ui, frames, frameBySection: {}, lastSection: null };
    paintPalette(ui);
    ui.root.querySelector("#h").addEventListener("click", () => post("open-asset-history", { sectionId: c.section() }));
    ui.root.querySelector("#r").addEventListener("click", () => post("open-generate", { kind: "asset", sectionId: c.section() }));
    ui.root.addEventListener("mousedown", (ev) => ev.stopPropagation());
    ui.root.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    controls.push(c);
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => layoutControls(c));
      ro.observe(area.panel);
      ro.observe(area.svg);
    }
    return c;
  }
  function layoutControls(c) {
    const pr = c.panel.getBoundingClientRect();
    const sr = c.svg.getBoundingClientRect();
    if (!pr.width || !sr.width) {
      c.ui.host.style.display = "none";
      c.frames.style.display = "none";
      return;
    }
    c.ui.host.style.display = "block";
    const bx = c.panel.clientLeft;
    const by = c.panel.clientTop;
    c.ui.host.style.top = sr.top - pr.top - by + 8 + "px";
    c.ui.host.style.left = sr.right - pr.left - bx - 94 - 8 + "px";
    c.frames.style.top = sr.top - pr.top - by + "px";
    c.frames.style.left = sr.left - pr.left - bx + "px";
    c.frames.style.width = sr.width + "px";
    c.frames.style.height = sr.height + "px";
  }
  function refreshAssets() {
    if (!S.inited) return;
    for (const area of areaList()) {
      const c = ensureControls(area);
      const sid = c.section();
      const st = S.assets[sid] || { count: 0, versionId: null };
      const h = c.ui.root.querySelector("#h");
      h.innerHTML = ICON.scroll + (st.count ? '<span class="n" aria-hidden="true">' + st.count + "</span>" : "");
      h.setAttribute("aria-label", "Version history, " + sectionLabel(sid) + (st.count ? ", " + st.count + " versions" : ""));
      h.title = "Version history: " + sectionLabel(sid);
      const r = c.ui.root.querySelector("#r");
      r.innerHTML = ICON.sparkle;
      r.setAttribute("aria-label", "Regenerate figure, " + sectionLabel(sid));
      layoutControls(c);
      // Generated asset overlay for the section currently shown in this area.
      const have = st.versionId ? S.assetHtml[st.versionId] : null;
      for (const k of Object.keys(c.frameBySection)) c.frameBySection[k].style.display = k === sid && st.versionId ? "block" : "none";
      if (st.versionId && have) {
        let fr = c.frameBySection[sid];
        if (!fr || fr.getAttribute("data-version") !== st.versionId) {
          if (fr) fr.remove();
          fr = doc.createElement("iframe");
          fr.setAttribute("sandbox", "allow-scripts");
          fr.setAttribute("referrerpolicy", "no-referrer");
          fr.setAttribute("title", "Generated figure, " + sectionLabel(sid));
          fr.setAttribute("data-version", st.versionId);
          fr.style.cssText = "width:100%;height:100%;border:0;display:block;background:transparent";
          fr.srcdoc = have;
          c.frames.appendChild(fr);
          c.frameBySection[sid] = fr;
          fr.addEventListener("load", () => { try { fr.contentWindow.postMessage({ type: "od-studio-theme", theme: S.theme }, "*"); } catch (e) { /* ignore */ } });
        }
        fr.style.display = "block";
        c.frames.style.display = "block";
        c.svg.style.visibility = "hidden";
      } else {
        c.frames.style.display = "none";
        c.svg.style.visibility = "";
        if (st.versionId && !S.assetAsked[sid + ":" + st.versionId]) {
          S.assetAsked[sid + ":" + st.versionId] = true;
          post("asset-html-request", { sectionId: sid, versionId: st.versionId });
        }
      }
    }
  }
  if (window.MutationObserver) {
    const stateObs = new MutationObserver(() => refreshAssets());
    const arm = () => {
      doc.querySelectorAll("article.chap").forEach((a) => stateObs.observe(a, { attributes: true, attributeFilter: ["class"] }));
    };
    arm();
  }

  /* ---------- theme ---------- */
  function setTheme(t) {
    S.theme = t;
    doc.documentElement.setAttribute("data-theme", t);
    const lbl = $("#themeLbl");
    if (lbl) lbl.textContent = t === "light" ? "Dark" : "Light";
    paintAll();
    doc.querySelectorAll("iframe").forEach((f) => { try { f.contentWindow.postMessage({ type: "od-studio-theme", theme: t }, "*"); } catch (e) { /* ignore */ } });
  }
  new MutationObserver(() => {
    const t = doc.documentElement.getAttribute("data-theme");
    if ((t === "dark" || t === "light") && t !== S.theme) {
      S.theme = t;
      paintAll();
      post("theme-changed", { theme: t }); // the page's own toggle was used: keep the studio chrome in step
    }
  }).observe(doc.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  /* ---------- parent messages ---------- */
  window.addEventListener("message", (ev) => {
    if (!isTrustedMessage(ev, window.parent, __OD_PARENT_ORIGIN__)) return;
    const v = validateParentMessage(ev.data);
    if (!v.ok) return;
    const m = v.msg;
    switch (m.type) {
      case "init":
        S.fields = m.fields;
        S.byId = Object.fromEntries(m.fields.map((f) => [f.id, f]));
        S.values = m.values;
        S.hintDismissed = m.hintDismissed;
        S.assets = m.assets;
        S.inited = true;
        S.reported = "";
        setTheme(m.theme);
        remap();
        applyValues();
        setEditMode(m.editMode);
        refreshAssets();
        break;
      case "apply-copy": {
        // A restore or save elsewhere changed the field that is open here: close an untouched edit so it shows the new wording.
        const open = S.editing;
        if (open && typeof m.values[open.fieldId] === "string" && m.values[open.fieldId] !== S.values[open.fieldId] && !dirty()) cancelEdit();
        Object.assign(S.values, m.values);
        applyValues();
        remap();
        break;
      }
      case "theme":
        setTheme(m.theme);
        break;
      case "edit-mode":
        setEditMode(m.on);
        break;
      case "lint-result":
        onLintResult(m);
        break;
      case "save-result":
        onSaveResult(m);
        break;
      case "asset-state":
        S.assets = m.assets;
        refreshAssets();
        break;
      case "asset-html":
        S.assetHtml[m.versionId] = m.html; // cached per version: switching back and forth never refetches
        refreshAssets();
        break;
      default:
        break;
    }
  });

  /* ---------- page re-renders: keep the saved wording applied ---------- */
  if (window.MutationObserver) {
    new MutationObserver((muts) => {
      if (muts.every((m) => isMine(m.target) || (m.target.closest && m.target.closest("[data-od-editing]")))) return;
      scheduleReapply();
    }).observe(doc.body, { childList: true, subtree: true, characterData: true });
  }

  /* ---------- boot ---------- */
  let tries = 0;
  const hello = () => {
    if (S.inited || tries++ > 12) return;
    post("ready", {});
    setTimeout(hello, 1200);
  };
  const go = () => requestAnimationFrame(() => requestAnimationFrame(hello));
  if (doc.readyState === "complete") go();
  else window.addEventListener("load", go);
}

if (window.parent !== window) odEditorMain();
