/**
 * In-page observer for the Jev quote driver.
 *
 * Ported from browser-use/jev-ultrafast `jev_ultrafast/snapshot.js`
 * (https://github.com/browser-use/jev-ultrafast, MIT License, Copyright (c)
 * 2026 Browser Use). Kept: the WeakMap node registry, the selector set and
 * role mapping, the visibility exclusions, the accessible-name order, and the
 * page_key / guard / marker freshness scheme. Changed per
 * docs/jev-quote-driver.md §5: open shadow roots, tabindex controls, `near`
 * context, clipping instead of hiding, native-select options as records,
 * dialogs, form state for the side-effect diff, hashed keys, and no page text
 * returned beyond what code signals need.
 *
 * Kept as a source string and evaluated as an expression, so no transpiler
 * helper can leak into the page and the page's CSP never sees an `eval`.
 */
export const SNAPSHOT_REVISION = "ovd-driver-snapshot.v1";

export type SnapshotCall =
  | { op: "snapshot"; vocabulary: readonly string[]; excludeSelectors: readonly string[]; maxElements: number }
  | { op: "pagekey" }
  | { op: "inspect"; node: number; scroll: boolean; forFill: boolean }
  | { op: "select_native"; node: number }
  | { op: "settle"; kind: "action" | "combobox_fill"; node: number | null }
  | { op: "candidates"; node: number; vocabulary: readonly string[] }
  | { op: "skeleton"; node: number; vocabulary: readonly string[] }
  | { op: "is_node"; node: number };

export function snapshotExpression(call: SnapshotCall) {
  return `(${DRIVER_PAGE_SOURCE})(${JSON.stringify(call)})`;
}

const DRIVER_PAGE_SOURCE = String.raw`(call) => {
  const VERSION = "ovd-driver-snapshot.v1";
  if (!document.body) return null;
  let d = window.__ovdDriver;
  if (!d || d.version !== VERSION) d = window.__ovdDriver = { version: VERSION, ids: new WeakMap(), nodes: new Map(), next: 1 };
  const identity = (e) => { if (!d.ids.has(e)) d.ids.set(e, d.next++); const id = d.ids.get(e); d.nodes.set(id, e); return id; };
  for (const [id, e] of d.nodes) if (!e.isConnected) d.nodes.delete(id);
  const hash = (value) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    let a = 0x811c9dc5, b = 0x01000193 ^ text.length;
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ c, 0x5bd1e995); }
    return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
  };
  const norm = (s) => ((s || "").slice(0, 400).normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(" ");
  const vocab = new Set(call.vocabulary || []);
  const roots = () => {
    const out = [document];
    for (let i = 0; i < out.length && out.length < 200; i++) {
      const walker = document.createTreeWalker(out[i], NodeFilter.SHOW_ELEMENT);
      let node;
      while ((node = walker.nextNode())) if (node.shadowRoot) out.push(node.shadowRoot);
    }
    return out;
  };
  const byId = (e, id) => (e.getRootNode && e.getRootNode().getElementById ? e.getRootNode().getElementById(id) : null) || document.getElementById(id);
  const safe = (e) => !["password", "file", "hidden"].includes(e.type);
  const visible = (e) => !e.closest('[aria-hidden="true"],[inert]') &&
    (e.checkVisibility ? e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : e.getClientRects().length > 0);
  const disabled = (e) => e.matches(":disabled") || !!e.closest('[aria-disabled="true"]');
  const textOf = (e) => ((e && (e.innerText || e.textContent)) || "").replace(/\s+/g, " ").trim();
  const name = (e, seen = new Set()) => {
    if (!e || seen.has(e)) return "";
    seen.add(e);
    const referenced = (e.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
      .map((id) => name(byId(e, id), seen)).filter(Boolean).join(" ");
    return referenced || e.getAttribute("aria-label") ||
      [...(e.labels || [])].map((l) => name(l, seen)).filter(Boolean).join(" ") ||
      (["button", "submit", "reset"].includes(e.type) ? e.value : "") || e.getAttribute("alt") ||
      (e.tagName === "INPUT" || e.tagName === "SELECT" || e.tagName === "TEXTAREA" ? "" : [...e.childNodes].map((n) => n.nodeType === 3 ? n.textContent :
        n.nodeType === 1 && n.getAttribute("aria-hidden") !== "true" ? name(n, seen) : "").join(" ").replace(/\s+/g, " ").trim()) ||
      e.getAttribute("title") || e.getAttribute("placeholder") || "";
  };
  const ROLES = ["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemradio", "option", "gridcell", "combobox", "textbox", "searchbox", "spinbutton"];
  const SELECTOR = 'a[href],button,input,textarea,select,summary,[contenteditable="true"],[tabindex]:not([tabindex="-1"]),' + ROLES.map((r) => '[role="' + r + '"]').join(",");
  const role = (e) => {
    const explicit = e.getAttribute("role");
    if (ROLES.includes(explicit)) return explicit;
    if (e.tagName === "BUTTON" || e.tagName === "SUMMARY") return "button";
    if (e.tagName === "A") return e.hasAttribute("href") ? "link" : null;
    if (e.tagName === "SELECT") return "combobox";
    if (e.tagName === "OPTION") return "option";
    if (e.tagName === "TEXTAREA" || e.isContentEditable) return "textbox";
    if (e.tagName === "INPUT") {
      if (["checkbox", "radio"].includes(e.type)) return e.type;
      if (["button", "submit", "reset", "image"].includes(e.type)) return "button";
      if (e.type === "search") return "searchbox";
      if (e.type === "number") return "spinbutton";
      if (["text", "email", "url", "tel", ""].includes(e.type)) return "textbox";
      return null;
    }
    if (e.hasAttribute("tabindex")) return "generic";
    return null;
  };
  const SCOPE = 'li,tr,[role="row"],[role="listitem"],[role="dialog"],[role="alertdialog"],dialog,fieldset,[role="option"]';
  const DIALOG = '[role="dialog"],[role="alertdialog"],dialog[open],[aria-modal="true"]';
  const scopeText = (e) => { const s = e.parentElement && e.parentElement.closest(SCOPE); const t = s ? textOf(s) : ""; return t.length > 400 ? "" : t; };
  const near = (e) => {
    let fallback = "", node = e;
    const consider = (t) => { if (!t || t.length > 60) return null; if (vocab.has(norm(t))) return t; if (!fallback) fallback = t; return null; };
    for (let level = 0; level < 3 && node; level++) {
      let sib = node.previousElementSibling;
      for (let steps = 0; sib && steps < 4; steps++, sib = sib.previousElementSibling) {
        if (sib.matches(SELECTOR) || sib.querySelector(SELECTOR)) continue;
        const hit = consider(textOf(sib)); if (hit) return hit;
      }
      const parent = node.parentElement || (node.getRootNode() && node.getRootNode().host) || null;
      if (!parent) break;
      for (const child of parent.children) {
        if (child === node || child.contains(e)) continue;
        if (/^(LABEL|LEGEND|H[1-6])$/.test(child.tagName) || child.getAttribute("role") === "heading") { const hit = consider(textOf(child)); if (hit) return hit; }
      }
      const hit = consider(parent.getAttribute("aria-label") || ""); if (hit) return hit;
      node = parent;
    }
    return fallback;
  };
  const textExcluding = (root) => {
    const parts = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node, length = 0;
    while ((node = walker.nextNode()) && length < 160) {
      const p = node.parentElement;
      if (!p || p.closest('[role="listbox"],[role="option"],input,textarea,select,script,style') || !visible(p)) continue;
      const t = node.textContent.trim(); if (t) { parts.push(t); length += t.length; }
    }
    return parts.join(" ").slice(0, 160);
  };
  const display = (e, r) => {
    if (e.tagName === "SELECT") return [...e.selectedOptions].map((o) => o.label).join(", ");
    if (e.type === "radio" || e.type === "checkbox") return e.checked ? name(e) : "";
    if (r === "combobox" && (e.tagName === "INPUT" || e.tagName === "TEXTAREA")) {
      let a = e.parentElement;
      for (let i = 0; a && i < 3; i++, a = a.parentElement) { const t = textExcluding(a); if (t) return t; }
      return "";
    }
    if (e.tagName === "INPUT" || e.tagName === "TEXTAREA") return "";
    return textExcluding(e);
  };
  const clipped = (e, r) => {
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) return true;
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(auto|scroll|hidden|clip)/.test(s.overflow + s.overflowX + s.overflowY)) {
        const pr = p.getBoundingClientRect();
        if (cx < pr.left || cx > pr.right || cy < pr.top || cy > pr.bottom) return true;
      }
    }
    return false;
  };
  const controls = () => roots().flatMap((root) => [...root.querySelectorAll("input,textarea,select")]).filter(safe);
  const pageKey = () => hash([performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight,
    controls().map((e) => [identity(e), e.value, e.checked, e.selectedIndex, e.disabled, e.readOnly])]);
  const guard = (e) => {
    if (!e || !e.isConnected || !visible(e)) return null;
    const s = e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return hash([identity(e), role(e), name(e), e.value ?? null, e.checked ?? null, e.selectedIndex ?? null, e.readOnly ?? null,
      e.matches(":disabled"), e.getAttribute("aria-disabled"), e.getAttribute("aria-expanded"), e.getAttribute("aria-checked"),
      e.getAttribute("aria-selected"), e.getAttribute("href"), s ? textOf(s).slice(0, 2000) : ""]);
  };
  const excludedBy = (e) => {
    for (const sel of call.excludeSelectors || []) { try { if (e.closest(sel)) return true; } catch (_) { /* engine-specific selector */ } }
    const form = e.closest("form");
    return !!(form && form.querySelector('[autocomplete^="cc-"]'));
  };
  const record = (e, r, rname, extra) => {
    return Object.assign({
      id: identity(e), tag: e.tagName.toLowerCase(), role: rname, name: name(e).slice(0, 200), near: near(e),
      text: textOf(e).slice(0, 200), value: "value" in e && e.tagName !== "BUTTON" && e.tagName !== "OPTION" ? String(e.value).slice(0, 200) : "",
      display: display(e, rname), type: (e.getAttribute("type") || "").toLowerCase(), inputMode: (e.getAttribute("inputmode") || "").toLowerCase(),
      placeholder: e.getAttribute("placeholder") || "", href: e.getAttribute("href"), testId: e.getAttribute("data-testid"),
      domId: e.id || null, nameAttr: e.getAttribute("name"), title: e.getAttribute("title"), scopeText: scopeText(e),
      editable: !e.readOnly && e.getAttribute("aria-readonly") !== "true" && (["textbox", "searchbox", "spinbutton"].includes(rname) ||
        (rname === "combobox" && ["INPUT", "TEXTAREA"].includes(e.tagName))),
      disabled: disabled(e), checked: e.type === "radio" || e.type === "checkbox" ? !!e.checked :
        e.getAttribute("aria-checked") !== null ? e.getAttribute("aria-checked") === "true" : e.getAttribute("aria-selected") === "true" ? true : null,
      expanded: e.getAttribute("aria-expanded") === null ? null : e.getAttribute("aria-expanded") === "true",
      inDialog: !!e.closest(DIALOG), excluded: excludedBy(e), offscreen: clipped(e, r), guard: guard(e) || "", optionIndex: null,
    }, extra || {});
  };
  if (call.op === "pagekey") return pageKey();
  if (call.op === "is_node") return true;
  if (call.op === "snapshot") {
    const seen = new Set(), elements = [];
    let truncated = false, unsupported = 0;
    for (const root of roots()) {
      for (const canvas of root.querySelectorAll("canvas")) { const r = canvas.getBoundingClientRect(); if (r.width > 120 && r.height > 60 && visible(canvas)) unsupported++; }
      for (const e of root.querySelectorAll(SELECTOR)) {
        if (seen.has(e)) continue; seen.add(e);
        if (!safe(e) || !visible(e)) continue;
        const r = e.getBoundingClientRect(), rname = role(e);
        if (!rname || r.width <= 0 || r.height <= 0) continue;
        if (rname === "gridcell" && e.querySelector('button,[role="button"]')) continue;
        if (rname === "generic" && e.querySelector(SELECTOR)) continue;
        if (e.tagName === "OPTION") continue;
        if (elements.length >= call.maxElements) { truncated = true; break; }
        elements.push(record(e, r, rname));
        if (e.tagName === "SELECT") {
          for (const o of e.options) {
            if (o.disabled || o.closest("optgroup[disabled]")) continue;
            elements.push(Object.assign(record(o, r, "option"), { name: o.label.slice(0, 200), text: o.label.slice(0, 200),
              checked: o.selected, optionIndex: o.index, disabled: disabled(e), offscreen: clipped(e, r), inDialog: !!e.closest(DIALOG), excluded: excludedBy(e) }));
          }
        }
      }
    }
    const dialogs = [];
    for (const root of roots()) for (const dlg of root.querySelectorAll(DIALOG)) {
      if (!visible(dlg) || dialogs.some((x) => x.node.contains(dlg))) continue;
      dialogs.push({ node: dlg, text: textOf(dlg).slice(0, 1000), elementIds: elements.filter((x) => dlg.contains(d.nodes.get(x.id))).map((x) => x.id) });
    }
    const bodyText = (document.body.innerText || "").slice(0, 20000);
    const formState = {};
    for (const e of controls()) formState[identity(e)] = [e.value, e.checked, e.selectedIndex].join("|");
    const key = pageKey();
    const semantics = elements.map((x) => [x.id, x.role, x.name, x.value, x.display, x.checked, x.expanded, x.disabled]);
    return { url: location.href, pageKey: key, marker: hash([key, document.title, bodyText.slice(0, 6000), semantics]), elements,
      dialogs: dialogs.map(({ node, ...rest }) => rest), bodyText, formState, unsupported, truncated };
  }
  const e = d.nodes.get(call.node);
  if (call.op === "inspect") {
    if (!e || !e.isConnected) return { connected: false };
    const target = e.tagName === "OPTION" ? e.closest("select") : e;
    if (call.scroll) target.scrollIntoView({ block: "center", inline: "center" });
    const forFillOk = !call.forFill || (!e.readOnly && e.getAttribute("aria-readonly") !== "true");
    const actionable = visible(target) && !disabled(e) && forFillOk;
    const r = target.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
    const inView = r.width > 0 && r.height > 0 && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
    const root = target.getRootNode();
    const hitEl = inView ? (root.elementFromPoint ? root.elementFromPoint(x, y) : document.elementFromPoint(x, y)) : null;
    const hit = !!hitEl && (hitEl === target || target.contains(hitEl));
    const denyText = [name(e), textOf(e).slice(0, 300), e.value || "", e.getAttribute("title") || "", e.getAttribute("href") || "",
      e.getAttribute("data-testid") || "", e.id || "", e.getAttribute("placeholder") || "", e.getAttribute("name") || "", scopeText(e)].join(" \n ");
    return { connected: true, actionable, point: hit ? { x, y } : null, pageKey: pageKey(), guard: guard(e) || "", denyText, excluded: excludedBy(e), isLink: !!e.closest("a[href]") };
  }
  if (call.op === "select_native") {
    if (!e || e.tagName !== "OPTION" || !e.isConnected || e.disabled) return false;
    const select = e.closest("select");
    if (!select || disabled(select)) return false;
    select.selectedIndex = e.index;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return select.selectedIndex === e.index;
  }
  if (call.op === "settle") {
    const field = call.node === null ? null : d.nodes.get(call.node);
    return new Promise((resolve) => {
      let frames = 0, quietSince = performance.now(), done = false;
      const started = performance.now();
      const cap = call.kind === "combobox_fill" ? 3000 : 500;
      const observer = new MutationObserver(() => { quietSince = performance.now(); });
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      const finish = (value) => { if (done) return; done = true; observer.disconnect(); resolve(value); };
      const optionsVisible = () => {
        const ids = ((field && (field.getAttribute("aria-controls") || field.getAttribute("aria-owns"))) || "").split(/\s+/).filter(Boolean);
        const scopes = ids.length ? ids.map((id) => byId(field, id)).filter(Boolean) : roots();
        return scopes.some((s) => [...s.querySelectorAll('[role="option"]')].some((o) => { const r = o.getBoundingClientRect(); return r.width && r.height && visible(o); }));
      };
      const tick = () => {
        if (done) return;
        const now = performance.now();
        if (now - started > cap) return finish(false);
        if (++frames >= 2) {
          if (call.kind === "combobox_fill" ? optionsVisible() : now - quietSince >= 50) return finish(true);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      setTimeout(() => finish(false), cap + 50);
    });
  }
  const STABLE_TEST_ID = (v) => /^[A-Za-z][A-Za-z0-9_-]{1,63}$/.test(v) && !/\d{4,}/.test(v) && !/[0-9a-f]{8,}/i.test(v);
  const tagSel = (x) => x.tagName.toLowerCase() + (x.getAttribute("role") ? '[role="' + x.getAttribute("role") + '"]' : "") +
    (x.tagName === "INPUT" && x.getAttribute("type") ? '[type="' + x.getAttribute("type") + '"]' : "");
  const quote = (v) => JSON.stringify(v);
  if (call.op === "candidates") {
    if (!e || !e.isConnected) return [];
    const out = [];
    let a = e;
    for (let i = 0; a && i < 5; i++, a = a.parentElement) {
      const id = a.getAttribute("data-testid");
      if (id && STABLE_TEST_ID(id)) { out.push(a === e ? '[data-testid=' + quote(id) + ']' : '[data-testid=' + quote(id) + '] ' + tagSel(e)); break; }
    }
    const n = name(e).trim();
    if (n && vocab.has(norm(n)) && role(e) && role(e) !== "generic") out.push("role=" + role(e) + "[name=" + quote(n) + "s]");
    const path = [tagSel(e)];
    for (let anc = e.parentElement, i = 0; anc && i < 3; anc = anc.parentElement, i++) {
      const label = [...anc.children].find((c) => !c.contains(e) && /^(SPAN|LABEL|LEGEND|P|DIV)$/.test(c.tagName) && textOf(c).length <= 60 && vocab.has(norm(textOf(c))));
      if (label) { out.push(anc.tagName.toLowerCase() + ":has(> " + label.tagName.toLowerCase() + ":text-is(" + quote(textOf(label)) + ")) > " + path.join(" > ")); break; }
      path.unshift(anc.tagName.toLowerCase());
    }
    const stable = (v) => v && /^[A-Za-z][A-Za-z0-9_-]{2,40}$/.test(v) && !/^(:r|r[0-9])|react-select|\d{3,}/.test(v);
    if (stable(e.id)) out.push("#" + e.id);
    const nm = e.getAttribute("name");
    if (stable(nm)) out.push(e.tagName.toLowerCase() + "[name=" + quote(nm) + "]");
    return out;
  }
  if (call.op === "skeleton") {
    if (!e || !e.isConnected) return null;
    const keepAttrs = (x) => {
      const attrs = [];
      for (const key of ["role", "type", "inputmode"]) { const v = x.getAttribute(key); if (v && /^[a-z-]{1,24}$/i.test(v)) attrs.push(key + "=" + quote(v)); }
      for (const key of ["aria-label", "placeholder"]) { const v = x.getAttribute(key); if (v && vocab.has(norm(v))) attrs.push(key + "=" + quote(v)); }
      const t = x.getAttribute("data-testid"); if (t && STABLE_TEST_ID(t)) attrs.push("data-testid=" + quote(t));
      return attrs.length ? " " + attrs.join(" ") : "";
    };
    const VOID = /^(INPUT|BR|IMG|HR)$/;
    const leaf = (x) => {
      const tag = x.tagName.toLowerCase(), t = textOf(x);
      if (VOID.test(x.tagName)) return "<" + tag + keepAttrs(x) + ">";
      const body = t ? (vocab.has(norm(t)) ? t.replace(/[<>&]/g, "") : "Synthetic text") : "";
      return "<" + tag + keepAttrs(x) + ">" + body + "</" + tag + ">";
    };
    const chain = [e];
    for (let a = e.parentElement; a && a !== document.body && chain.length < 7; a = a.parentElement) chain.unshift(a);
    const render = (index) => {
      const x = chain[index];
      if (index === chain.length - 1) return leaf(x);
      const tag = x.tagName.toLowerCase();
      const kids = [...x.children].map((c) => c === chain[index + 1] ? render(index + 1) :
        textOf(c).length <= 60 && vocab.has(norm(textOf(c))) ? leaf(c) : "").filter(Boolean).join("");
      return "<" + tag + keepAttrs(x) + ">" + kids + "</" + tag + ">";
    };
    for (let start = 0; start < chain.length; start++) {
      const html = render(start);
      if (html.length <= 4000) return html;
    }
    return null;
  }
  return null;
}`;
