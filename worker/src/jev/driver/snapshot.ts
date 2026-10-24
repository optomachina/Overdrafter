/**
 * In-page observer for the Jev quote driver.
 *
 * Ported from browser-use/jev-ultrafast `jev_ultrafast/snapshot.js`
 * (https://github.com/browser-use/jev-ultrafast, MIT License, Copyright (c)
 * 2026 Browser Use). Kept: the WeakMap node registry, the control selector
 * set and role mapping, the visibility/disabled/zero-size exclusions, the
 * accessible-name order, and the page_key / guard / marker freshness scheme.
 *
 * Changed for docs/jev-quote-driver.md §5: open shadow roots are walked;
 * extra controls ([tabindex], listbox children, role-less options under an
 * aria-controls target); a `near` context string; clipped elements become
 * `offscreen` instead of hidden; disabled controls are kept and flagged; when
 * a modal dialog is open only its contents are listed; no raw page text is
 * returned to the model (the Node side turns `text` into code signals).
 *
 * Kept as a plain JavaScript string so no bundler helper leaks into the page.
 */
export const OBSERVER_SOURCE = String.raw`(args) => {
  if (!document.body) return null;
  const reg = window.__ovdDriver || (window.__ovdDriver = { ids: new WeakMap(), nodes: new Map(), next: 1 });
  const identity = (e) => {
    if (!reg.ids.has(e)) reg.ids.set(e, reg.next++);
    const id = reg.ids.get(e); reg.nodes.set(id, e); return id;
  };
  for (const [id, e] of reg.nodes) if (!e.isConnected) reg.nodes.delete(id);
  const deny = new RegExp(args.deny, "i");
  const roots = [];
  const walk = (root) => { roots.push(root); for (const el of root.querySelectorAll("*")) if (el.shadowRoot) walk(el.shadowRoot); };
  walk(document);
  const qsa = (sel) => roots.flatMap((r) => [...r.querySelectorAll(sel)]);
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const safe = (e) => !["password", "file", "hidden"].includes(e.type);
  const visible = (e) => !e.closest('[aria-hidden="true"],[inert]') && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const byId = (e, id) => (e.getRootNode().getElementById ? e.getRootNode().getElementById(id) : document.getElementById(id));
  const name = (e, seen = new Set()) => {
    if (!e || seen.has(e)) return "";
    seen.add(e);
    const referenced = (e.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
      .map((id) => name(byId(e, id), seen)).filter(Boolean).join(" ");
    return clean(referenced || e.getAttribute("aria-label") ||
      [...(e.labels || [])].map((l) => name(l, seen)).filter(Boolean).join(" ") ||
      (["button", "submit", "reset"].includes(e.type) ? e.value : "") || e.getAttribute("alt") ||
      (e.tagName === "INPUT" ? "" : [...e.childNodes].map((n) => n.nodeType === 3 ? n.textContent :
        n.nodeType === 1 && n.getAttribute("aria-hidden") !== "true" && n.tagName !== "INPUT" ? name(n, seen) : "").join(" ").trim()) ||
      e.getAttribute("title") || e.getAttribute("placeholder") || "");
  };
  const ROLES = ["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemradio",
    "option", "gridcell", "combobox", "textbox", "searchbox", "spinbutton"];
  const controlled = new Set();
  for (const e of qsa("input[aria-controls],[role=combobox][aria-controls],input[aria-owns]")) {
    for (const id of (e.getAttribute("aria-controls") || e.getAttribute("aria-owns") || "").split(/\s+/).filter(Boolean)) {
      const target = byId(e, id); if (target) controlled.add(target);
    }
  }
  const optionLike = (e) => {
    const parent = e.parentElement;
    return !!parent && controlled.has(parent) && !e.getAttribute("role") && e.children.length === 0 &&
      !/notice|loading|empty/i.test(e.className || "") && clean(e.textContent).length > 0 &&
      !/^(no options|loading\W*)$/i.test(clean(e.textContent));
  };
  const role = (e) => {
    const explicit = e.getAttribute("role");
    if (ROLES.includes(explicit)) return explicit;
    if (e.tagName === "BUTTON" || e.tagName === "SUMMARY") return "button";
    if (e.tagName === "A") return "link";
    if (e.tagName === "SELECT") return "combobox";
    if (e.tagName === "TEXTAREA" || e.isContentEditable) return "textbox";
    if (e.tagName === "INPUT") {
      if (["checkbox", "radio"].includes(e.type)) return e.type;
      if (["button", "submit", "reset", "image"].includes(e.type)) return "button";
      if (e.getAttribute("aria-autocomplete") === "list" || e.getAttribute("aria-haspopup") === "listbox") return "combobox";
      if (e.type === "search") return "searchbox";
      if (e.type === "number") return "spinbutton";
      if (["text", "email", "url", "tel", ""].includes(e.type)) return "textbox";
    }
    if (optionLike(e)) return "option";
    if (e.hasAttribute("tabindex") && e.getAttribute("tabindex") !== "-1") return "button";
    return null;
  };
  const SELECTOR = 'a[href],button,input,textarea,select,summary,[contenteditable="true"],[tabindex]:not([tabindex="-1"]),' +
    ROLES.map((r) => '[role="' + r + '"]').join(",");
  const scopeOf = (e) => e.closest('dialog,[role="dialog"],li,tr,[role="row"],[role="option"]');
  const scopeText = (e) => { const s = scopeOf(e); const t = s ? clean(s.innerText) : ""; return t.length <= 300 ? t : ""; };
  const ownText = (e) => clean(e.innerText || e.textContent || "").slice(0, 200);
  const denied = (e) => {
    const fields = [name(e), ownText(e), e.value, e.getAttribute("title"), e.getAttribute("href"), e.getAttribute("data-testid"), e.id, scopeText(e)];
    if (fields.some((f) => f && deny.test(String(f)))) return true;
    if (e.matches("a[href]")) return true;
    // A container wrapping several tier labels is page furniture (the OVD-1052 drag handle), not one offer.
    for (const sel of args.offerContainers) {
      try { const c = e.closest(sel); if (c && c.querySelectorAll('[data-testid="tierAndLeadTime"]').length <= 1) return true; } catch (_) {}
    }
    const form = e.closest("form,fieldset,section");
    if (form && form.querySelector('input[autocomplete^="cc-"]')) return true;
    return false;
  };
  const textBefore = (node, skip) => {
    for (let cur = node, depth = 0; cur && depth < 3; cur = cur.parentElement, depth++) {
      if (cur.tagName === "FIELDSET") { const legend = cur.querySelector(":scope > legend"); if (legend) return clean(legend.innerText); }
      for (let sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.matches("input,select,textarea,button") || sib.querySelector("input,select,textarea")) break;
        const t = clean(sib.innerText);
        if (t && skip && (t === skip || skip.includes(t))) continue;
        if (t) return t.length <= 60 ? t : "";
      }
      if (cur.parentElement && cur.parentElement.tagName === "LABEL") return clean(cur.parentElement.innerText).slice(0, 60);
    }
    return "";
  };
  const near = (e, r, disp) => {
    if (r === "option") {
      const box = e.closest('[role="listbox"]') || e.parentElement;
      const owner = box && box.id ? qsa('[aria-controls~="' + box.id + '"],[aria-owns~="' + box.id + '"]')[0] : null;
      if (owner) return textBefore(owner, display(owner, role(owner))) || name(owner);
      return "";
    }
    if (r === "radio") { const fs = e.closest("fieldset"); const lg = fs && fs.querySelector(":scope > legend"); return lg ? clean(lg.innerText) : ""; }
    return textBefore(e, disp);
  };
  const display = (e, r) => {
    if (e.tagName === "SELECT") return [...e.selectedOptions].map((o) => o.label).join(", ");
    if (r !== "combobox") return "";
    // Only the control box itself (parent, grandparent): never climb into the field label.
    for (let cur = e.parentElement, depth = 0; cur && depth < 2; cur = cur.parentElement, depth++) {
      const clone = cur.cloneNode(true);
      for (const x of clone.querySelectorAll('[role="listbox"],.select__menu,input,label')) x.remove();
      const t = clean(clone.textContent);
      if (t) return t.slice(0, 200);
    }
    return "";
  };
  const clipped = (e, r) => {
    for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (/(auto|scroll|hidden)/.test(cs.overflow + cs.overflowY + cs.overflowX)) {
        const ar = a.getBoundingClientRect();
        if (r.bottom <= ar.top || r.top >= ar.bottom || r.right <= ar.left || r.left >= ar.right) return true;
      }
    }
    return false;
  };
  const modals = qsa("dialog").filter((d) => d.open && d.matches(":modal"))
    .concat(qsa('[aria-modal="true"],[role="dialog"]').filter((d) => d.tagName !== "DIALOG" && visible(d)));
  const modal = modals.length ? modals[modals.length - 1] : null;

  reg.pageKey = () => [performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight,
    qsa("input,textarea,select").filter(safe).map((e) => [identity(e), e.value, e.checked, e.selectedIndex, e.disabled, e.readOnly])];
  reg.guard = (e) => {
    if (!e || !e.isConnected || !visible(e)) return null;
    return [identity(e), role(e), name(e), e.value === undefined ? null : e.value, e.checked === undefined ? null : e.checked,
      e.selectedIndex === undefined ? null : e.selectedIndex, e.readOnly === undefined ? null : e.readOnly, e.matches(":disabled"),
      e.getAttribute("aria-disabled"), e.getAttribute("aria-expanded"), e.getAttribute("aria-checked"), e.getAttribute("aria-selected"),
      e.getAttribute("href"), scopeText(e).slice(0, 2000)];
  };
  reg.prepare = (node, opts) => {
    const e = reg.nodes.get(node);
    if (!e || !e.isConnected) return { ok: false, reason: "detached" };
    if (!visible(e)) return { ok: false, reason: "hidden" };
    if (e.matches(":disabled") || e.closest('[aria-disabled="true"]')) return { ok: false, reason: "disabled" };
    if (opts.fill && (e.readOnly || e.getAttribute("aria-readonly") === "true")) return { ok: false, reason: "readonly" };
    if (denied(e)) return { ok: false, reason: "deny_hit" };
    const freshGuard = reg.guard(e), freshKey = reg.pageKey();
    let r = e.getBoundingClientRect();
    let x = r.x + r.width / 2, y = r.y + r.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || clipped(e, r)) {
      e.scrollIntoView({ block: "center", inline: "center" });
      r = e.getBoundingClientRect(); x = r.x + r.width / 2; y = r.y + r.height / 2;
    }
    if (!r.width || !r.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { ok: false, reason: "offscreen" };
    const root = e.getRootNode();
    const hit = root.elementFromPoint ? root.elementFromPoint(x, y) : document.elementFromPoint(x, y);
    if (!hit || !(hit === e || e.contains(hit))) return { ok: false, reason: "occluded" };
    return { ok: true, x, y, guard: freshGuard, pageKey: freshKey };
  };
  reg.selectNative = (node, value) => {
    const e = reg.nodes.get(node);
    if (!e || e.tagName !== "SELECT" || ![...e.options].some((o) => o.value === value && !o.disabled)) return false;
    e.value = value; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  };
  reg.settle = (node, combobox) => new Promise((resolve) => {
    const field = reg.nodes.get(node);
    const started = performance.now();
    let frames = 0;
    const cap = combobox ? 3000 : 120;
    const menu = () => {
      if (!field) return null;
      const id = (field.getAttribute("aria-controls") || field.getAttribute("aria-owns") || "").split(/\s+/)[0];
      return id ? byId(field, id) : null;
    };
    const tick = () => {
      frames++;
      const elapsed = performance.now() - started;
      if (elapsed >= cap) return resolve({ waitedMs: Math.round(elapsed), capped: true });
      if (frames >= 2 && elapsed >= 50) {
        if (!combobox) return resolve({ waitedMs: Math.round(elapsed), capped: false });
        const m = menu();
        const loading = m ? /loading/i.test(m.innerText || "") : false;
        const options = m ? [...m.children].filter((c) => visible(c) && !/notice/i.test(c.className || "")) : [];
        if (m && visible(m) && !loading && (options.length > 0 || elapsed >= 400)) return resolve({ waitedMs: Math.round(elapsed), capped: false });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const records = [];
  const seen = new Set();
  // Fixed or sticky layers that cover a listed control; controls inside them are marked as part of that overlay.
  const covers = new Set();
  const coverOf = (hit) => {
    for (let a = hit; a && a !== document.body && a !== document.documentElement; a = a.parentElement || (a.getRootNode() && a.getRootNode().host)) {
      const pos = getComputedStyle(a).position;
      if (pos === "fixed" || pos === "sticky") return a;
    }
    return null;
  };
  for (const e of qsa(SELECTOR).concat([...controlled].flatMap((c) => [...c.children]))) {
    if (seen.has(e)) continue;
    seen.add(e);
    if (!safe(e) || !visible(e)) continue;
    if (modal && !(modal === e || modal.contains(e))) continue;
    const r = e.getBoundingClientRect();
    const rname = role(e);
    if (!rname || r.width <= 0 || r.height <= 0) continue;
    if (rname === "gridcell" && e.querySelector('button,[role="button"]')) continue;
    if (rname === "button" && !e.getAttribute("role") && !["BUTTON", "SUMMARY", "INPUT"].includes(e.tagName) &&
      e.querySelector("input,select,textarea")) continue;
    const disabled = e.matches(":disabled") || !!e.closest('[aria-disabled="true"]');
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const inView = cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight;
    const hitRoot = e.getRootNode();
    const hit = inView ? (hitRoot.elementFromPoint ? hitRoot.elementFromPoint(cx, cy) : document.elementFromPoint(cx, cy)) : null;
    const rec = {
      node: identity(e), role: rname, tag: e.tagName.toLowerCase(), type: e.getAttribute("type") || "", inputmode: e.getAttribute("inputmode") || "",
      name: name(e), near: near(e, rname, display(e, rname)), value: "value" in e && e.tagName !== "BUTTON" ? String(e.value) : "", display: display(e, rname),
      checked: ["checkbox", "radio"].includes(e.type) ? !!e.checked : (e.getAttribute("aria-checked") === null ? null : e.getAttribute("aria-checked") === "true"),
      expanded: e.getAttribute("aria-expanded") === null ? null : e.getAttribute("aria-expanded") === "true",
      selected: e.getAttribute("aria-selected") === null ? null : e.getAttribute("aria-selected") === "true",
      disabled, readOnly: !!e.readOnly || e.getAttribute("aria-readonly") === "true",
      offscreen: cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight || clipped(e, r),
      submit: (e.tagName === "BUTTON" && (e.getAttribute("type") || "submit") === "submit" && !!e.form) || (e.tagName === "INPUT" && e.type === "submit"),
      occluded: inView && !!hit && !(hit === e || e.contains(hit)) && !(e.labels && [...e.labels].some((l) => l === hit || l.contains(hit))),
      inDialog: !!modal, denied: denied(e), controls: e.getAttribute("aria-controls") || "",
      inListbox: rname === "option" ? ((e.closest('[role="listbox"]') || e.parentElement || {}).id || "") : "",
    };
    if (rec.occluded && hit) { const cover = coverOf(hit); if (cover) covers.add(cover); }
    rec.element = e;
    records.push(rec);
    if (records.length >= args.maxRecords) break;
  }
  for (const rec of records) {
    rec.overlay = !rec.occluded && [...covers].some((cover) => cover.contains(rec.element));
    delete rec.element;
  }
  const textParts = [document.body.innerText || ""];
  for (const root of roots.slice(1)) for (const child of root.children) if (child.tagName !== "STYLE") textParts.push(child.innerText || "");
  const text = textParts.join("\n").slice(0, 20000);
  const guards = {};
  for (const rec of records) guards[rec.node] = reg.guard(reg.nodes.get(rec.node));
  const pageKey = reg.pageKey();
  const semantics = records.map((rec) => [rec.node, rec.role, rec.name, rec.value, rec.display, rec.checked, rec.expanded, rec.disabled]);
  const layers = [...covers].map((cover) => clean(cover.getAttribute("aria-label") || cover.getAttribute("title") || "")).filter(Boolean);
  return {
    url: location.href, records, text, layers,
    modal: modal ? { text: clean(modal.innerText).slice(0, 2000) } : null,
    pageKey, guards,
    marker: [performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight, semantics, pageKey[6]],
  };
}`;

export type RawRecord = {
  node: number; role: string; tag: string; type: string; inputmode: string; name: string; near: string;
  value: string; display: string; checked: boolean | null; expanded: boolean | null; selected: boolean | null;
  disabled: boolean; readOnly: boolean; offscreen: boolean; occluded: boolean; overlay: boolean; submit: boolean; inDialog: boolean; denied: boolean;
  controls: string; inListbox: string;
};

export type FrameObservation = {
  url: string;
  records: RawRecord[];
  text: string;
  /** Accessible names of fixed layers that cover listed controls. */
  layers: string[];
  modal: { text: string } | null;
  pageKey: unknown[];
  guards: Record<string, unknown>;
  marker: unknown[];
};

export type PrepareResult =
  | { ok: true; x: number; y: number; guard: unknown; pageKey: unknown[] }
  | { ok: false; reason: "detached" | "hidden" | "disabled" | "readonly" | "deny_hit" | "offscreen" | "occluded" };
