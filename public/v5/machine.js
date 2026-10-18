// Illustrative 3-axis CNC mill, real 3D (three.js r183, vendored in ./vendor).
// Structure follows the Machine Skill pattern (AirsupHQ/machine-skill, MIT):
// studio set + PBR materials + named parts with explode vectors + a small
// kinematic "solver" that drives the axes from one toolpath.
// This is an illustration of a generic mill, not a provider's machine.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const host = document.getElementById('viewport');
const canvas = document.getElementById('gl');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
if (!renderer.getContext()) throw new Error('no webgl');
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;

const BG = 0x23211e;
const scene = new THREE.Scene();
scene.background = new THREE.Color(BG);
scene.fog = new THREE.Fog(BG, 6, 13);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.6;

const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 40);
camera.position.set(2.15, 1.7, 2.95);
const HOME_TARGET = new THREE.Vector3(0, 0.78, 0);
const HOME_POS = camera.position.clone();

const controls = new OrbitControls(camera, canvas);
controls.target.copy(HOME_TARGET);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.enableZoom = false; // keep page scroll free; Explode widens the shot
controls.minPolarAngle = 0.25;
controls.maxPolarAngle = Math.PI / 2 - 0.03;
controls.rotateSpeed = 0.7;
canvas.style.touchAction = 'pan-y'; // vertical swipes still scroll the page
canvas.tabIndex = 0;
controls.listenToKeyEvents(canvas);
controls.update();

// ---------- lights ----------
scene.add(new THREE.HemisphereLight(0xdfe6ea, 0x2a2824, 0.5));
const key = new THREE.DirectionalLight(0xfff3e4, 2.1);
key.position.set(2.4, 4.2, 3.2);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -2.2, right: 2.2, top: 2.2, bottom: -2.2, near: 1, far: 12 });
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
key.shadow.radius = 4;
scene.add(key);
const rim = new THREE.DirectionalLight(0xbfd2ff, 0.7);
rim.position.set(-3, 2.2, -3);
scene.add(rim);

// ---------- floor ----------
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(3.6, 96).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x2e2c28, roughness: 0.92, metalness: 0 })
);
floor.receiveShadow = true;
scene.add(floor);
const grid = new THREE.GridHelper(7, 28, 0x46423b, 0x38352f);
grid.position.y = 0.001;
grid.material.transparent = true;
grid.material.opacity = 0.7;
scene.add(grid);

// ---------- materials ----------
const M = {
  cast: new THREE.MeshStandardMaterial({ color: 0x4c4a46, roughness: 0.55, metalness: 0.5 }),
  paint: new THREE.MeshStandardMaterial({ color: 0xd8d5cd, roughness: 0.45, metalness: 0.15 }),
  paintDark: new THREE.MeshStandardMaterial({ color: 0x3a3936, roughness: 0.5, metalness: 0.3 }),
  steel: new THREE.MeshStandardMaterial({ color: 0xb4b8bb, roughness: 0.28, metalness: 1 }),
  steelDark: new THREE.MeshStandardMaterial({ color: 0x6d7073, roughness: 0.4, metalness: 1 }),
  ground: new THREE.MeshStandardMaterial({ color: 0xc9cdd0, roughness: 0.2, metalness: 1 }),
  carbide: new THREE.MeshStandardMaterial({ color: 0x8e9498, roughness: 0.25, metalness: 1 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xb59a4e, roughness: 0.3, metalness: 1 }),
  accent: new THREE.MeshStandardMaterial({ color: 0xc2410c, roughness: 0.45, metalness: 0.1 }),
  anod: new THREE.MeshStandardMaterial({ color: 0xd4d8db, roughness: 0.34, metalness: 0.95 }),
  slot: new THREE.MeshStandardMaterial({ color: 0x1b1a18, roughness: 0.8, metalness: 0.3 }),
  glass: new THREE.MeshStandardMaterial({
    color: 0x9fb4ba, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.13,
    depthWrite: false, side: THREE.DoubleSide,
  }),
};

// ---------- part registry (explode + axis following) ----------
const root = new THREE.Group();
scene.add(root);
const items = [];
function add(obj, { pos = [0, 0, 0], ex = [0, 0, 0], follow = null, parent = root, name = '' } = {}) {
  obj.position.set(...pos);
  obj.name = name;
  parent.add(obj);
  items.push({ obj, base: obj.position.clone(), ex: new THREE.Vector3(...ex), follow });
  return obj;
}
function box(w, h, d, mat, r = 0.008, seg = 3) {
  const m = new THREE.Mesh(r > 0 ? new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2.1, h / 2.1, d / 2.1)) : new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
function cyl(rt, rb, h, mat, seg = 40) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
function put(group, m, x, y, z, rx = 0, ry = 0, rz = 0) {
  m.position.set(x, y, z); m.rotation.set(rx, ry, rz); group.add(m); return m;
}

const path = {}; // toolpath state: segs, cutSegs, total, ribbon buffers

// ---------- key heights (metres) ----------
const BASE_H = 0.3, TOP = 0.59, SAFE = 0.08, DEPTH = 0.028;
const TIP0 = TOP + SAFE; // tool tip at safe height

// base casting + ways
{
  const g = new THREE.Group();
  put(g, box(1.2, BASE_H, 1.3, M.cast, 0.02), 0, BASE_H / 2, -0.01);
  for (const x of [-0.28, 0.28]) put(g, box(0.05, 0.03, 1.1, M.steel, 0.004), x, BASE_H + 0.015, 0.02);
  for (const x of [-0.5, 0.5]) for (const z of [-0.55, 0.5]) put(g, cyl(0.04, 0.045, 0.02, M.paintDark, 24), x, 0.01, z);
  // chip tray
  put(g, box(0.9, 0.012, 0.3, M.paintDark, 0.003), 0, BASE_H + 0.006, 0.42);
  add(g, { name: 'Base casting' });
}
// column + head rails
{
  const g = new THREE.Group();
  put(g, box(0.52, 1.25, 0.28, M.paint, 0.02), 0, 0.625, 0);
  for (const x of [-0.11, 0.11]) put(g, box(0.035, 1.0, 0.02, M.steel, 0.003), x, 0.76, 0.14);
  put(g, box(0.5, 0.03, 0.3, M.paintDark, 0.006), 0, 1.26, 0);
  add(g, { pos: [0, BASE_H, -0.52], ex: [0, 0, -0.55], name: 'Column' });
}

// saddle (Y)
{
  const g = new THREE.Group();
  put(g, box(0.72, 0.1, 0.5, M.cast, 0.012), 0, 0, 0);
  for (const z of [-0.12, 0.12]) put(g, box(0.76, 0.02, 0.045, M.steel, 0.003), 0, 0.06, z);
  add(g, { pos: [0, 0.39, 0], ex: [0, 0.11, 0], follow: 'saddle', name: 'Saddle (Y)' });
}
// table (X) with T-slots
{
  const g = new THREE.Group();
  put(g, box(0.96, 0.07, 0.38, M.steelDark, 0.006), 0, 0, 0);
  for (const z of [-0.12, -0.06, 0, 0.06, 0.12]) put(g, box(0.96, 0.004, 0.012, M.slot, 0), 0, 0.036, z);
  add(g, { pos: [0, 0.495, 0], ex: [0, 0.22, 0], follow: 'table', name: 'Table (X)' });
}

// fixture + workpiece (FLT-BRACKET-01) + stock outline + toolpath ribbon
const PX = 0.15, PZ = 0.09, PR = 0.025, PT = 0.03; // half-width, half-depth, corner radius, thickness
const HOLES = [[-0.12, -0.055], [0.12, -0.055], [-0.12, 0.055], [0.12, 0.055]];
const HOLE_R = 0.016, SLOT_HX = 0.05, SLOT_HZ = 0.02;
const TOOL_R = 0.012;
let pathMesh;
{
  const g = new THREE.Group();
  const FIX_TOP = TOP - PT;
  put(g, box(0.5, 0.03, 0.3, M.cast, 0.004), 0, FIX_TOP - 0.015, 0);
  for (const x of [-0.215, 0.215]) {
    put(g, box(0.05, 0.03, 0.2, M.steelDark, 0.004), x, FIX_TOP + 0.015, 0);
    put(g, cyl(0.011, 0.011, 0.02, M.steel, 20), x, FIX_TOP + 0.04, 0.06);
    put(g, cyl(0.011, 0.011, 0.02, M.steel, 20), x, FIX_TOP + 0.04, -0.06);
  }
  // bracket plate
  const s = new THREE.Shape();
  const rr = (hx, hz, r) => {
    const sh = new THREE.Path();
    sh.moveTo(-hx + r, -hz); sh.lineTo(hx - r, -hz); sh.absarc(hx - r, -hz + r, r, -Math.PI / 2, 0, false);
    sh.lineTo(hx, hz - r); sh.absarc(hx - r, hz - r, r, 0, Math.PI / 2, false);
    sh.lineTo(-hx + r, hz); sh.absarc(-hx + r, hz - r, r, Math.PI / 2, Math.PI, false);
    sh.lineTo(-hx, -hz + r); sh.absarc(-hx + r, -hz + r, r, Math.PI, 1.5 * Math.PI, false);
    return sh;
  };
  s.setFromPoints(rr(PX, PZ, PR).getPoints(8));
  for (const [x, z] of HOLES) { const h = new THREE.Path(); h.absarc(x, z, HOLE_R, 0, Math.PI * 2, true); s.holes.push(h); }
  const slot = rr(SLOT_HX, SLOT_HZ, SLOT_HZ - 0.001); slot.setFromPoints(slot.getPoints(8).reverse()); s.holes.push(slot);
  const geo = new THREE.ExtrudeGeometry(s, { depth: PT, bevelEnabled: true, bevelSize: 0.0012, bevelThickness: 0.0012, bevelSegments: 1, curveSegments: 18 });
  geo.rotateX(-Math.PI / 2); // shape y -> -z (symmetric), extrusion -> +y
  const plate = new THREE.Mesh(geo, M.anod);
  plate.castShadow = true; plate.receiveShadow = true;
  put(g, plate, 0, FIX_TOP, 0);
  // stock outline (raw billet) as hairline
  const stock = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(2 * PX + 0.05, PT, 2 * PZ + 0.05)),
    new THREE.LineBasicMaterial({ color: 0xe8e2d4, transparent: true, opacity: 0.35 })
  );
  put(g, stock, 0, FIX_TOP + PT / 2, 0);
  add(g, { ex: [0, 0.38, 0], follow: 'table', name: 'Fixture + FLT-BRACKET-01' });

  // ---- toolpath (part-local u,v ; absolute y) ----
  const roundedPts = (hx, hz, r, n = 7) => {
    const pts = [];
    const cs = [[1, 1, 0], [-1, 1, 90], [-1, -1, 180], [1, -1, 270]];
    for (const [sx, sz, a0] of cs) for (let i = 0; i <= n; i++) {
      const a = ((a0 + (90 * i) / n) * Math.PI) / 180;
      pts.push([sx * (hx - r) + r * Math.cos(a), sz * (hz - r) + r * Math.sin(a)]);
    }
    pts.push(pts[0]);
    return pts;
  };
  const wp = []; // {u,v,y,mode}
  const go = (u, v, y, mode) => wp.push({ u, v, y, mode });
  const Y_SAFE = TIP0, Y_CUT = TOP - DEPTH, Y_SURF = TOP;
  go(0.2, -0.14, Y_SAFE, 'rapid');
  // 1. outer profile
  const outer = roundedPts(PX + TOOL_R, PZ + TOOL_R, PR + TOOL_R);
  go(outer[0][0], outer[0][1], Y_SAFE, 'rapid'); go(outer[0][0], outer[0][1], Y_CUT, 'plunge');
  for (const p of outer.slice(1)) go(p[0], p[1], Y_CUT, 'cut');
  go(outer[0][0], outer[0][1], Y_SAFE, 'rapid');
  // 2. holes (helical entry shown as a small circle)
  for (const [hx, hz] of HOLES) {
    const r = HOLE_R - TOOL_R + 0.004;
    go(hx + r, hz, Y_SAFE, 'rapid'); go(hx + r, hz, Y_CUT, 'plunge');
    for (let i = 1; i <= 16; i++) { const a = (i / 16) * Math.PI * 2; go(hx + r * Math.cos(a), hz + r * Math.sin(a), Y_CUT, 'cut'); }
    go(hx + r, hz, Y_SAFE, 'rapid');
  }
  // 3. lightening slot
  const sl = roundedPts(SLOT_HX - TOOL_R, 0.0035, 0.0035, 2);
  go(sl[0][0], sl[0][1], Y_SAFE, 'rapid'); go(sl[0][0], sl[0][1], Y_CUT, 'plunge');
  for (const p of sl.slice(1)) go(p[0], p[1], Y_CUT, 'cut');
  go(sl[0][0], sl[0][1], Y_SAFE, 'rapid');
  go(0.2, -0.14, Y_SAFE, 'rapid');

  // segment table
  const V = { rapid: 0.55, plunge: 0.2, cut: 0.2 };
  const segs = [];
  let tt = 0;
  for (let i = 1; i < wp.length; i++) {
    const a = wp[i - 1], b = wp[i];
    const len = Math.hypot(b.u - a.u, b.v - a.v, b.y - a.y) || 1e-6;
    const dur = len / V[b.mode];
    segs.push({ a, b, t0: tt, t1: tt + dur, mode: b.mode });
    tt += dur;
  }
  const HOLD = 1.2;
  path.total = tt + HOLD; path.segs = segs; path.cutSegs = segs.filter((s) => s.mode === 'cut');

  // ribbon geometry for cut segments
  const cs = path.cutSegs, N = cs.length;
  const pos = new Float32Array(N * 4 * 3), idx = new Uint32Array(N * 6);
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  cs.forEach((_, i) => { const o = i * 4; idx.set([o, o + 1, o + 2, o + 2, o + 1, o + 3], i * 6); });
  pg.setIndex(new THREE.BufferAttribute(idx, 1));
  pathMesh = new THREE.Mesh(pg, new THREE.MeshBasicMaterial({ color: 0xc2410c, toneMapped: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  pathMesh.frustumCulled = false;
  g.add(pathMesh);
  path.pos = pos; path.geo = pg;
  path.setSeg = (i, u1, v1) => {
    const s = cs[i], a = s.a;
    const dx = u1 - a.u, dz = v1 - a.v, l = Math.hypot(dx, dz) || 1, nx = (-dz / l) * 0.0022, nz = (dx / l) * 0.0022;
    const y = TOP + PT * 0 + 0.0012;
    pos.set([a.u + nx, y, a.v + nz, a.u - nx, y, a.v - nz, u1 + nx, y, v1 + nz, u1 - nx, y, v1 - nz], i * 12);
  };
  cs.forEach((s, i) => path.setSeg(i, s.b.u, s.b.v));
  pg.setDrawRange(0, 0);
}

// ---------- head assembly ----------
{
  const g = new THREE.Group(); // head casting + motor
  put(g, box(0.34, 0.4, 0.48, M.paint, 0.02), 0, 0.455, -0.13);
  put(g, box(0.342, 0.045, 0.012, M.accent, 0.002), 0, 0.57, 0.113);
  put(g, cyl(0.085, 0.085, 0.2, M.paintDark, 48), 0, 0.755, -0.13);
  put(g, cyl(0.06, 0.06, 0.03, M.steelDark, 36), 0, 0.87, -0.13);
  // coolant nozzle
  const noz = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.006, 8, 24, Math.PI * 0.6), M.steelDark);
  noz.castShadow = true;
  put(g, noz, 0.0, 0.3, 0.0, 0, 0, 0);
  noz.position.set(0.1, 0.27, 0.0); noz.rotation.set(Math.PI / 2, 0, Math.PI * 0.5);
  add(g, { pos: [0, TIP0, 0], ex: [0, 1.05, 0], follow: 'head', name: 'Spindle head' });

  const nose = new THREE.Group();
  put(nose, cyl(0.065, 0.07, 0.1, M.steel, 40), 0, 0.21, 0);
  put(nose, cyl(0.075, 0.075, 0.012, M.steelDark, 40), 0, 0.262, 0);
  add(nose, { pos: [0, TIP0, 0], ex: [0, 0.85, 0], follow: 'head', name: 'Spindle nose' });

  const hold = new THREE.Group();
  put(hold, cyl(0.055, 0.055, 0.012, M.steelDark, 36), 0, 0.16, 0);
  put(hold, cyl(0.04, 0.026, 0.07, M.steelDark, 36), 0, 0.117, 0);
  put(hold, cyl(0.03, 0.024, 0.04, M.ground, 32), 0, 0.075, 0);
  add(hold, { pos: [0, TIP0, 0], ex: [0, 0.65, 0], follow: 'head', name: 'Tool holder' });

  const tool = new THREE.Group();
  const spin = new THREE.Group();
  put(spin, cyl(TOOL_R, TOOL_R, 0.07, M.ground, 28), 0, 0.045, 0);
  put(spin, cyl(TOOL_R, TOOL_R, 0.035, M.gold, 28), 0, 0.0175, 0);
  for (const a of [0, Math.PI / 2]) put(spin, box(0.0045, 0.034, 0.0265, M.slot, 0), 0, 0.0175, 0, 0, a + 0.5, 0);
  tool.add(spin);
  tool.userData.spin = spin;
  add(tool, { pos: [0, TIP0, 0], ex: [0, 0.45, 0], follow: 'head', name: 'Endmill' });
  tool.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  var toolSpin = spin;
}

// ---------- enclosure (front door cut away / swung open) ----------
const encl = new THREE.Group();
scene.add(encl);
const EX = 0.78, ZB = -0.78, ZF = 0.76, H = 1.78, KICK = 0.38, RAIL = 0.04;
const eW = 2 * EX, eD = ZF - ZB, zC = (ZF + ZB) / 2;
function glass(w, h, ry = 0, rx = 0) { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), M.glass); m.rotation.set(rx, ry, 0); m.renderOrder = 2; return m; }
function bar(w, h, d) { return box(w, h, d, M.paintDark, 0.004, 2); }
// posts
for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
  const g = new THREE.Group();
  put(g, bar(RAIL, H, RAIL), 0, H / 2, 0);
  add(g, { pos: [sx * EX, 0, sz > 0 ? ZF : ZB], ex: [sx * 0.35, 0, sz * 0.35], parent: encl, name: 'Enclosure post' });
}
// roof
{
  const g = new THREE.Group();
  put(g, bar(eW, RAIL, RAIL), 0, 0, ZB); put(g, bar(eW, RAIL, RAIL), 0, 0, ZF);
  put(g, bar(RAIL, RAIL, eD), -EX, 0, zC); put(g, bar(RAIL, RAIL, eD), EX, 0, zC);
  put(g, glass(eW - 0.04, eD - 0.04, 0, -Math.PI / 2), 0, 0, zC);
  add(g, { pos: [0, H, 0], ex: [0, 0.7, 0], parent: encl, name: 'Roof' });
}
// back panel
{
  const g = new THREE.Group();
  put(g, box(eW, H - 0.08, 0.025, M.paint, 0.006), 0, (H - 0.08) / 2 + 0.01, 0);
  add(g, { pos: [0, 0, ZB], ex: [0, 0, -0.7], parent: encl, name: 'Back panel' });
}
// side panels
for (const sx of [-1, 1]) {
  const g = new THREE.Group();
  put(g, box(0.025, KICK, eD, M.paint, 0.005), 0, KICK / 2, zC);
  put(g, bar(RAIL * 0.8, RAIL * 0.8, eD), 0, KICK + 0.01, zC);
  put(g, glass(eD - 0.05, H - KICK - 0.05, Math.PI / 2), 0, (H + KICK) / 2, zC);
  add(g, { pos: [sx * EX, 0, 0], ex: [sx * 0.8, 0, 0], parent: encl, name: 'Side window panel' });
}
// front: kick panel, header, fixed glass on left
{
  const g = new THREE.Group();
  put(g, box(eW, KICK, 0.025, M.paint, 0.005), 0, KICK / 2, 0);
  put(g, box(eW, 0.16, 0.03, M.paint, 0.006), 0, H - 0.08, 0);
  put(g, box(0.34, 0.03, 0.004, M.accent, 0), -EX + 0.3, H - 0.08, 0.017);
  add(g, { pos: [0, 0, ZF], ex: [0, 0, 0.7], parent: encl, name: 'Front kick + header' });
  const f = new THREE.Group();
  put(f, bar(RAIL * 0.8, H - KICK - 0.16, RAIL * 0.8), -EX + 0.01, (H + KICK - 0.16) / 2, 0);
  put(f, bar(RAIL * 0.8, H - KICK - 0.16, RAIL * 0.8), 0, (H + KICK - 0.16) / 2, 0);
  put(f, bar(EX, RAIL * 0.8, RAIL * 0.8), EX / 2, KICK + 0.01, 0);
  put(f, glass(EX - 0.05, H - KICK - 0.2), EX / 2, (H + KICK - 0.16) / 2, 0);
  add(f, { pos: [0, 0, ZF], ex: [0.2, 0, 0.9], parent: encl, name: 'Front fixed window' });
}
// door (hinged left, swung open => cut away; opens away from the default camera)
{
  const dh = H - KICK - 0.16, dw = EX - 0.04;
  const door = new THREE.Group();
  put(door, bar(0.035, dh, 0.035), 0, dh / 2, 0); put(door, bar(0.035, dh, 0.035), dw, dh / 2, 0);
  put(door, bar(dw, 0.035, 0.035), dw / 2, 0, 0); put(door, bar(dw, 0.035, 0.035), dw / 2, dh, 0);
  put(door, glass(dw - 0.03, dh - 0.03), dw / 2, dh / 2, 0);
  put(door, cyl(0.012, 0.012, 0.26, M.steel, 16), dw - 0.05, dh / 2, 0.05);
  put(door, box(0.02, 0.02, 0.05, M.steel, 0.003), dw - 0.05, dh / 2 + 0.12, 0.03);
  put(door, box(0.02, 0.02, 0.05, M.steel, 0.003), dw - 0.05, dh / 2 - 0.12, 0.03);
  const pivot = new THREE.Group();
  pivot.add(door);
  pivot.rotation.y = -1.72;
  add(pivot, { pos: [-EX + 0.02, KICK + 0.01, ZF + 0.02], ex: [-0.45, 0, 0.7], parent: encl, name: 'Door (open)' });
}
encl.traverse((o) => { if (o.isMesh && o.material === M.glass) o.castShadow = false; });

// ---------- state ----------
const state = { explode: 0, explodeTarget: 0, labels: true, running: !reduced, t: reduced ? 3.2 : 0, spinA: 0, enclosure: true };
let prevE = 0;
const motion = { head: new THREE.Vector3(), table: new THREE.Vector3(), saddle: new THREE.Vector3() };
const readout = { x: 0, y: 0, z: 0, pct: 0 };

function evalPath(t) {
  const segs = path.segs;
  const tc = Math.min(t, path.total);
  let s = segs[segs.length - 1], u, v, y;
  if (tc >= segs[segs.length - 1].t1) { u = s.b.u; v = s.b.v; y = s.b.y; return { u, v, y, seg: segs.length }; }
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (segs[m].t1 < tc) lo = m + 1; else hi = m; }
  s = segs[lo];
  let k = (tc - s.t0) / (s.t1 - s.t0); if (s.mode !== 'cut') k = k * k * (3 - 2 * k); // ease rapids, constant feed on cuts
  u = s.a.u + (s.b.u - s.a.u) * k; v = s.a.v + (s.b.v - s.a.v) * k; y = s.a.y + (s.b.y - s.a.y) * k;
  return { u, v, y, seg: lo, k, s };
}

function applyPose(t) {
  const p = evalPath(t);
  const E = state.explode;
  motion.table.set(-p.u, 0, -p.v);
  motion.saddle.set(0, 0, -p.v);
  motion.head.set(0, (p.y - TIP0) * (1 - E), 0);
  // ribbon
  const cs = path.cutSegs;
  let done = 0;
  for (let i = 0; i < cs.length; i++) { if (cs[i].t1 <= t) done = i + 1; else break; }
  let draw = done;
  if (p.s && p.s.mode === 'cut' && done < cs.length && cs[done] === p.s) {
    path.setSeg(done, p.u, p.v); path.geo.attributes.position.needsUpdate = true; draw = done + 1;
  }
  if (t >= path.total - 0.01) draw = cs.length;
  path.geo.setDrawRange(0, draw * 6);
  if (draw > 0 && draw <= cs.length && p.s && p.s.mode !== 'cut') { /* full segs already set */ }
  for (const it of items) {
    it.obj.position.copy(it.base).addScaledVector(it.ex, E);
    if (it.follow) it.obj.position.add(motion[it.follow]);
  }
  readout.x = p.u * 1000; readout.y = p.v * 1000; readout.z = (p.y - TOP) * 1000;
  readout.pct = Math.min(1, t / (path.total - 1.2));
}
// reset ribbon to full-segment positions on each loop start
function resetRibbon() { path.cutSegs.forEach((s, i) => path.setSeg(i, s.b.u, s.b.v)); path.geo.attributes.position.needsUpdate = true; }

// ---------- labels ----------
const tagDefs = [
  { el: document.getElementById('tag-spindle'), get: () => toolPos() },
  { el: document.getElementById('tag-table'), get: () => itemWorld('Table (X)', [0.48, 0.04, 0.0]) },
  { el: document.getElementById('tag-part'), get: () => itemWorld('Fixture + FLT-BRACKET-01', [0.0, 0.1, 0.1]) },
];
const _v = new THREE.Vector3();
function itemWorld(name, off) { const it = items.find((i) => i.obj.name === name); return it.obj.getWorldPosition(_v).add(new THREE.Vector3(...off)); }
function toolPos() { const it = items.find((i) => i.obj.name === 'Endmill'); return it.obj.getWorldPosition(_v).add(new THREE.Vector3(0.12, 0.22, 0)); }
function placeTags() {
  const w = host.clientWidth, h = host.clientHeight;
  for (const t of tagDefs) {
    if (!t.el) continue;
    if (!state.labels) { t.el.hidden = true; continue; }
    const p = t.get().clone().project(camera);
    const x = (p.x * 0.5 + 0.5) * w, y = (-p.y * 0.5 + 0.5) * h;
    const off = p.z > 1 || x < 8 || x > w - 8 || y < 8 || y > h - 8;
    t.el.hidden = off;
    t.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }
}

// ---------- ui ----------
const $ = (id) => document.getElementById(id);
const btnEx = $('btn-explode'), btnPlay = $('btn-play'), btnEncl = $('btn-encl'), btnLab = $('btn-labels'), btnReset = $('btn-reset');
const roX = $('ro-x'), roY = $('ro-y'), roZ = $('ro-z'), roP = $('ro-p');
function setPressed(b, v) { b.setAttribute('aria-pressed', String(v)); }
btnEx.addEventListener('click', () => {
  state.explodeTarget = state.explodeTarget ? 0 : 1; setPressed(btnEx, !!state.explodeTarget);
  if (reduced) { state.explode = state.explodeTarget; zoomTo(state.explode); applyPose(state.t); requestRender(); }
});
btnEncl.addEventListener('click', () => { state.enclosure = !state.enclosure; encl.visible = state.enclosure; setPressed(btnEncl, state.enclosure); requestRender(); });
btnLab.addEventListener('click', () => { state.labels = !state.labels; setPressed(btnLab, state.labels); requestRender(); });
btnReset.addEventListener('click', () => { camera.position.copy(HOME_POS.clone().multiplyScalar(1)); controls.target.copy(HOME_TARGET); prevE = 0; zoomTo(state.explode, true); controls.update(); requestRender(); });
if (reduced) { btnPlay.disabled = true; btnPlay.textContent = 'Path: static pose'; setPressed(btnPlay, false); }
else btnPlay.addEventListener('click', () => { state.running = !state.running; setPressed(btnPlay, state.running); btnPlay.textContent = state.running ? 'Pause path' : 'Play path'; });

function zoomTo(E, fromHome = false) {
  // widen the shot as parts separate; preserves the user's orbit direction
  const ratioNew = 1 + 0.5 * E, ratioOld = fromHome ? 1 : 1 + 0.5 * prevE;
  const off = camera.position.clone().sub(controls.target).multiplyScalar(ratioNew / ratioOld);
  controls.target.y += (E - (fromHome ? 0 : prevE)) * 0.35;
  camera.position.copy(controls.target).add(off);
  prevE = E;
}

// ---------- loop ----------
let needs = true, visible = true, last = performance.now(), roT = 0;
function requestRender() { needs = true; if (!looping) loop(); }
let looping = false;
function resize() {
  const w = host.clientWidth, h = host.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // keep the whole machine in frame on narrow viewports
  camera.fov = Math.min(64, w / h < 1.25 ? 34 * 1.25 / (w / h) * 0.95 : 34);
  camera.updateProjectionMatrix();
  requestRender();
}
new ResizeObserver(resize).observe(host);
controls.addEventListener('change', requestRender);
new IntersectionObserver((e) => { visible = e[0].isIntersecting; if (visible) { last = performance.now(); requestRender(); } }, { threshold: 0 }).observe(host);
document.addEventListener('visibilitychange', () => { last = performance.now(); if (!document.hidden) requestRender(); });
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); document.documentElement.classList.add('no-webgl'); });

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  let animating = false;
  if (state.running && !reduced) {
    state.t += dt;
    if (state.t >= path.total) { state.t = 0; resetRibbon(); path.geo.setDrawRange(0, 0); }
    toolSpin.rotation.y += dt * 22;
    animating = true;
  }
  if (Math.abs(state.explode - state.explodeTarget) > 0.0005) {
    const k = reduced ? 1 : 1 - Math.exp(-dt * 4.5);
    state.explode += (state.explodeTarget - state.explode) * k;
    zoomTo(state.explode);
    animating = true;
  } else if (state.explode !== state.explodeTarget) { state.explode = state.explodeTarget; zoomTo(state.explode); animating = true; }
  if (animating || needs) applyPose(state.t);
  controls.update();
  placeTags();
  renderer.render(scene, camera);
  needs = false;
  roT += dt;
  if (roT > 0.1) { roT = 0; roX.textContent = fmt(readout.x); roY.textContent = fmt(readout.y); roZ.textContent = fmt(readout.z); roP.textContent = Math.round(readout.pct * 100) + '%'; }
  return animating;
}
const fmt = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1).padStart(5, '0');
function loop() {
  looping = true;
  requestAnimationFrame((now) => {
    if (!visible || document.hidden) { looping = false; return; }
    const anim = frame(now);
    if (anim || needs || controls.autoRotate || damping()) loop(); else looping = false;
  });
}
let lastCam = new THREE.Vector3();
function damping() { const moved = lastCam.distanceToSquared(camera.position) > 1e-10; lastCam.copy(camera.position); return moved; }

// initial
if (reduced) { applyPose(state.t); state.running = false; }
else { resetRibbon(); path.geo.setDrawRange(0, 0); applyPose(0); }
resize();
frame(performance.now());
requestRender();
document.documentElement.classList.add('gl-ready');
window.__machine = { renderer, scene, camera, controls, state, items };
