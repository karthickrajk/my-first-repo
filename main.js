/* DriveReady — driving school simulator. Plain script, uses the global THREE from vendor/three.min.js. */
'use strict';
(() => {
const T = THREE;
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------- constants
const S = 80;            // distance between intersections (m)
const G = 2;             // grid goes from -G..G in both axes
const W = 12;            // road width
const LANE = 3;          // lane centre offset from the road centre line
const HALF = G * S;
const WB = 2.6;          // wheelbase
const CW = 0.95, CL = 2.1; // car half width / half length
const LOT = { x0: 255, x1: 385, z0: -65, z1: 65 }; // training ground
const GEARS = ['P', 'R', 'N', 'D'];
const PASS_SCORE = 70, FAIL_SCORE = 40;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// ---------------------------------------------------------------- renderer
const renderer = new T.WebGLRenderer({ canvas: $('view'), antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = T.PCFSoftShadowMap;
const camera = new T.PerspectiveCamera(62, 1, 0.2, 900);
function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- state
let side = 1;            // 1 = traffic keeps right, -1 = keeps left
let scene, sun, nodes, colliders, drivable, ring, lessonGroup, playerMesh;
let traffic = [], cones = [], statics = [];
let state = 'menu';      // menu | run | pause | end
let lesson = null, steps = [], stepIdx = 0, startPose = null;
let score = 100, violations = {}, lastPen = {}, clock = 0;
let camMode = 0;         // 0 chase, 1 cockpit, 2 top
let wrongT = 0, curNode = null, entryTh = 0, entrySig = 0, activeBox = null;
const car = { x: 0, z: 0, th: 0, v: 0, steer: 0, gear: 'P', engine: false, belt: false, signal: 0 };
const keys = { gas: false, brake: false, left: false, right: false, hand: false };

// lane-side vector for a travel direction (points towards the kerb you drive next to)
const laneVec = d => [-d[1] * side, d[0] * side];
const nodeKey = (i, j) => i + ',' + j;

function rng(seed) { // deterministic so the city looks the same every time
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------- shared geometry / materials
const lam = (color, extra) => new T.MeshLambertMaterial(Object.assign({ color }, extra));
const basic = color => new T.MeshBasicMaterial({ color });
const GEO = {
  body: new T.BoxGeometry(1.9, 0.55, 4.2), cab: new T.BoxGeometry(1.66, 0.5, 2.1),
  wheel: new T.CylinderGeometry(0.33, 0.33, 0.24, 14), lamp: new T.BoxGeometry(0.34, 0.14, 0.06),
  blink: new T.BoxGeometry(0.2, 0.14, 0.08), cone: new T.ConeGeometry(0.24, 0.7, 12),
  coneBase: new T.BoxGeometry(0.5, 0.05, 0.5), pole: new T.CylinderGeometry(0.09, 0.09, 5.4, 8),
  housing: new T.BoxGeometry(0.46, 1.45, 0.34), bulb: new T.SphereGeometry(0.17, 12, 8),
  trunk: new T.CylinderGeometry(0.22, 0.3, 2.4, 7), leaves: new T.ConeGeometry(2, 5, 8),
};
const MAT = {
  glass: lam(0x1d2a36), tyre: lam(0x16171a), head: basic(0xfff6cf), dark: lam(0x24272c),
  cone: lam(0xff6a1a), white: basic(0xf2f2f2), pole: lam(0x3a3f47), trunk: lam(0x6b4a2b), leaves: lam(0x2f7d3b),
};

function flat(parent, w, h, mat, x, y, z, rotZ) {
  const m = new T.Mesh(new T.PlaneGeometry(w, h), mat);
  m.rotation.set(-Math.PI / 2, 0, rotZ || 0);
  m.position.set(x, y, z);
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

function roadTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#3b3e44'; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(255,255,255,${Math.random() * 0.05})`; g.fillRect(Math.random() * 128, Math.random() * 128, 2, 2); }
  g.fillStyle = '#e6e6e6'; g.fillRect(0, 4, 128, 2); g.fillRect(0, 122, 128, 2);
  g.fillStyle = '#f2c230'; g.fillRect(0, 62, 64, 3);
  const t = new T.CanvasTexture(c);
  t.wrapS = t.wrapT = T.RepeatWrapping; t.anisotropy = 8; t.colorSpace = T.SRGBColorSpace;
  return t;
}
function windowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#42556b'; g.fillRect(8, 12, 20, 34); g.fillRect(36, 12, 20, 34);
  const t = new T.CanvasTexture(c);
  t.wrapS = t.wrapT = T.RepeatWrapping; t.colorSpace = T.SRGBColorSpace;
  return t;
}
const ROAD_TEX = roadTexture(), WIN_TEX = windowTexture();

// ---------------------------------------------------------------- car model
function makeCar(color, isPlayer) {
  const g = new T.Group();
  const body = new T.Mesh(GEO.body, lam(color)); body.position.y = 0.62; body.castShadow = true;
  const cab = new T.Mesh(GEO.cab, MAT.glass); cab.position.set(0, 1.13, -0.2); cab.castShadow = true;
  g.add(body, cab);
  const fw = [];
  for (const sx of [1, -1]) for (const sz of [1, -1]) {
    const pivot = new T.Group(); pivot.position.set(sx * 0.9, 0.33, sz * 1.3);
    const w = new T.Mesh(GEO.wheel, MAT.tyre); w.rotation.z = Math.PI / 2;
    pivot.add(w); g.add(pivot);
    if (sz > 0) fw.push(pivot);
  }
  const brake = basic(0x550000), sigL = basic(0x553300), sigR = basic(0x553300);
  for (const sx of [1, -1]) {
    const h = new T.Mesh(GEO.lamp, MAT.head); h.position.set(sx * 0.5, 0.68, 2.11);
    const t = new T.Mesh(GEO.lamp, brake); t.position.set(sx * 0.5, 0.72, -2.11);
    const bf = new T.Mesh(GEO.blink, sx > 0 ? sigL : sigR); bf.position.set(sx * 0.85, 0.68, 2.1);
    const br = new T.Mesh(GEO.blink, sx > 0 ? sigL : sigR); br.position.set(sx * 0.85, 0.72, -2.1);
    g.add(h, t, bf, br);
  }
  g.userData = { brake, sigL, sigR, fw };
  if (isPlayer) { // interior bits that are only seen from the cockpit camera
    const dashb = new T.Mesh(new T.BoxGeometry(1.6, 0.22, 0.28), MAT.dark); dashb.position.set(0, 0.9, 0.72);
    const wheel = new T.Mesh(new T.TorusGeometry(0.15, 0.018, 8, 22), MAT.dark);
    wheel.position.set(side * 0.38, 0.93, 0.52); wheel.rotation.x = -0.35;
    g.add(dashb, wheel); g.userData.wheel = wheel;
  }
  return g;
}
function setCarLamps(mesh, braking, signal, blinkOn) {
  const u = mesh.userData;
  u.brake.color.setHex(braking ? 0xff1a1a : 0x550000);
  u.sigL.color.setHex(signal === 1 && blinkOn ? 0xffa200 : 0x553300);
  u.sigR.color.setHex(signal === -1 && blinkOn ? 0xffa200 : 0x553300);
}

// ---------------------------------------------------------------- world
function tree(x, z, s) {
  const t = new T.Mesh(GEO.trunk, MAT.trunk); t.position.set(x, 1.2, z);
  const l = new T.Mesh(GEO.leaves, MAT.leaves); l.position.set(x, 4.6, z); l.scale.setScalar(s || 1); l.castShadow = true;
  scene.add(t, l);
}

function buildWorld() {
  const rand = rng(1234);
  scene = new T.Scene();
  scene.background = new T.Color(0x9fd0ff);
  scene.fog = new T.Fog(0x9fd0ff, 140, 520);
  scene.add(new T.HemisphereLight(0xffffff, 0x5a6b4a, 1.25));
  sun = new T.DirectionalLight(0xfff3dd, 1.9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 300 });
  sun.shadow.bias = -0.0006;
  scene.add(sun, sun.target);

  flat(scene, 2400, 2400, lam(0x5d9a4e), 0, -0.03, 0);

  // roads
  drivable = [{ x0: LOT.x0, x1: LOT.x1, z0: LOT.z0, z1: LOT.z1 }];
  const len = 2 * HALF + W;
  for (let k = -G; k <= G; k++) {
    const tex = ROAD_TEX.clone(); tex.repeat.set(len / 12, 1);
    const mat = lam(0xffffff, { map: tex });
    flat(scene, len, W, mat, 0, 0.02, k * S);
    flat(scene, len, W, mat, k * S, 0.04, 0, Math.PI / 2);
    drivable.push({ x0: -len / 2, x1: len / 2, z0: k * S - W / 2, z1: k * S + W / 2 });
    drivable.push({ z0: -len / 2, z1: len / 2, x0: k * S - W / 2, x1: k * S + W / 2 });
  }

  // intersections, stop lines, traffic lights
  nodes = new Map();
  for (let i = -G; i <= G; i++) for (let j = -G; j <= G; j++)
    nodes.set(nodeKey(i, j), { i, j, x: i * S, z: j * S, nb: [], off: (((i * 7 + j * 11) % 26) + 26) % 26, mats: null });
  const asphalt = lam(0x3b3e44);
  for (const n of nodes.values()) {
    for (const d of DIRS) if (nodes.has(nodeKey(n.i + d[0], n.j + d[1]))) n.nb.push(d);
    n.lights = n.nb.length >= 3;
    flat(scene, W, W, asphalt, n.x, 0.06, n.z);
    if (!n.lights) continue;
    const mk = () => [basic(0x330000), basic(0x332200), basic(0x003300)];
    n.mats = { x: mk(), z: mk() };
    for (const d of n.nb) {            // d points from the node to the neighbour the traffic arrives from
      const t = [-d[0], -d[1]], l = laneVec(t), axis = t[0] !== 0 ? 'x' : 'z';
      flat(scene, W / 2 - 0.5, 0.5, MAT.white, n.x + d[0] * (W / 2 + 0.7) + l[0] * W / 4, 0.08,
        n.z + d[1] * (W / 2 + 0.7) + l[1] * W / 4, axis === 'x' ? Math.PI / 2 : 0);
      // signal head on the far side of the junction, facing the approaching driver
      const px = n.x - d[0] * (W / 2 + 1.4) + l[0] * (W / 2 + 1.3), pz = n.z - d[1] * (W / 2 + 1.4) + l[1] * (W / 2 + 1.3);
      const grp = new T.Group(); grp.position.set(px, 0, pz); grp.rotation.y = Math.atan2(d[0], d[1]);
      const pole = new T.Mesh(GEO.pole, MAT.pole); pole.position.y = 2.7;
      const box = new T.Mesh(GEO.housing, MAT.dark); box.position.y = 4.7;
      grp.add(pole, box);
      [5.15, 4.7, 4.25].forEach((y, k) => { const b = new T.Mesh(GEO.bulb, n.mats[axis][k]); b.position.set(0, y, 0.16); grp.add(b); });
      scene.add(grp);
    }
  }

  // city blocks
  colliders = [];
  const pave = lam(0xb9b9b1), roof = lam(0x555a61);
  const tints = [0xd9cbb3, 0xc4d0d8, 0xe2d6c8, 0xb7b0a6, 0xcfc0b0, 0xa9b9c4, 0xd6b9a0, 0xc9c9c9];
  for (let bi = -G; bi < G; bi++) for (let bj = -G; bj < G; bj++) {
    const cx = (bi + 0.5) * S, cz = (bj + 0.5) * S;
    const slab = new T.Mesh(new T.BoxGeometry(S - W, 0.14, S - W), pave);
    slab.position.set(cx, 0.07, cz); slab.receiveShadow = true; scene.add(slab);
    if ((bi === 0 && bj === -1) || (bi === -2 && bj === 1)) { // park
      flat(scene, S - W - 8, S - W - 8, lam(0x4f9a4a), cx, 0.16, cz);
      for (let k = 0; k < 14; k++) tree(cx + (rand() - 0.5) * 52, cz + (rand() - 0.5) * 52, 0.8 + rand() * 0.6);
      continue;
    }
    for (const u of [-1, 1]) for (const v of [-1, 1]) {
      const w = 14 + rand() * 10, d = 14 + rand() * 10, h = 8 + rand() * rand() * 42;
      const tex = WIN_TEX.clone(); tex.repeat.set(Math.round(w / 5), Math.round(h / 3.5));
      const wall = lam(tints[Math.floor(rand() * tints.length)], { map: tex });
      const b = new T.Mesh(new T.BoxGeometry(w, h, d), [wall, wall, roof, roof, wall, wall]);
      const x = cx + u * 15.5, z = cz + v * 15.5;
      b.position.set(x, h / 2 + 0.14, z); b.castShadow = true; b.receiveShadow = true; scene.add(b);
      colliders.push({ x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2 });
    }
  }

  // training ground
  const lx = (LOT.x0 + LOT.x1) / 2, lz = (LOT.z0 + LOT.z1) / 2, lw = LOT.x1 - LOT.x0, ld = LOT.z1 - LOT.z0;
  flat(scene, lw, ld, lam(0x4a4d53), lx, 0.02, lz);
  for (const [w, h, x, z] of [[lw, 0.3, lx, LOT.z0 + 0.5], [lw, 0.3, lx, LOT.z1 - 0.5], [0.3, ld, LOT.x0 + 0.5, lz], [0.3, ld, LOT.x1 - 0.5, lz]])
    flat(scene, w, h, MAT.white, x, 0.05, z);
  for (let k = 0; k < 9; k++) { tree(LOT.x0 - 5, LOT.z0 + k * 16, 1); tree(LOT.x1 + 5, LOT.z0 + k * 16, 1); tree(LOT.x0 + k * 16, LOT.z1 + 5, 1); }

  // checkpoint marker
  ring = new T.Group();
  const rm = new T.MeshBasicMaterial({ color: 0xffc530, transparent: true, opacity: 0.45, side: T.DoubleSide, depthWrite: false });
  const disc = new T.Mesh(new T.CylinderGeometry(1, 1, 1.2, 28, 1, true), rm); disc.position.y = 0.6;
  const beam = new T.Mesh(new T.CylinderGeometry(0.12, 0.12, 40, 8), rm); beam.position.y = 20;
  ring.add(disc, beam); ring.visible = false; scene.add(ring);

  lessonGroup = new T.Group(); scene.add(lessonGroup);
  playerMesh = makeCar(0xd32f2f, true); scene.add(playerMesh);
  spawnTraffic(16);
}

function lightState(n, axis) {
  const p = (clock + n.off) % 26;
  if (axis === 'x') return p < 10 ? 'g' : p < 12 ? 'y' : 'r';
  return p < 13 ? 'r' : p < 23 ? 'g' : p < 25 ? 'y' : 'r';
}
function updateLights() {
  for (const n of nodes.values()) {
    if (!n.lights) continue;
    for (const axis of ['x', 'z']) {
      const s = lightState(n, axis), m = n.mats[axis];
      m[0].color.setHex(s === 'r' ? 0xff2a1f : 0x330000);
      m[1].color.setHex(s === 'y' ? 0xffc21a : 0x332200);
      m[2].color.setHex(s === 'g' ? 0x2dff6a : 0x003300);
    }
  }
}

// ---------------------------------------------------------------- AI traffic
const nodeAt = (n, d) => nodes.get(nodeKey(n.i + d[0], n.j + d[1]));
function pickNext(a, b) {
  const d = [b.i - a.i, b.j - a.j];
  const opts = b.nb.filter(o => !(o[0] === -d[0] && o[1] === -d[1]));
  return nodeAt(b, opts[Math.floor(Math.random() * opts.length)]);
}
function setSegment(c, a, b) {
  c.a = a; c.b = b; c.d = [b.i - a.i, b.j - a.j]; c.l = laneVec(c.d);
  c.next = pickNext(a, b);
  const d2 = [c.next.i - b.i, c.next.j - b.j];
  const cross = c.d[0] * d2[1] - c.d[1] * d2[0];
  c.turn = cross < 0 ? 1 : cross > 0 ? -1 : 0;   // 1 = left, -1 = right
  c.mode = 'seg'; c.s = 0;
}
function aiPose(c) {
  if (c.mode === 'seg') {
    const o = W / 2 + c.s;
    c.x = c.a.x + c.d[0] * o + c.l[0] * LANE; c.z = c.a.z + c.d[1] * o + c.l[1] * LANE;
    c.th = Math.atan2(c.d[0], c.d[1]);
  } else {
    const t = c.t, u = 1 - t, [p0, p1, p2] = c.curve;
    c.x = u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0];
    c.z = u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1];
    c.th = Math.atan2(u * (p1[0] - p0[0]) + t * (p2[0] - p1[0]), u * (p1[1] - p0[1]) + t * (p2[1] - p1[1]));
  }
}
function spawnTraffic(count) {
  for (const c of traffic) scene.remove(c.mesh);
  traffic = [];
  const all = [...nodes.values()];
  const colors = [0x2f6fd3, 0xf0f0f0, 0x2b2f36, 0x9aa3ad, 0x2e9c5a, 0xe0a422, 0x7b4bc4, 0xc9d2da];
  let guard = 0;
  while (traffic.length < count && guard++ < 500) {
    const a = all[Math.floor(Math.random() * all.length)];
    const b = nodeAt(a, a.nb[Math.floor(Math.random() * a.nb.length)]);
    const c = { v: 0, cruise: 9 + Math.random() * 3.5, blocked: 0, ghost: 0, hold: 0 };
    setSegment(c, a, b); c.s = Math.random() * (S - W - 6); aiPose(c);
    if (startPose && Math.hypot(c.x - startPose.x, c.z - startPose.z) < 45) continue;
    if (traffic.some(o => Math.hypot(o.x - c.x, o.z - c.z) < 14)) continue;
    c.mesh = makeCar(colors[traffic.length % colors.length]); scene.add(c.mesh);
    traffic.push(c);
  }
}
function updateTraffic(dt, blinkOn) {
  const segLen = S - W, stopS = segLen - 3.2;
  for (const c of traffic) {
    let vmax = c.cruise, braking = false;
    if (c.hold > 0) { c.hold -= dt; vmax = 0; }
    if (c.mode === 'seg') {
      if (c.turn && c.s > segLen - 18) vmax = Math.min(vmax, 5);
      if (c.b.lights && c.s <= stopS + 1) {
        const st = lightState(c.b, c.d[0] !== 0 ? 'x' : 'z');
        const dist = stopS - c.s;
        if (st === 'r' || (st === 'y' && !(dist < 7 && c.v > 4))) vmax = Math.min(vmax, Math.sqrt(2 * 3 * Math.max(0, dist)));
      }
    } else if (c.turn) vmax = Math.min(vmax, 5);
    // keep distance to whatever is ahead
    const fx = Math.sin(c.th), fz = Math.cos(c.th);
    let blockedByAI = false;
    const look = 7 + c.v * 1.5;
    const check = (o, isAI) => {
      const rx = o.x - c.x, rz = o.z - c.z, lz = rx * fx + rz * fz, lx = rx * fz - rz * fx;
      if (lz > 0.5 && lz < look && Math.abs(lx) < 2) {
        if (isAI && c.ghost > 0) return;
        vmax = Math.min(vmax, Math.sqrt(2 * 3 * Math.max(0, lz - 5.4)));
        if (isAI) blockedByAI = true;
      }
    };
    for (const o of traffic) if (o !== c) check(o, true);
    check(car, false);
    if (blockedByAI && c.v < 0.2) { c.blocked += dt; if (c.blocked > 8) { c.ghost = 4; c.blocked = 0; } } else c.blocked = 0;
    if (c.ghost > 0) c.ghost -= dt;

    if (c.v < vmax) c.v = Math.min(vmax, c.v + 2.4 * dt);
    else { braking = c.v > vmax + 0.3; c.v = Math.max(vmax, c.v - 6.5 * dt); }

    if (c.mode === 'seg') {
      c.s += c.v * dt;
      if (c.s >= segLen) {
        const b = c.b, d = c.d, l = c.l, d2 = [c.next.i - b.i, c.next.j - b.j], l2 = laneVec(d2);
        const p0 = [b.x - d[0] * W / 2 + l[0] * LANE, b.z - d[1] * W / 2 + l[1] * LANE];
        const p2 = [b.x + d2[0] * W / 2 + l2[0] * LANE, b.z + d2[1] * W / 2 + l2[1] * LANE];
        const p1 = c.turn ? [b.x + (l[0] + l2[0]) * LANE, b.z + (l[1] + l2[1]) * LANE] : [(p0[0] + p2[0]) / 2, (p0[1] + p2[1]) / 2];
        c.curve = [p0, p1, p2];
        c.curveLen = c.turn ? (Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1])) * 0.82 : W;
        c.mode = 'turn'; c.t = 0;
      }
    } else {
      c.t += c.v * dt / c.curveLen;
      if (c.t >= 1) setSegment(c, c.b, c.next);
    }
    aiPose(c);
    c.mesh.position.set(c.x, 0, c.z); c.mesh.rotation.y = c.th;
    const sig = c.turn && (c.mode === 'turn' || c.s > segLen - 30) ? c.turn : 0;
    setCarLamps(c.mesh, braking || c.v < 0.1, sig, blinkOn);
  }
}

// ---------------------------------------------------------------- geometry helpers
function obbOverlap(a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const ax = [[Math.sin(a.th), Math.cos(a.th)], [Math.cos(a.th), -Math.sin(a.th)], [Math.sin(b.th), Math.cos(b.th)], [Math.cos(b.th), -Math.sin(b.th)]];
  for (const n of ax) {
    const dot = (v) => Math.abs(v[0] * n[0] + v[1] * n[1]);
    const ra = CL * dot(ax[0]) + CW * dot(ax[1]), rb = CL * dot(ax[2]) + CW * dot(ax[3]);
    if (Math.abs(dx * n[0] + dz * n[1]) > ra + rb) return false;
  }
  return true;
}
const toLocal = (o, x, z) => { const rx = x - o.x, rz = z - o.z, s = Math.sin(o.th), c = Math.cos(o.th); return [rx * c - rz * s, rx * s + rz * c]; }; // [side, forward]
const isDrivable = (x, z) => drivable.some(r => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1);
const inLot = () => car.x > LOT.x0 - 5;
function carCorners() {
  const s = Math.sin(car.th), c = Math.cos(car.th), out = [];
  for (const a of [CW, -CW]) for (const b of [CL, -CL]) out.push([car.x + c * a + s * b, car.z - s * a + c * b]);
  return out;
}
function inBox(b) {
  return carCorners().every(([x, z]) => { const [lx, lz] = toLocal(b, x, z); return Math.abs(lx) <= b.hw && Math.abs(lz) <= b.hl; });
}

// ---------------------------------------------------------------- lesson objects
function addCone(x, z) {
  const g = new T.Group();
  const c = new T.Mesh(GEO.cone, MAT.cone); c.position.y = 0.4; c.castShadow = true;
  const b = new T.Mesh(GEO.coneBase, MAT.cone); b.position.y = 0.03;
  g.add(c, b); g.position.set(x, 0, z); lessonGroup.add(g);
  cones.push({ x, z, mesh: g, hit: false });
}
function addBox(b) { // painted target box, turns green while the car is fully inside
  const mat = new T.MeshBasicMaterial({ color: 0xffc530 });
  const fill = new T.MeshBasicMaterial({ color: 0xffc530, transparent: true, opacity: 0.18, depthWrite: false });
  const g = new T.Group(); g.position.set(b.x, 0.1, b.z); g.rotation.y = b.th;
  flat(g, b.hw * 2, b.hl * 2, fill, 0, 0, 0);
  for (const sgn of [1, -1]) { flat(g, 0.18, b.hl * 2, mat, sgn * b.hw, 0.01, 0); flat(g, b.hw * 2, 0.18, mat, 0, 0.01, sgn * b.hl); }
  lessonGroup.add(g);
  b.mats = [mat, fill];
  return b;
}
const cityStart = () => { const l = laneVec([1, 0]); return { x: -120 + l[0] * LANE, z: l[1] * LANE, th: Math.PI / 2 }; };

const LESSONS = [
  { id: 'basics', title: '1 · First steps', desc: 'Seatbelt, engine, gears, a slalom between cones and a controlled stop.', build() {
      const X = 275;
      [-25, -10, 5, 20].forEach(z => addCone(X, z));
      const box = addBox({ x: 340, z: 52, th: Math.PI / 2, hw: 2.3, hl: 4.2 });
      const gates = [[X + 4, -25], [X - 4, -10], [X + 4, 5], [X - 4, 20]];
      return { start: { x: X, z: -52, th: 0 }, steps: [
        { type: 'belt', text: 'Welcome! Before anything else, fasten your seatbelt — press B.' },
        { type: 'engine', text: 'Start the engine — press I.' },
        { type: 'gear', gear: 'D', text: 'Select Drive: press X to move the selector P → R → N → D.' },
        ...gates.map(([x, z], k) => ({ type: 'cp', x, z, r: 2.6, text: k ? 'Keep weaving — pass the next cone on the other side. Gentle steering, low speed.' : 'Accelerate gently (W) and slalom through the cones. Drive through each yellow marker.' })),
        { type: 'cp', x: X, z: 40, r: 3.5, text: 'Straighten up and continue to the marker.' },
        { type: 'cp', x: 305, z: 52, r: 3.5, text: 'Turn left towards the stopping box. Remember the 20 km/h limit.' },
        { type: 'stop', box, text: 'Stop completely inside the yellow box (S to brake).' },
        { type: 'gear', gear: 'P', text: 'Good stop! Now select Park — press Z until P is highlighted.' },
      ] };
    } },
  { id: 'parking', title: '2 · Parking', desc: 'Park in the free bay between two cars without touching anything. Try reversing in.', build() {
      const bz = 55, bx = k => 310 + (k - 3) * 3.2;
      const paint = ['#2f6fd3', '#f0f0f0', '#2b2f36', '#2e9c5a', '#e0a422', '#9aa3ad', '#7b4bc4'];
      for (let k = 0; k <= 7; k++) flat(lessonGroup, 0.14, 6.4, MAT.white, bx(k) - 1.6, 0.06, bz);
      for (let k = 0; k < 7; k++) {
        if (k === 3) continue;
        const o = { x: bx(k), z: bz + (k % 2 ? 0.2 : -0.2), th: k % 3 ? 0 : Math.PI };
        const m = makeCar(new T.Color(paint[k]).getHex()); m.position.set(o.x, 0, o.z); m.rotation.y = o.th;
        lessonGroup.add(m); statics.push(o);
      }
      const box = addBox({ x: bx(3), z: bz, th: 0, hw: 1.5, hl: 3.1 });
      return { start: { x: 275, z: -30, th: 0 }, steps: [
        { type: 'ready', text: 'Get ready: seatbelt (B), engine (I), select Drive (X).' },
        { type: 'cp', x: 310, z: 30, r: 5, text: 'Drive to the row of parked cars. Use the top camera (C) to see the bay.' },
        { type: 'stop', box, park: true, text: 'Park fully inside the free bay, stop, and select P. For reverse: stop, select R (Z), steer and back in slowly.' },
      ] };
    } },
  { id: 'city', title: '3 · City exam', desc: 'Follow the route through traffic: obey lights, keep your lane, signal every turn, max 50 km/h.', build() {
      const route = [[-2, 0], [-1, 0], [0, 0], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-2, 0]];
      const st = [{ type: 'ready', text: 'Exam start. Seatbelt (B), engine (I), Drive (X). Then pull away when it is safe.' }];
      for (let k = 1; k < route.length - 1; k++) {
        const a = route[k], b = route[k + 1], p = route[k - 1];
        const d = [b[0] - a[0], b[1] - a[1]], d0 = [a[0] - p[0], a[1] - p[1]], l = laneVec(d);
        const cross = d0[0] * d[1] - d0[1] * d[0];
        const text = cross < 0 ? 'At the next junction turn LEFT. Signal first (Q) and give way to oncoming traffic.'
          : cross > 0 ? 'At the next junction turn RIGHT. Signal first (E) and slow down for the corner.'
          : 'Go straight on at the junction. Stop if the light is red.';
        const mx = (a[0] + b[0]) / 2 * S + l[0] * LANE, mz = (a[1] + b[1]) / 2 * S + l[1] * LANE;
        if (k === route.length - 2) {
          const box = addBox({ x: mx + l[0] * 0.6, z: mz + l[1] * 0.6, th: Math.atan2(d[0], d[1]), hw: 2.2, hl: 5 });
          st.push({ type: 'stop', box, park: true, text: text + ' Then pull over in the yellow box, stop and select P.' });
        } else st.push({ type: 'cp', x: mx, z: mz, r: 4.5, text });
      }
      return { start: cityStart(), steps: st };
    } },
  { id: 'free', title: 'Free drive', desc: 'No route, no pass or fail — explore the city and practise. Mistakes are still called out.', build() {
      return { start: cityStart(), steps: [] };
    } },
];

// ---------------------------------------------------------------- game flow
function startLesson(l) {
  lesson = l;
  scene.remove(lessonGroup); lessonGroup = new T.Group(); scene.add(lessonGroup);
  cones = []; statics = [];
  const built = l.build();
  steps = built.steps; stepIdx = 0; startPose = built.start;
  Object.assign(car, built.start, { v: 0, steer: 0, gear: 'P', engine: false, belt: false, signal: 0 });
  score = 100; violations = {}; lastPen = {}; wrongT = 0; curNode = null; activeBox = null;
  spawnTraffic(16);
  camera.position.set(car.x - Math.sin(car.th) * 9, 5, car.z - Math.cos(car.th) * 9);
  $('toasts').innerHTML = '';
  for (const id of ['menu', 'pause', 'result']) $(id).hidden = true;
  $('hud').hidden = false;
  state = 'run';
  showStep();
  initAudio();
}
function showStep() {
  const s = steps[stepIdx];
  $('stepNum').textContent = steps.length ? `Step ${Math.min(stepIdx + 1, steps.length)} / ${steps.length}` : 'Free drive';
  $('stepText').textContent = s ? s.text : 'Drive wherever you like. Obey the lights, keep to your side of the road and signal your turns.';
  ring.visible = !!s && s.type === 'cp';
  if (ring.visible) { ring.position.set(s.x, 0, s.z); ring.children[0].scale.set(s.r, 1, s.r); }
  activeBox = s && s.type === 'stop' ? s.box : null;
}
function stepDone(s) {
  switch (s.type) {
    case 'belt': return car.belt;
    case 'engine': return car.engine;
    case 'gear': return car.gear === s.gear;
    case 'ready': return car.belt && car.engine && car.gear === 'D';
    case 'cp': return Math.hypot(car.x - s.x, car.z - s.z) < s.r;
    case 'stop': return inBox(s.box) && Math.abs(car.v) < 0.15 && (!s.park || car.gear === 'P');
  }
}
function finish(passed, why) {
  state = 'end';
  $('hud').hidden = true; $('result').hidden = false;
  $('resTitle').textContent = passed ? 'Lesson passed' : 'Lesson failed';
  $('resTitle').className = passed ? 'pass' : 'fail';
  $('resText').textContent = `${why} Final score: ${Math.max(0, score)} / 100 (pass mark ${PASS_SCORE}).`;
  const names = Object.keys(violations);
  $('resList').innerHTML = names.length ? '' : '<li><span>No mistakes — clean drive!</span></li>';
  for (const n of names) {
    const li = document.createElement('li');
    li.innerHTML = `<span></span><b>× ${violations[n].n} &nbsp; −${violations[n].pts}</b>`;
    li.firstChild.textContent = n; $('resList').appendChild(li);
  }
}
function toMenu() {
  state = 'menu'; lesson = null; startPose = null;
  for (const id of ['hud', 'pause', 'result']) $(id).hidden = true;
  $('menu').hidden = false; ring.visible = false;
}
function toast(text, cls) {
  const t = document.createElement('div'); t.className = 'toast ' + (cls || ''); t.textContent = text;
  $('toasts').appendChild(t);
  while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
  setTimeout(() => t.remove(), 3500);
}
function penalize(name, pts, cooldown) {
  if (clock - (lastPen[name] ?? -99) < cooldown) return;
  lastPen[name] = clock;
  score -= pts;
  const v = violations[name] || (violations[name] = { n: 0, pts: 0 }); v.n++; v.pts += pts;
  toast(`${name}  −${pts}`);
  beep(180, 0.18);
  if (steps.length && score <= FAIL_SCORE) finish(false, 'Too many serious mistakes.');
}

// ---------------------------------------------------------------- controls
function setGear(g) {
  if (g === car.gear || !GEARS.includes(g)) return;
  if (g === 'P' && Math.abs(car.v) > 0.5) return toast('Stop before selecting P', 'info');
  if (g === 'R' && car.v > 1) return toast('Stop before selecting R', 'info');
  if (g === 'D' && car.v < -1) return toast('Stop before selecting D', 'info');
  car.gear = g; beep(520, 0.04);
}
const shift = dir => setGear(GEARS[clamp(GEARS.indexOf(car.gear) + dir, 0, 3)]);
function toggleEngine() {
  if (!car.engine && car.gear !== 'P' && car.gear !== 'N') return toast('Select P or N to start the engine', 'info');
  car.engine = !car.engine;
}
const toggleBelt = () => { car.belt = !car.belt; beep(700, 0.05); };
const toggleSignal = s => { car.signal = car.signal === s ? 0 : s; };
function togglePause() {
  if (state === 'run') { state = 'pause'; $('pause').hidden = false; }
  else if (state === 'pause') { state = 'run'; $('pause').hidden = true; }
}
const HOLD = { KeyW: 'gas', ArrowUp: 'gas', KeyS: 'brake', ArrowDown: 'brake', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', Space: 'hand' };
window.addEventListener('keydown', e => {
  if (HOLD[e.code]) { keys[HOLD[e.code]] = true; e.preventDefault(); return; }
  if (e.repeat) return;
  if (e.code === 'Escape') return togglePause();
  if (e.code === 'KeyM') { muted = !muted; return; }
  if (state !== 'run') return;
  switch (e.code) {
    case 'KeyB': toggleBelt(); break;
    case 'KeyI': toggleEngine(); break;
    case 'KeyX': shift(1); break;
    case 'KeyZ': shift(-1); break;
    case 'KeyQ': toggleSignal(1); break;
    case 'KeyE': toggleSignal(-1); break;
    case 'KeyC': camMode = (camMode + 1) % 3; break;
    case 'KeyR': startLesson(lesson); break;
    case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': setGear(GEARS[+e.code.slice(5) - 1]); break;
  }
});
window.addEventListener('keyup', e => { if (HOLD[e.code]) keys[HOLD[e.code]] = false; });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

// ---------------------------------------------------------------- audio (tiny synth, no assets)
let actx = null, engOsc = null, engGain = null, muted = false;
function initAudio() {
  if (actx) return;
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    engOsc = actx.createOscillator(); engOsc.type = 'sawtooth';
    const lp = actx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
    engGain = actx.createGain(); engGain.gain.value = 0;
    engOsc.connect(lp).connect(engGain).connect(actx.destination); engOsc.start();
  } catch (e) { actx = null; }
}
function beep(freq, dur) {
  if (!actx || muted) return;
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = 'square'; o.frequency.value = freq; g.gain.value = 0.04;
  o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + dur);
}
function updateAudio() {
  if (!actx) return;
  const on = car.engine && state === 'run' && !muted;
  engGain.gain.setTargetAtTime(on ? 0.035 + (keys.gas ? 0.025 : 0) : 0, actx.currentTime, 0.08);
  engOsc.frequency.setTargetAtTime(48 + Math.abs(car.v) * 5.5 + (keys.gas ? 18 : 0), actx.currentTime, 0.1);
}

// ---------------------------------------------------------------- player update
function updateCar(dt) {
  const px = car.x, pz = car.z, pth = car.th;
  const st = (keys.left ? 1 : 0) - (keys.right ? 1 : 0), vabs = Math.abs(car.v);
  const maxSt = Math.min(0.6, Math.atan(WB * 7 / Math.max(vabs * vabs, 1)));   // limits cornering grip at speed
  const rate = (st ? 1.5 : 3) * dt;
  car.steer = clamp(car.steer + clamp(st * maxSt - car.steer, -rate, rate), -maxSt, maxSt);

  let acc = 0;
  if (car.engine && keys.gas) {
    if (car.gear === 'D') acc = 3.6 * (1 - car.v / 45);
    else if (car.gear === 'R') acc = -2.5 * (1 + car.v / 9);
    else if (clock - (lastPen._hint ?? -9) > 4) { lastPen._hint = clock; toast('Select D or R to move', 'info'); }
  } else if (!car.engine && keys.gas && clock - (lastPen._hint ?? -9) > 4) { lastPen._hint = clock; toast('Engine is off — press I', 'info'); }
  car.v += acc * dt;
  const dec = (0.35 + 0.0005 * vabs * vabs + (keys.brake ? 9 : 0) + (keys.hand ? 6 : 0) + (car.gear === 'P' ? 20 : 0)) * dt;
  car.v = Math.abs(car.v) <= dec ? 0 : car.v - Math.sign(car.v) * dec;

  car.x += Math.sin(car.th) * car.v * dt;
  car.z += Math.cos(car.th) * car.v * dt;
  car.th += car.v / WB * Math.tan(car.steer) * dt;
  car.x = clamp(car.x, -700, 700); car.z = clamp(car.z, -700, 700);

  // solid obstacles: buildings, parked cars, traffic
  let crash = null;
  for (const c of colliders) {
    const nx = clamp(car.x, c.x0, c.x1), nz = clamp(car.z, c.z0, c.z1);
    if (Math.hypot(car.x - nx, car.z - nz) < 1.3) { crash = 'Collision with a building'; break; }
  }
  if (!crash) for (const o of statics) if (obbOverlap(car, o)) { crash = 'Hit a parked car'; break; }
  if (!crash) for (const o of traffic) if (Math.hypot(o.x - car.x, o.z - car.z) < 5 && obbOverlap(car, o)) { crash = 'Collision with a vehicle'; o.hold = 2; break; }
  if (crash) {
    const hard = Math.abs(car.v) > 0.6;
    car.x = px; car.z = pz; car.th = pth; car.v = 0;
    if (hard) penalize(crash, 20, 2.5);
  }
  for (const c of cones) {
    if (c.hit) continue;
    const [lx, lz] = toLocal(car, c.x, c.z);
    if (Math.abs(lx) < CW + 0.2 && Math.abs(lz) < CL + 0.2) {
      c.hit = true; c.mesh.rotation.z = 1.45; c.mesh.position.y = 0.2;
      penalize('Knocked over a cone', 5, 0);
    }
  }
}

function checkRules(dt) {
  const fx = Math.sin(car.th), fz = Math.cos(car.th), kmh = Math.abs(car.v) * 3.6;
  const limit = inLot() ? 20 : 50;
  if (Math.abs(car.v) > 1.5 && !car.belt) penalize('Driving without a seatbelt', 10, 20);
  if (kmh > limit + 3) penalize('Speeding', 5, 4);
  if (!isDrivable(car.x + fx * 1.3, car.z + fz * 1.3) || !isDrivable(car.x - fx * 1.3, car.z - fz * 1.3))
    penalize(inLot() ? 'Left the training area' : 'Left the roadway', 5, 3);
  if (inLot()) { curNode = null; wrongT = 0; return limit; }

  // junction entry / exit: red lights and turn signals
  const i = Math.round(car.x / S), j = Math.round(car.z / S);
  const n = nodes.get(nodeKey(i, j));
  const inside = n && Math.abs(car.x - n.x) < W / 2 && Math.abs(car.z - n.z) < W / 2 ? n : null;
  if (inside && !curNode) {
    const px = car.x - fx * car.v * dt * 2;
    const axis = Math.abs(px - inside.x) >= W / 2 ? 'x' : 'z';
    if (inside.lights && car.v > 0.5 && lightState(inside, axis) === 'r') penalize('Ran a red light', 25, 3);
    entryTh = car.th; entrySig = car.signal;
  } else if (!inside && curNode) {
    let dth = car.th - entryTh; dth = Math.atan2(Math.sin(dth), Math.cos(dth));
    if (Math.abs(dth) > 0.8) {
      const dir = dth > 0 ? 1 : -1;
      if (entrySig !== dir) penalize(`No ${dir > 0 ? 'left' : 'right'} turn signal`, 5, 1);
      if (car.signal === dir) car.signal = 0;   // self-cancelling indicator
    }
  }
  curNode = inside;

  // wrong side of the road (only judged on straight sections while moving forward)
  let wrong = false;
  if (!inside && car.v > 2) {
    const onX = Math.abs(car.z - j * S) < W / 2 && Math.abs(car.x) <= HALF;
    const onZ = Math.abs(car.x - i * S) < W / 2 && Math.abs(car.z) <= HALF;
    if (onX && !onZ && Math.abs(fx) > 0.7) wrong = (car.z - j * S) * Math.sign(fx) * side < -0.7;
    else if (onZ && !onX && Math.abs(fz) > 0.7) wrong = (car.x - i * S) * -Math.sign(fz) * side < -0.7;
  }
  wrongT = wrong ? wrongT + dt : 0;
  if (wrongT > 1.2) { penalize('Driving on the wrong side', 10, 5); wrongT = 0; }
  return limit;
}

// ---------------------------------------------------------------- camera
const camTarget = new T.Vector3();
function updateCamera(dt) {
  const fx = Math.sin(car.th), fz = Math.cos(car.th);
  camera.up.set(0, 1, 0);
  if (state === 'menu') {
    const a = clock * 0.05;
    camera.position.set(Math.cos(a) * 150, 85, Math.sin(a) * 150); camera.lookAt(0, 0, 0);
    camTarget.set(0, 0, 0);
  } else if (camMode === 1) {
    const ox = side * 0.38;   // driver sits on the side nearest the road centre
    camera.position.set(car.x + fz * ox + fx * 0.05, 1.27, car.z - fx * ox + fz * 0.05);
    camera.lookAt(camera.position.x + fx * 10, 1.1, camera.position.z + fz * 10);
    camTarget.set(car.x, 0, car.z);
  } else if (camMode === 2) {
    camera.up.set(fx, 0, fz);
    camera.position.set(car.x, 30, car.z); camera.lookAt(car.x, 0, car.z);
    camTarget.set(car.x, 0, car.z);
  } else {
    const k = 1 - Math.exp(-6 * dt);
    camera.position.x += (car.x - fx * 8 - camera.position.x) * k;
    camera.position.z += (car.z - fz * 8 - camera.position.z) * k;
    camera.position.y += (3.3 - camera.position.y) * k;
    camera.lookAt(car.x + fx * 3, 1.2, car.z + fz * 3);
    camTarget.set(car.x, 0, car.z);
  }
  sun.position.set(camTarget.x + 55, 100, camTarget.z + 35);
  sun.target.position.copy(camTarget);
}

// ---------------------------------------------------------------- HUD
const gearBtns = GEARS.map(g => { const b = document.createElement('button'); b.textContent = g; b.onclick = () => setGear(g); $('gears').appendChild(b); return b; });
const mapCtx = $('map').getContext('2d');
function updateHud(limit, blinkOn) {
  const kmh = Math.round(Math.abs(car.v) * 3.6);
  $('speed').textContent = kmh; $('speed').classList.toggle('over', kmh > limit + 3);
  $('limit').textContent = limit;
  $('score').textContent = Math.max(0, score);
  gearBtns.forEach((b, k) => b.classList.toggle('on', GEARS[k] === car.gear));
  $('belt').classList.toggle('on', car.belt); $('engine').classList.toggle('on', car.engine);
  $('sigL').classList.toggle('on', car.signal === 1 && blinkOn); $('sigR').classList.toggle('on', car.signal === -1 && blinkOn);

  const s = steps[stepIdx], tgt = s && (s.type === 'cp' ? s : s.box);
  $('nav').hidden = !tgt;
  if (tgt) {
    const dx = tgt.x - car.x, dz = tgt.z - car.z;
    $('navArrow').style.transform = `rotate(${-(Math.atan2(dx, dz) - car.th)}rad)`;
    $('navDist').textContent = Math.round(Math.hypot(dx, dz)) + ' m';
  }

  // minimap: north-up, centred on the car
  const g = mapCtx, N = 340, sc = 0.62, cx = N / 2, cy = N / 2;
  const X = x => cx + (x - car.x) * sc, Z = z => cy + (z - car.z) * sc;
  g.clearRect(0, 0, N, N);
  g.fillStyle = '#5b5f68'; g.fillRect(X(LOT.x0), Z(LOT.z0), (LOT.x1 - LOT.x0) * sc, (LOT.z1 - LOT.z0) * sc);
  g.strokeStyle = '#8a909b'; g.lineWidth = W * sc; g.beginPath();
  for (let k = -G; k <= G; k++) { g.moveTo(X(-HALF), Z(k * S)); g.lineTo(X(HALF), Z(k * S)); g.moveTo(X(k * S), Z(-HALF)); g.lineTo(X(k * S), Z(HALF)); }
  g.stroke();
  g.fillStyle = '#dfe6f0'; for (const c of traffic) g.fillRect(X(c.x) - 3, Z(c.z) - 3, 6, 6);
  if (tgt) { g.fillStyle = '#ffc530'; g.beginPath(); g.arc(clamp(X(tgt.x), 8, N - 8), clamp(Z(tgt.z), 8, N - 8), 8, 0, 7); g.fill(); }
  g.save(); g.translate(cx, cy); g.rotate(-car.th + Math.PI);
  g.fillStyle = '#ff4b3e'; g.beginPath(); g.moveTo(0, -13); g.lineTo(8, 9); g.lineTo(0, 4); g.lineTo(-8, 9); g.closePath(); g.fill();
  g.restore();
}

// ---------------------------------------------------------------- main loop
let last = performance.now(), lastBlink = false;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (state !== 'pause' && state !== 'end') {
    clock += dt;
    const blinkOn = (clock * 2.6) % 1 < 0.5;
    updateLights();
    updateTraffic(dt, blinkOn);
    if (state === 'run') {
      updateCar(dt);
      const limit = checkRules(dt);
      if (state === 'run') {
        const s = steps[stepIdx];
        if (s && stepDone(s)) {
          stepIdx++; beep(880, 0.08);
          if (stepIdx >= steps.length) finish(score >= PASS_SCORE, score >= PASS_SCORE ? 'Well driven!' : 'You finished the route, but with too many mistakes.');
          else showStep();
        }
        if (activeBox) { const ok = inBox(activeBox); activeBox.mats[0].color.setHex(ok ? 0x3ddc84 : 0xffc530); activeBox.mats[1].color.setHex(ok ? 0x3ddc84 : 0xffc530); }
      }
      if (car.signal && blinkOn !== lastBlink) beep(blinkOn ? 1200 : 900, 0.015);
      lastBlink = blinkOn;
      updateHud(limit, blinkOn);
    }
    playerMesh.position.set(car.x, 0, car.z); playerMesh.rotation.y = car.th;
    const u = playerMesh.userData;
    u.fw.forEach(p => { p.rotation.y = car.steer; });
    u.wheel.rotation.z = -car.steer * 4;
    setCarLamps(playerMesh, keys.brake || car.gear === 'P', car.signal, blinkOn);
    updateAudio();
  }
  updateCamera(dt);
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------- UI wiring
for (const l of LESSONS) {
  const b = document.createElement('button'); b.className = 'lesson';
  b.innerHTML = '<b></b><span></span>'; b.children[0].textContent = l.title; b.children[1].textContent = l.desc;
  b.onclick = () => startLesson(l); $('lessons').appendChild(b);
}
for (const b of $('sideSel').children) b.onclick = () => {
  side = +b.dataset.side;
  for (const o of $('sideSel').children) o.classList.toggle('on', o === b);
  try { localStorage.setItem('driveready.side', side); } catch (e) { /* storage unavailable */ }
  buildWorld();
};
$('sigL').onclick = () => toggleSignal(1); $('sigR').onclick = () => toggleSignal(-1);
$('belt').onclick = toggleBelt; $('engine').onclick = toggleEngine;
$('cam').onclick = () => { camMode = (camMode + 1) % 3; };
$('pauseBtn').onclick = togglePause; $('resume').onclick = togglePause;
$('restart').onclick = $('retry').onclick = () => startLesson(lesson);
$('toMenu').onclick = $('resMenu').onclick = toMenu;
for (const p of document.querySelectorAll('.pad')) {
  const k = p.dataset.key, set = v => e => { keys[k] = v; e.preventDefault(); };
  p.addEventListener('pointerdown', set(true)); p.addEventListener('pointerup', set(false));
  p.addEventListener('pointerleave', set(false)); p.addEventListener('pointercancel', set(false));
}
if ('ontouchstart' in window || navigator.maxTouchPoints > 0) document.body.classList.add('touch');

try { const s = +localStorage.getItem('driveready.side'); if (s === 1 || s === -1) side = s; } catch (e) { /* storage unavailable */ }
for (const o of $('sideSel').children) o.classList.toggle('on', +o.dataset.side === side);
buildWorld();
window.__sim = { car, keys, get state() { return state; }, get score() { return score; }, get stepIdx() { return stepIdx; }, get traffic() { return traffic; }, get violations() { return violations; } };
requestAnimationFrame(frame);
})();
