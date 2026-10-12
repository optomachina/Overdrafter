/* Shared isometric kit: one true-iso camera, filled solids, four tones, painter's order set by the caller. */
window.Iso = function (svg, o = {}) {
  const S = o.S || 26, OX = o.OX || 190, OY = o.OY || 150, C = Math.cos(Math.PI / 6), SN = 0.5;
  const NS = "http://www.w3.org/2000/svg", f = (n) => n.toFixed(1);
  const P = (x, y, z) => [OX + (x - y) * C * S, OY + (x + y) * SN * S - z * S];
  const el = (n, a = {}, p) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); if (p) p.appendChild(e); return e; };
  const pts = (arr) => arr.map((p) => f(p[0]) + "," + f(p[1])).join(" ");
  const api = {
    P, el, S,
    g: (parent = svg) => el("g", {}, parent),
    box(g, x, y, z, w, d, h, c = {}) {
      el("polygon", { class: c.l || "face-l", points: pts([P(x, y + d, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x, y + d, z + h)]) }, g);
      el("polygon", { class: c.r || "face-r", points: pts([P(x + w, y, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x + w, y, z + h)]) }, g);
      el("polygon", { class: c.top || "face-top", points: pts([P(x, y, z + h), P(x + w, y, z + h), P(x + w, y + d, z + h), P(x, y + d, z + h)]) }, g);
    },
    dark: { top: "face-d", l: "face-d", r: "face-d" },
    red: { top: "face-red", l: "face-red", r: "face-red" },
    cyl(g, x, y, z, r, h, c = {}) {
      const [cx, cy] = P(x, y, z), rx = r * S * C * Math.SQRT2, ry = r * S * SN * Math.SQRT2, hh = h * S, side = c.r || "face-r";
      el("ellipse", { class: side, cx: f(cx), cy: f(cy), rx: f(rx), ry: f(ry) }, g);
      el("rect", { class: side, x: f(cx - rx), y: f(cy - hh), width: f(2 * rx), height: f(hh), stroke: "none" }, g);
      el("path", { class: "edge", d: `M${f(cx - rx)} ${f(cy - hh)}V${f(cy)}M${f(cx + rx)} ${f(cy - hh)}V${f(cy)}` }, g);
      el("ellipse", { class: c.top || "face-top", cx: f(cx), cy: f(cy - hh), rx: f(rx), ry: f(ry) }, g);
    },
    poly(g, cls, p3) { return el("polygon", { class: cls, points: pts(p3.map((p) => P(...p))) }, g); },
    line(g, a, b, cls = "edge") { return el("path", { class: cls, d: `M${pts([P(...a)])}L${pts([P(...b)])}` }, g); },
    plinth(g) { api.box(g, 0, 0, -0.3, 8, 6, 0.3); api.box(g, 0.25, 0.25, 0, 7.5, 5.5, 0.06); },
    // world-space translate animation: keyframes [dx,dy,dz]
    move(g, frames, dur, kt, begin = "0s") {
      const v = frames.map(([x, y, z]) => `${f((x - y) * C * S)} ${f((x + y) * SN * S - z * S)}`).join(";");
      el("animateTransform", { attributeName: "transform", type: "translate", values: v, dur: dur + "s", begin, repeatCount: "indefinite", ...(kt ? { keyTimes: kt } : {}) }, g);
    },
    fade(g, vals, dur, kt, begin = "0s") {
      el("animate", { attributeName: "opacity", values: vals, dur: dur + "s", begin, repeatCount: "indefinite", ...(kt ? { keyTimes: kt } : {}) }, g);
    },
    still() { const m = matchMedia("(prefers-reduced-motion: reduce)").matches; if (m) { svg.pauseAnimations(); svg.setCurrentTime(o.stillAt || 3); } },
  };
  return api;
};
