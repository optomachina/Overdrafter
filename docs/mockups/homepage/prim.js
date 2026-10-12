/* Thirteen service primitives. Each is an invented machine whose mechanism is the idea.
   Painter's order is written out by hand: far to near. No text inside any drawing. */
window.PRIMS = [
{ key: "mechanical-design", group: "Design", title: "Mechanical design", idea: "A caliper closes on a real part: intent becomes dimensions.",
  draw(I, svg) { const g = I.g(); I.plinth(g);
    const fixedJ = I.g(); I.box(fixedJ, 2.9, 1.5, 0.06, 0.3, 0.25, 0.7);
    const part = I.g(); I.box(part, 2, 2, 0.06, 2.2, 1.4, 0.4); I.box(part, 2, 2, 0.46, 0.5, 1.4, 1.4);
    I.box(part, 3.3, 2.4, 0.46, 0.4, 0.4, 0.01, I.dark); I.box(part, 2.1, 2.4, 1.86, 0.3, 0.4, 0.01, I.dark);
    const mv = I.g(); I.move(mv, [[0, 0.6, 0], [0, 0.6, 0], [0, 0, 0], [0, 0, 0], [0, 0.6, 0]], 5, "0;.2;.5;.8;1");
    I.box(mv, 2.9, 3.5, 0.06, 0.3, 0.25, 0.7); I.box(mv, 2.9, 3.5, 0.76, 0.3, 0.25, 0.01, { top: "face-red" });
    const beam = I.g(); I.box(beam, 2.9, 1.5, 0.76, 0.3, 4.2, 0.18);
    for (let i = 0; i < 9; i++) I.box(beam, 2.95, 1.9 + i * 0.4, 0.94, 0.2, 0.05, 0.01, I.dark);
    const bar = I.g(); I.box(bar, 5.0, 4.6, 0.06, 1.8, 0.8, 0.5); I.box(bar, 5.2, 4.8, 0.56, 1.4, 0.4, 0.01, I.dark);
  } },
{ key: "cad-workstation", group: "Design", title: "CAD workstation", idea: "A 3D mouse puck steers the model above it.",
  draw(I) { const g = I.g(); I.plinth(g);
    for (const [x, y] of [[0.7, 1.2], [6.9, 1.2], [0.7, 4.8], [6.9, 4.8]]) I.box(g, x, y, 0.06, 0.2, 0.2, 1.1);
    I.box(g, 0.5, 1, 1.16, 7, 4, 0.2);
    I.box(g, 3.9, 1.5, 1.36, 0.8, 0.5, 0.15, I.dark); I.box(g, 4.2, 1.7, 1.5, 0.2, 0.2, 0.7);
    I.box(g, 2.2, 1.35, 2.2, 3.4, 0.2, 2.0);
    const s = I.g(); I.poly(s, "face-d", [[2.4, 1.56, 2.4], [4.55, 1.56, 2.4], [4.55, 1.56, 3.95], [2.4, 1.56, 3.95]]);
    for (const [a, b] of [[[2.8, 1.57, 2.8], [3.8, 1.57, 2.8]], [[3.8, 1.57, 2.8], [3.8, 1.57, 3.5]], [[3.8, 1.57, 3.5], [2.8, 1.57, 3.5]], [[2.8, 1.57, 3.5], [2.8, 1.57, 2.8]], [[3.3, 1.57, 3.8], [3.3, 1.57, 2.8]]]) I.line(s, a, b, "wire");
    I.box(g, 2.4, 3.3, 1.36, 2.6, 0.9, 0.1);
    for (let i = 0; i < 6; i++) I.box(g, 2.55 + i * 0.4, 3.5, 1.46, 0.28, 0.5, 0.01, I.dark);
    const pk = I.g(); I.move(pk, [[0, 0, 0], [0, 0, 0.5], [0, 0, 0]], 3.5);
    I.cyl(pk, 6.0, 3.0, 1.36, 0.45, 0.25, I.dark);
    const pt = I.g(); I.move(pt, [[0, 0, 0], [0, 0, 0.5], [0, 0, 0]], 3.5);
    I.box(pt, 5.5, 3.5, 2.4, 1.0, 0.8, 0.3); I.box(pt, 5.5, 3.5, 2.7, 0.3, 0.8, 0.7); I.box(pt, 5.65, 3.8, 3.4, 0.1, 0.2, 0.01, { top: "face-red" });
  } },
{ key: "text-to-cad", group: "Design", title: "Text to CAD", idea: "A tape of words feeds a printer that builds the part.",
  draw(I) { const g = I.g(); I.plinth(g);
    I.box(g, 0.4, 0.8, 0.06, 3.4, 0.9, 0.12);
    const chips = I.g(); I.move(chips, [[0, 0, 0], [0.4, 0, 0]], 1.6);
    for (let i = 0; i < 8; i++) I.box(chips, 0.5 + i * 0.4, 1.0, 0.18, 0.22, 0.5, 0.01, i === 4 ? { top: "face-red" } : I.dark);
    I.box(g, 3.9, 1.0, 0.06, 0.5, 0.5, 0.3, I.dark);
    I.box(g, 4.4, 0.9, 0.06, 0.4, 0.4, 3.6); I.box(g, 4.4, 4.7, 0.06, 0.4, 0.4, 3.6);
    I.box(g, 4.7, 2.6, 0.5, 2.6, 2.6, 0.2);
    for (let i = 0; i < 7; i++) { const L = I.g(); const k = 0.1 + i * 0.1; I.fade(L, "0;0;1;1;0", 7, `0;${k.toFixed(2)};${(k + .03).toFixed(2)};.92;1`); I.box(L, 5.1, 3.0, 0.7 + i * 0.28, 1.8 - (i % 2) * 0.3, 1.8 - (i % 2) * 0.3, 0.26); }
    const head = I.g(); I.move(head, [[0, 0, 0], [0, 0, -1.8], [0, 0, 0]], 7, "0;.8;1");
    I.box(head, 5.6, 3.5, 3.3, 0.5, 0.5, 0.5, I.dark);
    I.box(g, 4.4, 0.9, 3.66, 0.4, 3.8, 0.34);
  } },
{ key: "cad-to-drawing", group: "Design", title: "CAD to drawing", idea: "A 3D part is flattened through a pane into views on a sheet.",
  draw(I) { const g = I.g(); I.plinth(g);
    I.box(g, 0.6, 2.0, 0.06, 1.6, 1.4, 0.4); I.box(g, 0.6, 2.0, 0.46, 0.5, 1.4, 1.2);
    const pane = I.g(); I.move(pane, [[0, 0, 0], [0.5, 0, 0], [0, 0, 0]], 6);
    I.poly(pane, "pane", [[3.0, 0.9, 0.06], [3.0, 4.5, 0.06], [3.0, 4.5, 2.6], [3.0, 0.9, 2.6]]);
    I.box(g, 4.6, 0.8, 0.06, 3.0, 4.4, 0.05);
    const v = (cls, p, t) => { const gg = I.g(); I.fade(gg, "0;0;1;1;0", 6, `0;${t};${(t + .05).toFixed(2)};.9;1`); I.poly(gg, cls, p); return gg; };
    v("view", [[5.0, 1.2, 0.12], [6.2, 1.2, 0.12], [6.2, 2.0, 0.12], [5.0, 2.0, 0.12]], 0.2);
    v("view", [[5.0, 2.5, 0.12], [6.2, 2.5, 0.12], [6.2, 3.3, 0.12], [5.0, 3.3, 0.12]], 0.4);
    v("view", [[6.7, 1.2, 0.12], [7.2, 1.2, 0.12], [7.2, 2.0, 0.12], [6.7, 2.0, 0.12]], 0.6);
    const d = v("dim", [[5.0, 2.2, 0.12], [6.2, 2.2, 0.12], [6.2, 2.22, 0.12], [5.0, 2.22, 0.12]], 0.75);
    I.poly(g, "view", [[6.4, 4.0, 0.12], [7.4, 4.0, 0.12], [7.4, 5.0, 0.12], [6.4, 5.0, 0.12]]);
  } },
{ key: "drafting", group: "Design", title: "Drafting", idea: "The red pencil mark is drawn along a straightedge.",
  draw(I) { const g = I.g(); I.plinth(g);
    for (const [x, y] of [[0.7, 0.8], [6.8, 0.8], [0.7, 4.8], [6.8, 4.8]]) I.box(g, x, y, 0.06, 0.25, 0.25, 0.9);
    I.box(g, 0.5, 0.6, 0.96, 7, 4.8, 0.2); I.box(g, 1.0, 1.0, 1.16, 6, 4, 0.03);
    I.poly(g, "view", [[1.4, 3.6, 1.2], [6.6, 3.6, 1.2], [6.6, 4.7, 1.2], [1.4, 4.7, 1.2]]);
    I.box(g, 0.8, 1.0, 1.19, 0.4, 4.0, 0.18);
    I.box(g, 1.2, 2.3, 1.19, 5.2, 0.28, 0.06, { top: "face-top" });
    const line = I.g(); const z = 1.26; const mk = (L) => [[1.6, 2.1, z], [1.6 + L, 2.1, z], [1.6 + L, 2.18, z], [1.6, 2.18, z]].map((p) => I.P(...p).map((n) => n.toFixed(1)).join(",")).join(" ");
    const pl = I.el("polygon", { class: "face-red", points: mk(0.1) }, line);
    I.el("animate", { attributeName: "points", dur: "5s", repeatCount: "indefinite", values: `${mk(0.1)};${mk(4.2)};${mk(4.2)};${mk(0.1)}`, keyTimes: "0;.7;.9;1" }, pl);
    const pen = I.g(); I.move(pen, [[0, 0, 0], [4.1, 0, 0], [4.1, 0, 0], [0, 0, 0]], 5, "0;.7;.9;1");
    I.cyl(pen, 1.7, 2.14, 1.26, 0.1, 0.7, I.dark); I.cyl(pen, 1.7, 2.14, 1.26, 0.06, 0.12, { top: "face-red", r: "face-red" });
  } },
{ key: "quoting", group: "Source", title: "Quoting", idea: "A part goes in; independent offers land as fixed dots.",
  draw(I) { const g = I.g(); I.plinth(g);
    I.box(g, 0.4, 2.2, 0.06, 2.2, 1.6, 0.3, I.dark);
    const c = I.g(); I.move(c, [[0, 0, 0], [1.2, 0, 0]], 3); I.fade(c, "0;1;1;0", 3, "0;.15;.7;1"); I.box(c, 0.7, 2.6, 0.36, 0.7, 0.7, 0.5);
    I.box(g, 2.6, 1.8, 0.06, 1.2, 2.2, 1.7);
    I.box(g, 4.2, 0.8, 0.06, 3.4, 4.4, 0.18);
    const pos = [[4.7, 4.5], [5.0, 3.7], [5.5, 3.9], [5.3, 2.8], [6.0, 3.0], [6.4, 2.2], [6.8, 2.6], [7.0, 1.6], [5.9, 1.5]];
    pos.forEach(([x, y], i) => I.cyl(g, x, y, 0.24, 0.22, 0.1, i === 4 ? { top: "face-red", r: "face-red" } : {}));
  } },
{ key: "procurement", group: "Source", title: "Procurement", idea: "An order is routed down one of several supplier lanes.",
  draw(I) { const g = I.g(); I.plinth(g);
    for (const y of [0.7, 2.6, 4.5]) { I.box(g, 3.6, y, 0.06, 3.0, 0.8, 0.2); I.box(g, 6.6, y - 0.1, 0.06, 1.0, 1.0, 0.9); }
    I.box(g, 3.3, 0.7, 0.06, 0.4, 4.6, 0.2);
    I.box(g, 0.3, 2.6, 0.06, 3.3, 0.8, 0.2);
    I.box(g, 3.35, 2.5, 0.26, 0.3, 1.0, 0.08, I.dark);
    const o = I.g(); I.move(o, [[0, 0, 0], [3.0, 0, 0], [3.0, -1.9, 0], [6.0, -1.9, 0], [6.0, -1.9, 0]], 7, "0;.3;.5;.9;1"); I.fade(o, "0;1;1;0;0", 7, "0;.05;.85;.92;1");
    I.box(o, 0.6, 2.75, 0.26, 0.5, 0.5, 0.45, I.red);
  } },
{ key: "vendor-qualification", group: "Source", title: "Vendor qualification", idea: "Candidates pass a gauge; one earns the approved mark.",
  draw(I) { const g = I.g(); I.plinth(g);
    I.box(g, 0.4, 2.4, 0.06, 7.2, 1.2, 0.18);
    const hs = [0.9, 1.3, 1.0, 1.7, 0.8];
    hs.forEach((h, i) => { if (i === 2) return; I.box(g, 0.7 + i * 1.4, 2.7, 0.24, 0.8, 0.6, h, i === 3 ? { top: "face-top" } : {}); });
    I.box(g, 3.3, 2.1, 0.06, 0.25, 0.25, 2.4); I.box(g, 3.3, 3.7, 0.06, 0.25, 0.25, 2.4);
    I.box(g, 3.2, 2.0, 2.3, 0.9, 2.1, 0.22);
    I.box(g, 3.5, 2.7, 0.24, 0.8, 0.6, 1.0, I.red);
    const st = I.g(); I.move(st, [[0, 0, 0], [0, 0, -0.6], [0, 0, 0]], 3); I.box(st, 3.55, 2.75, 2.6, 0.6, 0.5, 0.5, I.dark);
    I.box(g, 6.2, 0.6, 0.06, 1.4, 1.0, 0.3);
    for (let i = 0; i < 3; i++) I.box(g, 6.35, 0.75 + i * 0.01, 0.36 + i * 0.12, 1.1, 0.7, 0.1, i === 2 ? I.dark : {});
  } },
{ key: "purchasing", group: "Source", title: "Purchasing", idea: "A commitment drops through the slot into the ledger vault.",
  draw(I) { const g = I.g(); I.plinth(g);
    I.box(g, 2.4, 1.6, 0.06, 3.2, 3.2, 2.2);
    I.box(g, 3.2, 3.0, 2.26, 1.6, 0.25, 0.01, I.dark);
    I.cyl(g, 4.2, 2.2, 2.26, 0.4, 0.14, I.dark);
    I.box(g, 5.3, 2.0, 0.06, 1.8, 1.2, 0.35); I.box(g, 5.4, 2.1, 0.41, 1.5, 1.0, 0.05, { top: "face-top" });
    for (const [i, t] of [[0, 0], [1, 0.33], [2, 0.66]]) {
      const c = I.g(); I.move(c, [[0, 0, 3], [0, 0, 0], [0, 0, 0]], 3, "0;.5;1", `${t * 3}s`); I.fade(c, "0;1;1;0", 3, "0;.1;.5;.52", `${t * 3}s`);
      I.cyl(c, 4.0, 3.1, 2.4, 0.3, 0.08, i === 0 ? { top: "face-red", r: "face-red" } : {});
    }
    I.box(g, 0.5, 3.8, 0.06, 1.6, 1.4, 0.2, I.dark); I.box(g, 0.6, 3.9, 0.26, 1.4, 1.2, 0.18);
  } },
{ key: "inspection", group: "Deliver", title: "Inspection", idea: "A probe walks a bridge over the part and touches it.",
  draw(I) { const g = I.g(); I.plinth(g);
    I.box(g, 0.9, 0.9, 0.06, 6.2, 4.2, 0.6);
    I.box(g, 3.0, 2.2, 0.66, 1.4, 1.4, 0.4); I.box(g, 3.0, 2.2, 1.06, 0.4, 1.4, 0.9);
    const br = I.g(); I.move(br, [[0, 0, 0], [2.0, 0, 0], [0, 0, 0]], 8);
    I.box(br, 1.5, 1.1, 0.66, 0.35, 0.35, 2.4); I.box(br, 1.5, 4.5, 0.66, 0.35, 0.35, 2.4); I.box(br, 1.5, 1.1, 3.06, 0.35, 3.75, 0.3);
    const car = I.g(); I.move(car, [[0, 0, 0], [0, 1.3, 0], [0, 0, 0]], 3.2); I.box(car, 1.4, 2.4, 2.6, 0.55, 0.55, 0.46, I.dark);
    I.box(car, 1.62, 2.62, 1.5, 0.1, 0.1, 1.1); I.cyl(car, 1.67, 2.67, 1.4, 0.1, 0.1, { top: "face-red", r: "face-red" });
  } },
{ key: "assembly", group: "Deliver", title: "Assembly", idea: "A bracket lowers onto its base and pins lock it down.",
  draw(I) { const g = I.g(); I.plinth(g);
    I.box(g, 1.5, 1.2, 0.06, 5, 3.4, 0.25);
    I.box(g, 2.5, 2.0, 0.31, 2.8, 1.8, 0.4);
    I.box(g, 2.8, 2.4, 0.71, 0.01, 0.01, 0.01); 
    const br = I.g(); I.move(br, [[0, 0, 1.8], [0, 0, 0], [0, 0, 0], [0, 0, 1.8]], 6, "0;.35;.85;1");
    I.box(br, 2.7, 2.2, 0.71, 2.4, 1.4, 0.35); I.box(br, 2.7, 2.2, 1.06, 0.5, 1.4, 1.0);
    I.box(br, 4.0, 2.6, 1.06, 0.4, 0.4, 0.01, I.dark);
    for (const [x, t] of [[3.5, 0], [4.45, .06]]) { const p = I.g(); I.move(p, [[0, 0, 2.2], [0, 0, 2.2], [0, 0, 0], [0, 0, 0], [0, 0, 2.2]], 6, `0;${.35 + t};${.5 + t};.85;1`); I.cyl(p, x, 2.8, 1.0, 0.14, 0.4, { top: "face-red", r: "face-red" }); }
  } },
{ key: "fulfillment", group: "Deliver", title: "Fulfillment", idea: "A sealed crate rolls onto the truck and out the door.",
  draw(I) { const g = I.g(); I.plinth(g);
    I.box(g, 0.4, 2.1, 0.06, 5.4, 1.8, 0.2);
    const cr = I.g(); I.move(cr, [[0, 0, 0], [0, 0, 0], [3.8, 0, 0]], 6, "0;.3;1");
    I.box(cr, 0.8, 2.4, 0.26, 1.2, 1.2, 0.8);
    const lid = I.g(); I.move(lid, [[0, 0, 1.5], [0, 0, 0], [3.8, 0, 0]], 6, "0;.25;1"); I.fade(lid, "0;1;1", 6, "0;.02;1");
    I.box(lid, 0.7, 2.3, 1.06, 1.4, 1.4, 0.1); I.box(lid, 1.1, 2.8, 1.16, 0.5, 0.3, 0.01, I.red);
    I.box(g, 6.0, 1.4, 0.4, 1.8, 3.2, 2.0); I.box(g, 6.0, 1.4, 0.4, 0.01, 0.01, 0.01);
    for (const y of [1.6, 4.0]) I.cyl(g, 6.8, y, 0.06, 0.4, 0.4, I.dark);
  } },
{ key: "analysis", group: "Deliver", title: "Analysis", idea: "A ram loads the part; the stress hot spot lights up.",
  draw(I) { const g = I.g(); I.plinth(g);
    I.box(g, 1.2, 2.2, 0.06, 0.9, 1.4, 0.8); I.box(g, 5.9, 2.2, 0.06, 0.9, 1.4, 0.8);
    I.box(g, 1.2, 2.2, 0.86, 5.6, 1.4, 0.4);
    const hot = I.g(); I.fade(hot, "0;0;1;1;0", 6, "0;.45;.55;.85;.95"); I.box(hot, 3.3, 2.5, 1.26, 1.2, 0.8, 0.02, { top: "face-red", l: "face-red", r: "face-red" });
    I.box(g, 2.8, 1.5, 3.6, 2.4, 0.2, 0.2); I.box(g, 2.8, 4.1, 3.6, 2.4, 0.2, 0.2); // frame bars
    I.box(g, 2.7, 1.5, 0.06, 0.3, 0.3, 3.8); I.box(g, 2.7, 4.1, 0.06, 0.3, 0.3, 3.8);
    I.box(g, 5.2, 1.5, 0.06, 0.3, 0.3, 3.8); I.box(g, 5.2, 4.1, 0.06, 0.3, 0.3, 3.8);
    I.box(g, 2.7, 1.5, 3.8, 3.0, 2.9, 0.2);
    const ram = I.g(); I.move(ram, [[0, 0, 0], [0, 0, 0], [0, 0, -1.9], [0, 0, -1.9], [0, 0, 0]], 6, "0;.1;.5;.85;.95");
    I.box(ram, 3.9, 2.5, 2.6, 0.5, 0.5, 1.2, I.dark); I.box(ram, 3.5, 2.3, 2.3, 1.3, 0.9, 0.3);
  } },
];
