/* Quote Press — an invented machine that explains one idea:
   a STEP file goes in; independent supplier offers come out as fixed dots on a
   price-vs-working-days plate; one dot is selected.
   Single true-iso camera, filled solids painted back to front, four tones. */
(function () {
  const S = 34, C = Math.cos(Math.PI / 6), SN = 0.5, NS = "http://www.w3.org/2000/svg";
  const OX = 300, OY = 150;               // screen origin of world (0,0,0)
  const P = (x, y, z) => [OX + (x - y) * C * S, OY + (x + y) * SN * S - z * S];
  const f = (n) => n.toFixed(1);
  const el = (n, a = {}, parent) => { const e = document.createElementNS(NS, n);
    for (const k in a) e.setAttribute(k, a[k]); if (parent) parent.appendChild(e); return e; };
  const pts = (arr) => arr.map((p) => f(p[0]) + "," + f(p[1])).join(" ");

  // box: top, left face (y+d side), right face (x+w side)
  function box(g, x, y, z, w, d, h, cls = {}) {
    const t = cls.top || "face-top", l = cls.l || "face-l", r = cls.r || "face-r";
    el("polygon", { class: l, points: pts([P(x, y + d, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x, y + d, z + h)]) }, g);
    el("polygon", { class: r, points: pts([P(x + w, y, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x + w, y, z + h)]) }, g);
    el("polygon", { class: t, points: pts([P(x, y, z + h), P(x + w, y, z + h), P(x + w, y + d, z + h), P(x, y + d, z + h)]) }, g);
  }
  function cyl(g, x, y, z, r, h, cls = {}) {
    const [cx, cy] = P(x, y, z), rx = r * S * C * Math.SQRT2, ry = r * S * SN * Math.SQRT2, hh = h * S;
    el("ellipse", { class: cls.r || "face-r", cx: f(cx), cy: f(cy), rx: f(rx), ry: f(ry) }, g);
    el("rect", { class: cls.r || "face-r", x: f(cx - rx), y: f(cy - hh), width: f(2 * rx), height: f(hh), stroke: "none" }, g);
    el("path", { class: "grid", d: `M${f(cx - rx)} ${f(cy - hh)}V${f(cy)}M${f(cx + rx)} ${f(cy - hh)}V${f(cy)}`, style: "stroke:var(--text);stroke-width:.9" }, g);
    return el("ellipse", { class: (cls.top || "face-top") + " top", cx: f(cx), cy: f(cy - hh), rx: f(rx), ry: f(ry) }, g);
  }
  function floorLine(g, a, b, z) { el("path", { class: "grid", d: `M${pts([P(a[0], a[1], z)])}L${pts([P(b[0], b[1], z)])}` }, g); }

  // illustrative offers: working days (x), total USD (y), origin
  const OFFERS = [
    ["SUPPLIER 01", 3, 212, "US"], ["SUPPLIER 01", 5, 168, "US"], ["SUPPLIER 01", 9, 131, "US"],
    ["SUPPLIER 02", 4, 190, "US"], ["SUPPLIER 02", 8, 112, "US"], ["SUPPLIER 03", 6, 148, "UNKNOWN"],
    ["SUPPLIER 03", 12, 96, "UNKNOWN"], ["SUPPLIER 04", 10, 74, "GLOBAL"], ["SUPPLIER 04", 15, 58, "GLOBAL"],
    ["SUPPLIER 04", 20, 46, "GLOBAL"], ["SUPPLIER 05", 7, 124, "US"], ["SUPPLIER 05", 14, 88, "US"],
    ["SUPPLIER 06", 11, 102, "GLOBAL"], ["SUPPLIER 06", 18, 64, "UNKNOWN"],
  ].map((o, i) => ({ id: i, vendor: o[0], days: o[1], price: o[2], origin: o[3] }));
  const SELECTED_DEFAULT = 4;

  window.OverdrafterMachine = function (mount, opts = {}) {
    const svg = el("svg", { class: "machine", viewBox: "0 0 780 570", role: "img",
      "aria-label": "Illustration: a STEP part travels along a conveyor, is scanned by a gantry, and fourteen supplier offers appear as fixed dots on a price versus working-days plate. One dot is selected." });
    mount.appendChild(svg);
    const state = { sel: opts.selected ?? SELECTED_DEFAULT, listeners: [] };

    // ---- BASE ---------------------------------------------------------
    const base = el("g", {}, svg);
    box(base, -0.4, -0.4, -0.5, 15.4, 8.8, 0.5);
    box(base, 0, 0, 0, 14.6, 8, 0.35);
    box(base, 0.3, 0.3, 0.35, 14, 7.4, 0.12, { top: "face-top" });

    // ---- QUOTE PLATE (scatter) ---------------------------------------
    const BX = 9.6, BY = 0.7, BW = 4.4, BD = 6.6;
    const plate = el("g", {}, svg);
    box(plate, BX - 0.2, BY - 0.2, 0.47, BW + 0.4, BD + 0.4, 0.2);
    for (let i = 0; i <= 4; i++) floorLine(plate, [BX + (BW * i) / 4, BY], [BX + (BW * i) / 4, BY + BD], 0.67);
    for (let j = 0; j <= 4; j++) floorLine(plate, [BX, BY + (BD * j) / 4], [BX + BW, BY + BD * j / 4], 0.67);
    const dotsG = el("g", {}, svg);
    const pos = (o) => [BX + 0.35 + ((o.days - 2) / 20) * (BW - 0.7), BY + BD - 0.35 - ((o.price - 40) / 190) * (BD - 0.7)];
    const dotEls = OFFERS.slice().sort((a, b) => (pos(a)[0] + pos(a)[1]) - (pos(b)[0] + pos(b)[1])).map((o) => {
      const g = el("g", { class: "dot", tabindex: 0, role: "button", "data-id": o.id,
        "aria-label": `${o.vendor}, ${o.days} working days, $${o.price}, ${o.origin}` }, dotsG);
      const [x, y] = pos(o);
      cyl(g, x, y, 0.67, 0.24, 0.12, { top: "face-top", r: "face-r" });
      const [cx, cy] = P(x, y, 0.8);
      el("ellipse", { class: "hit", cx: f(cx), cy: f(cy), rx: 12, ry: 12 }, g);
      g.addEventListener("click", () => select(o.id));
      g.addEventListener("pointerenter", () => select(o.id));
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(o.id); } });
      return [o.id, g];
    });

    // ---- SUPPLIER CASSETTE TOWER (back) ------------------------------
    const tower = el("g", {}, svg);
    box(tower, 6.9, 0.3, 0.47, 2.2, 1.7, 0.3);
    for (let k = 0; k < 6; k++) {
      const z = 0.77 + k * 0.5;
      box(tower, 7.0, 0.4, z, 2.0, 1.5, 0.44, { l: "face-l", r: "face-r", top: "face-top" });
      box(tower, 7.25, 1.9, z + 0.17, 0.5, 0.06, 0.1, { l: "face-d", r: "face-d", top: "face-d" });
      cyl(tower, 8.6, 1.95, z + 0.22, 0.08, 0.06, { top: "face-d", r: "face-d" });
    }
    box(tower, 7.0, 0.4, 3.77, 2.0, 1.5, 0.2, { top: "face-d", l: "face-d", r: "face-d" });

    // conduits tower -> plate + tower -> hopper
    box(svg.appendChild(el("g")), 9.0, 1.0, 1.3, 0.6, 0.12, 0.12);
    box(svg.appendChild(el("g")), 9.0, 1.0, 2.3, 0.6, 0.12, 0.12);
    box(svg.appendChild(el("g")), 7.8, 2.0, 1.1, 0.12, 1.2, 0.12);

    // ---- CONVEYOR -----------------------------------------------------
    const conv = el("g", {}, svg);
    for (const lx of [0.6, 3.2, 6.0]) for (const ly of [3.1, 4.7]) box(conv, lx, ly, 0.47, 0.18, 0.18, 0.4, { top: "face-d" });
    box(conv, 0.3, 3.0, 0.87, 7.2, 2.0, 0.28);
    box(conv, 0.3, 3.0, 1.15, 7.2, 0.12, 0.12, { top: "face-r" });
    box(conv, 0.3, 4.88, 1.15, 7.2, 0.12, 0.12, { top: "face-r" });
    const belt = el("g", {}, svg);
    box(belt, 0.3, 3.14, 1.15, 7.2, 1.72, 0.04, { top: "face-d", l: "face-d", r: "face-d" });
    for (let i = 0; i < 12; i++) box(belt, 0.55 + i * 0.6, 3.2, 1.19, 0.08, 1.6, 0.01, { top: "face-top" });

    // ---- GANTRY (scan) -----------------------------------------------
    const GX = 5.0;
    const postFar = el("g", {}, svg);
    box(postFar, GX, 2.4, 0.47, 0.5, 0.5, 0.2, { top: "face-d" });
    box(postFar, GX + 0.1, 2.5, 0.67, 0.3, 0.3, 3.0);
    // moving part
    const partG = el("g", { class: "part" }, svg);
    box(partG, 1.0, 3.55, 1.19, 1.5, 0.9, 0.35);                 // foot
    box(partG, 1.0, 3.55, 1.54, 0.4, 0.9, 0.9);                  // upright
    box(partG, 1.1, 3.8, 1.9, 0.2, 0.4, 0.001, { top: "face-d" }); // hole
    box(partG, 1.6, 3.8, 1.54, 0.2, 0.4, 0.001, { top: "face-d" });
    box(partG, 2.4, 3.8, 1.54, 0.2, 0.4, 0.001, { top: "face-d" });
    const dx = 5.4 * C * S, dy = 5.4 * SN * S;
    el("animateTransform", { attributeName: "transform", type: "translate", dur: "9s", repeatCount: "indefinite",
      values: `0 0; ${f(dx * .7)} ${f(dy * .7)}; ${f(dx * .7)} ${f(dy * .7)}; ${f(dx)} ${f(dy)}`, keyTimes: "0;.5;.72;1" }, partG);
    el("animate", { attributeName: "opacity", dur: "9s", repeatCount: "indefinite", values: "0;1;1;1;0", keyTimes: "0;.05;.8;.97;1" }, partG);

    const postNear = el("g", {}, svg);
    box(postNear, GX, 5.2, 0.47, 0.5, 0.5, 0.2, { top: "face-d" });
    box(postNear, GX + 0.1, 5.3, 0.67, 0.3, 0.3, 3.0);
    box(postNear, GX - 0.15, 2.4, 3.67, 0.8, 3.3, 0.35);        // crossbeam
    // scan head + sweeping plane
    const head = el("g", {}, svg);
    box(head, GX - 0.05, 3.7, 3.0, 0.6, 0.7, 0.67, { top: "face-d", l: "face-d", r: "face-d" });
    cyl(head, GX + 0.25, 4.05, 3.0, 0.1, 0.08, { top: "face-top", r: "face-d" });
    const plane = el("g", {}, svg);
    el("polygon", { class: "beam", fill: "none",
      points: pts([P(GX + 0.25, 2.9, 1.2), P(GX + 0.25, 5.1, 1.2), P(GX + 0.25, 5.1, 3.0), P(GX + 0.25, 2.9, 3.0)]) }, plane);
    el("path", { class: "beam", d: `M${pts([P(GX + .25, 2.9, 2.1)])}L${pts([P(GX + .25, 5.1, 2.1)])}`, style: "stroke-dasharray:none;stroke-width:1.4" }, plane);
    const sw = 0.9 * S;
    el("animateTransform", { attributeName: "transform", type: "translate", dur: "9s", repeatCount: "indefinite",
      values: `0 ${f(-0.6*S)}; 0 ${f(-0.6*S)}; 0 ${f(.4*S)}; 0 ${f(-0.6*S)}; 0 ${f(-0.6*S)}`, keyTimes: "0;.45;.58;.72;1" }, plane);
    el("animate", { attributeName: "opacity", dur: "9s", repeatCount: "indefinite", values: "0;0;1;1;0;0", keyTimes: "0;.45;.5;.7;.74;1" }, plane);

    // ---- HOPPER (in) --------------------------------------------------
    const hop = el("g", {}, svg);
    box(hop, 7.5, 3.0, 0.47, 1.6, 2.0, 1.6);
    box(hop, 7.7, 3.2, 2.07, 1.2, 1.6, 0.4, { top: "face-d" });
    box(hop, 7.9, 3.4, 2.47, 0.8, 1.2, 0.5);
    box(hop, 9.1, 3.8, 0.9, 0.5, 0.4, 0.4, { top: "face-d" });  // outlet to plate

    // ---- CONSOLE (controls) ------------------------------------------
    const con = el("g", {}, svg);
    box(con, 0.6, 6.3, 0.47, 4.4, 1.3, 0.9);
    box(con, 0.6, 6.3, 1.37, 4.4, 1.3, 0.12, { top: "face-top" });
    for (let i = 0; i < 3; i++) cyl(con, 1.1 + i * 0.8, 6.95, 1.49, 0.22, 0.1, { top: "face-top", r: "face-d" });
    for (let i = 0; i < 6; i++) box(con, 3.4 + (i % 3) * 0.45, 6.55 + Math.floor(i / 3) * 0.5, 1.49, 0.3, 0.3, 0.07, { top: i === 4 ? "face-red" : "face-top" });
    box(con, 1.0, 7.3, 1.49, 1.8, 0.2, 0.05, { top: "face-d" });

    // output tray + roll stand (extra detail)
    const tray = el("g", {}, svg);
    box(tray, 6.2, 6.1, 0.47, 2.6, 1.6, 0.35);
    for (let i = 0; i < 4; i++) box(tray, 6.4 + i * 0.6, 6.3, 0.82, 0.45, 1.2, 0.22, { top: i === 0 ? "face-top" : "face-top" });

    // ---- SELECTION ----------------------------------------------------
    function select(id) {
      state.sel = id;
      dotEls.forEach(([i, g]) => g.classList.toggle("sel", i === id));
      const o = OFFERS[id];
      const sel = dotEls.find(([i]) => i === id)[1];
      sel.parentNode.appendChild(sel);
      state.listeners.forEach((fn) => fn(o));
    }
    select(state.sel);
    return { offers: OFFERS, select, onSelect: (fn) => { state.listeners.push(fn); fn(OFFERS[state.sel]); } };
  };
})();
