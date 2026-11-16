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
const AUTO_GEARS = ['P', 'R', 'N', 'D'], MANUAL_GEARS = ['R', 'N', '1', '2', '3', '4', '5'];
// manual gearbox: top speed (m/s), pull, engine braking, torque floor at low revs, stall speeds with / without gas
const MG = {
  R: { max: 9, acc: 2.6, brake: 1.2, low: 1, gasMin: -1, idleMin: 0.8, creep: 1.6 },
  1: { max: 12, acc: 3.8, brake: 1.4, low: 1, gasMin: -1, idleMin: 0.8, creep: 1.6 },
  2: { max: 20, acc: 2.9, brake: 0.9, low: 0.5, gasMin: 0, idleMin: 2.5 },
  3: { max: 30, acc: 2.1, brake: 0.6, low: 0.3, gasMin: 3, idleMin: 5 },
  4: { max: 40, acc: 1.5, brake: 0.4, low: 0.25, gasMin: 6, idleMin: 8 },
  5: { max: 48, acc: 1.1, brake: 0.3, low: 0.25, gasMin: 9, idleMin: 11 },
};
const PASS_SCORE = 70, FAIL_SCORE = 40;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
// Road segments are keyed by axis and their lower-index node: 'x:i,j' runs from node (i,j) to (i+1,j).
const ZONE30 = new Set(['x:0,1', 'x:-1,1', 'x:-1,-1']);   // 30 km/h zones, each with a zebra crossing
const STOP_NODES = new Set(['1,1', '-1,-1']);             // all-way STOP junctions (no lights)
const CW_AT = 0.35;      // zebra position along its segment (fraction of S from the lower node)
const PED_U = W / 2 + 1.5; // kerb-to-kerb half distance a pedestrian walks

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

// ---------------------------------------------------------------- mirrors
// Each mirror is a rear-facing camera on the car rendered to a texture, then drawn flipped on a screen overlay.
const overlay = new T.Scene(), overlayCam = new T.OrthographicCamera(0, 1, 1, 0, -1, 1);
let mirrorsOn = true;
const mirrors = [
  { id: 'centre', pos: [0, 1.3, -0.4], yaw: 0, fov: 20 },
  { id: 'left', pos: [1.28, 1.05, 0.5], yaw: -0.22, fov: 30 },
  { id: 'right', pos: [-1.28, 1.05, 0.5], yaw: 0.22, fov: 30 },
].map(m => {
  m.rt = new T.WebGLRenderTarget(64, 64);
  m.cam = new T.PerspectiveCamera(m.fov, 1, 0.3, 260);   // a camera looks down its -z, which is the car's rear
  m.cam.position.set(...m.pos); m.cam.rotation.y = m.yaw;
  const noDepth = { depthTest: false, depthWrite: false };
  m.frame = new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshBasicMaterial({ color: 0x0d1016, ...noDepth }));
  m.quad = new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshBasicMaterial({ map: m.rt.texture, side: T.DoubleSide, ...noDepth }));
  m.frame.renderOrder = 0; m.quad.renderOrder = 1;
  overlay.add(m.frame, m.quad);
  return m;
});
function layoutMirrors() {
  const W_ = window.innerWidth, H_ = window.innerHeight, small = W_ < 720;
  overlayCam.right = W_; overlayCam.top = H_; overlayCam.updateProjectionMatrix();
  const sides = W_ >= 900 && H_ >= 560;
  for (const m of mirrors) {
    const centre = m.id === 'centre';
    const w = centre ? (small ? 190 : 300) : 190, h = centre ? (small ? 54 : 84) : 124;
    m.show = centre || sides;
    const cx = centre ? W_ / 2 : m.id === 'left' ? 12 + w / 2 : W_ - 12 - w / 2, cy = H_ - (centre ? 12 : 270) - h / 2;
    m.quad.position.set(cx, cy, 0); m.quad.scale.set(-w, h, 1);   // negative width = mirror image
    m.frame.position.set(cx, cy, 0); m.frame.scale.set(w + 8, h + 8, 1);
    m.cam.aspect = w / h; m.cam.updateProjectionMatrix();
    const pr = renderer.getPixelRatio(); m.rt.setSize(Math.round(w * pr), Math.round(h * pr));
  }
}
window.addEventListener('resize', layoutMirrors);
layoutMirrors();

// ---------------------------------------------------------------- state
let manual = false;     // manual gearbox with clutch instead of the automatic
let side = -1;           // -1 = traffic keeps left (default, as in India), 1 = keeps right
let scene, sun, nodes, colliders, drivable, ring, lessonGroup, playerMesh;
let traffic = [], cones = [], statics = [], peds = [], crosswalks = [];
let state = 'menu';      // menu | run | pause | end
let lesson = null, steps = [], stepIdx = 0, startPose = null;
let score = 100, violations = {}, lastPen = {}, clock = 0;
let camMode = 0;         // 0 chase, 1 cockpit, 2 top
let wrongT = 0, curNode = null, entryTh = 0, entrySig = 0, activeBox = null;
let curLimit = 50, limitSince = 0, stopNode = null, stopTime = -99;
const car = { x: 0, z: 0, th: 0, v: 0, steer: 0, gear: 'P', engine: false, belt: false, signal: 0, clutch: 0, hand: false, rpm: 0 };
const keys = { gas: false, brake: false, left: false, right: false, clutch: false, horn: false };
let ramp = null, rollDist = 0, lastH = 0;   // hill-start ramp of the current lesson, if any
function groundH(x, z) {
  if (!ramp || Math.abs(z - ramp.z) > ramp.hw) return 0;
  const u = x - ramp.x;
  if (u <= 0 || u >= ramp.len) return 0;
  return u < ramp.up ? u / ramp.up * ramp.h : u < ramp.up + ramp.top ? ramp.h : (ramp.len - u) / ramp.up * ramp.h;
}
function slopeAhead() {   // rise per metre in the direction the car points
  if (!ramp) return 0;
  const fx = Math.sin(car.th) * 0.6, fz = Math.cos(car.th) * 0.6;
  return (groundH(car.x + fx, car.z + fz) - groundH(car.x - fx, car.z - fz)) / 1.2;
}
const gearList = () => manual ? MANUAL_GEARS : AUTO_GEARS;
let lang = 'en';
const tr = s => (lang === 'ta' && window.LANG_TA && window.LANG_TA[s]) || s;   // translate an English text
function TL(strings, ...vals) {   // translated template: TL`Too fast for gear ${g}` looks up 'Too fast for gear {0}'
  let key = strings[0];
  for (let i = 0; i < vals.length; i++) key += `{${i}}` + strings[i + 1];
  return tr(key).replace(/\{(\d)\}/g, (_, n) => vals[n]);
}
const tx = (auto, man) => tr(manual ? man : auto);   // lesson text that differs by gearbox
const inDriveGear = () => manual ? car.gear === '1' && !car.hand : car.gear === 'D';
const isSecured = () => manual ? car.gear === 'N' && car.hand : car.gear === 'P';

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
  signPole: new T.CylinderGeometry(0.05, 0.05, 2.6, 6), signRound: new T.CircleGeometry(0.55, 24),
  signOct: new T.CircleGeometry(0.6, 8, Math.PI / 8), signSquare: new T.PlaneGeometry(1, 1),
  pedBody: new T.BoxGeometry(0.42, 0.62, 0.26), pedHead: new T.SphereGeometry(0.15, 10, 8), pedLeg: new T.BoxGeometry(0.15, 0.72, 0.17),
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

// ---------------------------------------------------------------- road signs
const signMats = {};
function signMat(kind) {
  if (signMats[kind]) return signMats[kind];
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.textAlign = 'center'; g.textBaseline = 'middle';
  if (kind === 'stop') {
    g.fillStyle = '#c8102e'; g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#fff'; g.font = 'bold 38px Arial, sans-serif'; g.fillText('STOP', 64, 67);
  } else if (kind === 'walk') {
    g.fillStyle = '#fff'; g.fillRect(0, 0, 128, 128);   // cautionary sign: red-bordered triangle
    g.strokeStyle = '#d8262c'; g.lineWidth = 12; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(64, 12); g.lineTo(118, 112); g.lineTo(10, 112); g.closePath(); g.stroke();
    g.fillStyle = g.strokeStyle = '#111'; g.lineWidth = 7; g.lineCap = 'round';
    g.lineWidth = 6; g.beginPath(); g.arc(64, 50, 6, 0, 7); g.fill();
    g.beginPath(); g.moveTo(64, 58); g.lineTo(64, 82); g.moveTo(64, 82); g.lineTo(52, 102); g.moveTo(64, 82); g.lineTo(76, 102);
    g.moveTo(50, 70); g.lineTo(78, 66); g.stroke();
  } else {   // speed limit: the kind is the number
    g.fillStyle = '#fff'; g.fillRect(0, 0, 128, 128);
    g.strokeStyle = '#d8262c'; g.lineWidth = 16; g.beginPath(); g.arc(64, 64, 54, 0, 7); g.stroke();
    g.fillStyle = '#111'; g.font = 'bold 54px Arial, sans-serif'; g.fillText(kind, 64, 68);
  }
  const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 4;
  return (signMats[kind] = new T.MeshBasicMaterial({ map: t }));
}
// (nx, nz) is the direction the sign face points, i.e. towards the driver it addresses
function addSign(kind, x, z, nx, nz) {
  const geo = kind === 'stop' ? GEO.signOct : kind === 'walk' ? GEO.signSquare : GEO.signRound;
  const g = new T.Group(); g.position.set(x, 0, z); g.rotation.y = Math.atan2(nx, nz);
  const pole = new T.Mesh(GEO.signPole, MAT.pole); pole.position.y = 1.3;
  const face = new T.Mesh(geo, signMat(String(kind))); face.position.set(0, 2.7, 0.06);
  const back = new T.Mesh(geo, MAT.pole); back.position.set(0, 2.7, 0.04); back.rotation.y = Math.PI;
  g.add(pole, face, back); scene.add(g);
}
const segKey = (a, b) => a.j === b.j ? `x:${Math.min(a.i, b.i)},${a.j}` : `z:${a.i},${Math.min(a.j, b.j)}`;
function limitAt(x, z) {   // null inside junctions and off the road: the previous limit keeps applying
  if (x > LOT.x0 - 5) return 20;
  const i = Math.round(x / S), j = Math.round(z / S);
  const onX = Math.abs(z - j * S) < W / 2 && Math.abs(x) <= HALF, onZ = Math.abs(x - i * S) < W / 2 && Math.abs(z) <= HALF;
  if (onX && !onZ) return ZONE30.has(`x:${Math.floor(x / S)},${j}`) ? 30 : 50;
  if (onZ && !onX) return ZONE30.has(`z:${i},${Math.floor(z / S)}`) ? 30 : 50;
  return null;
}

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
  for (const n of nodes.values()) for (const d of DIRS) if (nodes.has(nodeKey(n.i + d[0], n.j + d[1]))) n.nb.push(d);
  for (const n of nodes.values()) {
    n.stop = STOP_NODES.has(nodeKey(n.i, n.j)); n.claim = null;
    n.lights = n.nb.length >= 3 && !n.stop;
    flat(scene, W, W, asphalt, n.x, 0.06, n.z);
    for (const d of n.nb) {            // speed-limit sign wherever the limit changes on the way out of a junction
      const out = nodeAt(n, d), lim = ZONE30.has(segKey(n, out)) ? 30 : 50, l = laneVec(d);
      const differs = n.nb.some(o => !(o[0] === d[0] && o[1] === d[1]) && (ZONE30.has(segKey(n, nodeAt(n, o))) ? 30 : 50) !== lim);
      if (differs) addSign(lim, n.x + d[0] * (W / 2 + 7) + l[0] * (W / 2 + 1.2), n.z + d[1] * (W / 2 + 7) + l[1] * (W / 2 + 1.2), -d[0], -d[1]);
    }
    if (!n.lights && !n.stop) continue;
    const mk = () => [basic(0x330000), basic(0x332200), basic(0x003300)];
    if (n.lights) n.mats = { x: mk(), z: mk() };
    for (const d of n.nb) {            // d points from the node to the neighbour the traffic arrives from
      const t = [-d[0], -d[1]], l = laneVec(t), axis = t[0] !== 0 ? 'x' : 'z';
      flat(scene, W / 2 - 0.5, 0.5, MAT.white, n.x + d[0] * (W / 2 + 0.7) + l[0] * W / 4, 0.08,
        n.z + d[1] * (W / 2 + 0.7) + l[1] * W / 4, axis === 'x' ? Math.PI / 2 : 0);
      if (n.stop) { addSign('stop', n.x + d[0] * (W / 2 + 1.2) + l[0] * (W / 2 + 1.2), n.z + d[1] * (W / 2 + 1.2) + l[1] * (W / 2 + 1.2), d[0], d[1]); continue; }
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

  // zebra crossings in the 30 zones
  crosswalks = [];
  for (const key of ZONE30) {
    const ax = key[0], [i, j] = key.slice(2).split(',').map(Number);
    const cw = { ax, x: (ax === 'x' ? i + CW_AT : i) * S, z: (ax === 'x' ? j : j + CW_AT) * S, key, busy: false };
    crosswalks.push(cw);
    for (let u = -W / 2 + 0.75; u < W / 2; u += 1.05)
      flat(scene, ax === 'x' ? 3 : 0.55, ax === 'x' ? 0.55 : 3, MAT.white, cw.x + (ax === 'x' ? 0 : u), 0.08, cw.z + (ax === 'x' ? u : 0));
    for (const sgn of [1, -1]) {
      const t = ax === 'x' ? [sgn, 0] : [0, sgn], l = laneVec(t);
      addSign('walk', cw.x - t[0] * 3 + l[0] * (W / 2 + 1.2), cw.z - t[1] * 3 + l[1] * (W / 2 + 1.2), -t[0], -t[1]);
    }
  }
  addSign(20, 282, -44, 0, -1);

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
  playerMesh.rotation.order = 'YXZ';   // heading first, then pitch on slopes
  for (const m of mirrors) playerMesh.add(m.cam);
  spawnTraffic(16);
  spawnPeds();
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
  if (c.b && c.b.claim === c) c.b.claim = null;   // leaving the STOP junction we had priority at
  c.slow = ZONE30.has(segKey(a, b)); c.stopT = 0;
  c.cw = c.slow ? crosswalks.find(k => k.key === segKey(a, b)) : null;
  if (c.cw) c.sCw = ((b.i - a.i) + (b.j - a.j) > 0 ? CW_AT : 1 - CW_AT) * S - W / 2;
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
  for (const n of nodes.values()) n.claim = null;
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
      if (c.slow) vmax = Math.min(vmax, 7.6);
      if (c.cw && c.cw.busy && c.s < c.sCw - 3) vmax = Math.min(vmax, Math.sqrt(2 * 3 * Math.max(0, c.sCw - 5.5 - c.s)));
      if (c.b.stop && c.b.claim !== c) {   // all-way stop: halt, wait a second, go when the junction is free
        const dist = stopS - c.s;
        vmax = Math.min(vmax, Math.sqrt(2 * 3 * Math.max(0, dist)));
        if (dist < 0.6 && c.v < 0.5) {
          c.stopT += dt;
          const playerIn = Math.abs(car.x - c.b.x) < W / 2 && Math.abs(car.z - c.b.z) < W / 2;
          if (c.stopT > 1 && !c.b.claim && !playerIn) c.b.claim = c;
        }
      }
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

// ---------------------------------------------------------------- pedestrians
function makePed(rand) {
  const shirts = [0xd9483b, 0x3b7dd9, 0xe8c547, 0x4caf6a, 0xf2f2f2, 0x8e5bd0, 0x2f3640, 0xe07b39];
  const g = new T.Group();
  const body = new T.Mesh(GEO.pedBody, lam(shirts[Math.floor(rand() * shirts.length)])); body.position.y = 1.05; body.castShadow = true;
  const head = new T.Mesh(GEO.pedHead, lam(0xe2b38f)); head.position.y = 1.53;
  const legMat = lam(0x2b3350), legs = [];
  for (const sx of [1, -1]) {
    const hip = new T.Group(); hip.position.set(sx * 0.11, 0.74, 0);
    const leg = new T.Mesh(GEO.pedLeg, legMat); leg.position.y = -0.36;
    hip.add(leg); g.add(hip); legs.push(hip);
  }
  g.add(body, head); g.userData.legs = legs; scene.add(g);
  return g;
}
function spawnPeds() {
  const rand = Math.random;
  peds = [];
  for (const cw of crosswalks) for (const sgn of [1, -1])   // two people per zebra, starting on opposite kerbs
    peds.push({ kind: 'cross', cw, u: sgn * PED_U, dir: -sgn, off: sgn * 0.7, wait: 3 + rand() * 8, walking: false, speed: 1.3 + rand() * 0.3 });
  for (let k = 0; k < 18; k++) {                             // strollers circling a block on the pavement
    const cx = (Math.floor(rand() * 2 * G) - G + 0.5) * S, cz = (Math.floor(rand() * 2 * G) - G + 0.5) * S, r = (S - W) / 2 - 1.2 - rand() * 2.2;
    const pts = [[cx - r, cz - r], [cx + r, cz - r], [cx + r, cz + r], [cx - r, cz + r]], at = Math.floor(rand() * 4), f = rand();
    const turn = rand() < 0.5 ? 1 : 3, to = (at + turn) % 4;
    peds.push({ kind: 'loop', pts, k: to, turn, x: pts[at][0] + (pts[to][0] - pts[at][0]) * f, z: pts[at][1] + (pts[to][1] - pts[at][1]) * f, speed: 1.1 + rand() * 0.5 });
  }
  for (const p of peds) { p.mesh = makePed(rand); p.phase = rand() * 6; p.th = 0; placeCrossPed(p); }
}
function placeCrossPed(p) {
  if (p.kind !== 'cross') return;
  const x = p.cw.ax === 'x';
  p.x = p.cw.x + (x ? p.off : p.u); p.z = p.cw.z + (x ? p.u : p.off);
}
function crossingClear(cw, vehicles) {   // nobody steps out in front of a vehicle that could not stop in time
  for (const v of vehicles) {
    const x = cw.ax === 'x', along = x ? cw.x - v.x : cw.z - v.z, lat = x ? v.z - cw.z : v.x - cw.x;
    if (Math.abs(lat) > W / 2 + 1) continue;
    const va = v.v * (x ? Math.sin(v.th) : Math.cos(v.th));
    if (Math.abs(along) < 4 || (Math.abs(va) > 0.5 && along * va > 0 && Math.abs(along) < 9 + Math.abs(va) * 2.2)) return false;
  }
  return true;
}
function updatePeds(dt) {
  const vehicles = [...traffic, car];
  for (const p of peds) {
    let nx = p.x, nz = p.z, step = false;
    if (p.kind === 'cross') {
      if (!p.walking && inp.horn && state === 'run' && Math.hypot(p.x - car.x, p.z - car.z) < 30) p.wait = Math.max(p.wait, 2.5);   // a warning horn makes people wait
      if (!p.walking) { p.wait -= dt; if (p.wait <= 0 && crossingClear(p.cw, vehicles)) p.walking = true; }
      if (p.walking) {
        const x = p.cw.ax === 'x', nu = p.u + p.dir * p.speed * dt;
        nx = p.cw.x + (x ? p.off : nu); nz = p.cw.z + (x ? nu : p.off); step = true;
      }
    } else {
      const [tx, tz] = p.pts[p.k], d = Math.hypot(tx - p.x, tz - p.z);
      if (d < 0.3) p.k = (p.k + p.turn) % 4;
      else { nx = p.x + (tx - p.x) / d * p.speed * dt; nz = p.z + (tz - p.z) / d * p.speed * dt; step = true; }
    }
    if (step) for (const v of vehicles) {   // never walk into a vehicle; walking away from one is fine
      const [lx, lz] = toLocal(v, nx, nz);
      if (Math.abs(lx) < CW + 0.7 && Math.abs(lz) < CL + 0.9 && Math.hypot(nx - v.x, nz - v.z) < Math.hypot(p.x - v.x, p.z - v.z)) { step = false; break; }
    }
    if (step) {
      p.th = Math.atan2(nx - p.x, nz - p.z); p.x = nx; p.z = nz; p.phase += dt * p.speed * 5.5;
      if (p.kind === 'cross') {
        p.u += p.dir * p.speed * dt;
        if (p.u * p.dir >= PED_U) { p.u = p.dir * PED_U; p.dir = -p.dir; p.walking = false; p.wait = 6 + Math.random() * 12; }
      }
    }
    const swing = step ? Math.sin(p.phase) * 0.6 : 0;
    p.mesh.userData.legs[0].rotation.x = swing; p.mesh.userData.legs[1].rotation.x = -swing;
    p.mesh.position.set(p.x, p.kind === 'loop' ? 0.14 : 0, p.z); p.mesh.rotation.y = p.th;
  }
  for (const cw of crosswalks) cw.busy = peds.some(p => p.cw === cw && p.walking && Math.abs(p.u) < W / 2 + 0.6);
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
  const g = new T.Group(); g.position.set(b.x, (b.y || 0) + 0.1, b.z);
  g.rotation.order = 'YXZ'; g.rotation.y = b.th; g.rotation.x = -(b.pitch || 0);
  flat(g, b.hw * 2, b.hl * 2, fill, 0, 0, 0);
  for (const sgn of [1, -1]) { flat(g, 0.18, b.hl * 2, mat, sgn * b.hw, 0.01, 0); flat(g, b.hw * 2, 0.18, mat, 0, 0.01, sgn * b.hl); }
  lessonGroup.add(g);
  b.mats = [mat, fill];
  return b;
}
// Cones along every boundary point that is not inside another part of the track (so junctions stay open).
function coneTrack(points, lanes) {
  for (const [x, z] of points)
    if (!lanes.some(f => f(x, z)) && !cones.some(c => Math.hypot(c.x - x, c.z - z) < 0.7)) addCone(x, z);
}
function circlePts(cx, cz, r, gap) { const n = Math.round(2 * Math.PI * r / gap), o = []; for (let k = 0; k < n; k++) o.push([cx + Math.cos(k / n * 2 * Math.PI) * r, cz + Math.sin(k / n * 2 * Math.PI) * r]); return o; }
function linePts(x0, z0, x1, z1, gap) { const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / gap), o = []; for (let k = 0; k <= n; k++) o.push([x0 + (x1 - x0) * k / n, z0 + (z1 - z0) * k / n]); return o; }
const SECURE_TXT = () => tx('select P', 'apply the parking brake (Space) and select neutral');
const READY_TXT = () => tx('Get ready: seatbelt (B), engine (I), select Drive (X).', 'Get ready: seatbelt (B), engine (I), hold the clutch (Shift), select 1st (X) and release the parking brake (Space).');
const cityStart = () => { const l = laneVec([1, 0]); return { x: -120 + l[0] * LANE, z: l[1] * LANE, th: Math.PI / 2 }; };

const LESSONS = [
  { id: 'basics', title: '1 · First steps', desc: 'Seatbelt, engine, gears, a slalom between cones and a controlled stop.', build() {
      const X = 275;
      [-25, -10, 5, 20].forEach(z => addCone(X, z));
      const box = addBox({ x: 340, z: 52, th: Math.PI / 2, hw: 2.3, hl: 4.2 });
      const gates = [[X + 4, -25], [X - 4, -10], [X + 4, 5], [X - 4, 20]];
      return { start: { x: X, z: -52, th: 0 }, steps: [
        { type: 'belt', text: tr('Welcome! Before anything else, fasten your seatbelt — press B.') },
        { type: 'engine', text: tx('Start the engine — press I.', 'Check the gear is in neutral (N), then start the engine — press I.') },
        { type: 'drive', text: tx('Select Drive: press X to move the selector P → R → N → D.', 'Hold the clutch (Shift) and select 1st gear (X). Then release the parking brake (Space).') },
        ...gates.map(([x, z], k) => ({ type: 'cp', x, z, r: 2.6, text: k ? tr('Keep weaving — pass the next cone on the other side. Gentle steering, low speed.') : tx('Accelerate gently (W) and slalom through the cones. Drive through each yellow marker.', 'Press the gas (W) and let the clutch (Shift) come up to move off. Slalom through the cones, driving through each yellow marker.') })),
        { type: 'cp', x: X, z: 40, r: 3.5, text: tr('Straighten up and continue to the marker.') },
        { type: 'cp', x: 305, z: 52, r: 3.5, text: tr('Turn left towards the stopping box. Remember the 20 km/h limit.') },
        { type: 'stop', box, text: tx('Stop completely inside the yellow box (S to brake).', 'Stop completely inside the yellow box: clutch down (Shift) before you stop, then brake (S).') },
        { type: 'secure', text: tx('Good stop! Now select Park — press Z until P is highlighted.', 'Good stop! Apply the parking brake (Space) and select neutral (Z, with the clutch down).') },
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
        { type: 'ready', text: READY_TXT() },
        { type: 'cp', x: 310, z: 30, r: 5, text: tr('Drive to the row of parked cars. Use the top camera (C) to see the bay.') },
        { type: 'stop', box, park: true, text: TL`Park fully inside the free bay, stop, then ${SECURE_TXT()}. For reverse: stop, select R (Z), steer and back in slowly.` },
      ] };
    } },
  { id: 'eight', title: '3 · "8" track', desc: 'Drive a figure of eight between the cones — one loop each way — without touching any.', build() {
      const cx = 320, cz = 0, R = 9, hw = 2.3, len = 24;
      const lanes = [(x, z) => Math.abs(Math.hypot(x - cx, z - (cz - R)) - R) < hw - 0.2, (x, z) => Math.abs(Math.hypot(x - cx, z - (cz + R)) - R) < hw - 0.2,
        (x, z) => Math.abs(z - cz) < hw - 0.2 && Math.abs(x - cx) < len + 0.5];
      const pts = [];
      for (const sgn of [1, -1]) {
        pts.push(...circlePts(cx, cz + sgn * R, R - hw, 1.9), ...circlePts(cx, cz + sgn * R, R + hw, 1.9));
        pts.push(...linePts(cx - len, cz + sgn * hw, cx + len, cz + sgn * hw, 1.9));
      }
      coneTrack(pts, lanes);
      const box = addBox({ x: cx + len + 9, z: cz, th: Math.PI / 2, hw: 2.3, hl: 4.2 });
      const cp = (x, z, text) => ({ type: 'cp', x, z, r: 2.3, text });
      const b = tr('First loop: steer right and keep a slow, steady speed all the way round.'), a = tr('Second loop: cross the centre and steer left around the other circle.');
      return { start: { x: cx - len - 8, z: cz, th: Math.PI / 2 }, steps: [
        { type: 'ready', text: READY_TXT() },
        cp(cx + R, cz + R, tr('Drive in along the lane. At the centre, start the first loop to the right. Do not touch the cones.')),
        cp(cx, cz + 2 * R, b), cp(cx - R, cz + R, b),
        cp(cx + R, cz - R, a), cp(cx, cz - 2 * R, a), cp(cx - R, cz - R, a),
        { type: 'stop', box, park: true, text: TL`Leave through the centre, stop in the yellow box, then ${SECURE_TXT()}.` },
      ] };
    } },
  { id: 'h', title: '4 · "H" track', desc: 'Drive forward through the H — up one leg, across the bar, up the other — then reverse all the way back.', build() {
      const hx = 320, hz = 0, D = 10, L = 18, hw = 3;
      const rects = [[hx - D, hz, hw, L], [hx + D, hz, hw, L], [hx, hz, D, hw]];   // centre x, z, half x, half z
      const lanes = rects.map(([x0, z0, a, b]) => (x, z) => Math.abs(x - x0) < a - 0.2 && Math.abs(z - z0) < b - 0.2);
      const pts = [];
      for (const [x0, z0, a, b] of rects) for (const sgn of [1, -1])
        pts.push(...linePts(x0 - a, z0 + sgn * b, x0 + a, z0 + sgn * b, 1.8), ...linePts(x0 + sgn * a, z0 - b, x0 + sgn * a, z0 + b, 1.8));
      coneTrack(pts, lanes);
      const far = addBox({ x: hx + D, z: hz + 12, th: 0, hw: 2.4, hl: 3.6 }), home = addBox({ x: hx - D, z: hz - 12, th: 0, hw: 2.4, hl: 3.6 });
      return { start: { x: hx - D, z: hz - 12, th: 0 }, steps: [
        { type: 'ready', text: READY_TXT() },
        { type: 'cp', x: hx, z: hz, r: 2.6, text: tr('Forward: drive up the leg and turn left into the crossbar. Go slowly and do not touch the cones.') },
        { type: 'stop', box: far, text: tr('Turn right into the far leg and stop inside the yellow box at the end.') },
        { type: 'reverse', text: tx('Now select reverse — press Z until R is highlighted.', 'Now select reverse — hold the clutch (Shift) and press Z until R is highlighted.') },
        { type: 'cp', x: hx, z: hz, r: 2.6, text: tr('Reverse back the way you came: down the leg and round into the crossbar. The top camera (C) helps.') },
        { type: 'stop', box: home, park: true, text: TL`Keep reversing round into the first leg, stop in the starting box, then ${SECURE_TXT()}.` },
      ] };
    } },
  { id: 'hill', title: '5 · Hill start', desc: 'Stop on a slope, then pull away uphill without rolling back. Come down the far side under control.', build() {
      const x0 = 284, z0 = -35, up = 25, top = 12, h = 3.5, hw = 4;
      ramp = { x: x0, z: z0, up, top, h, len: 2 * up + top, hw };
      const shape = new T.Shape([new T.Vector2(0, 0), new T.Vector2(up, h), new T.Vector2(up + top, h), new T.Vector2(ramp.len, 0)]);
      const m = new T.Mesh(new T.ExtrudeGeometry(shape, { depth: 2 * hw, bevelEnabled: false }), lam(0x5a5d64));
      m.position.set(x0, 0, z0 - hw); m.castShadow = m.receiveShadow = true; lessonGroup.add(m);
      for (const sgn of [1, -1]) {   // painted edge lines following the slope
        const pitch = Math.atan(h / up), sl = Math.hypot(up, h), zz = z0 + sgn * (hw - 0.3);
        for (const [len, x, y, rz] of [[sl, x0 + up / 2, h / 2, pitch], [top, x0 + up + top / 2, h, 0], [sl, x0 + up + top + up / 2, h / 2, -pitch]]) {
          const line = new T.Mesh(new T.BoxGeometry(len, 0.02, 0.2), MAT.white);
          line.position.set(x, y + 0.03, zz); line.rotation.z = rz; lessonGroup.add(line);
        }
      }
      const pitch = Math.atan(h / up);
      const hold = addBox({ x: x0 + 13, z: z0, th: Math.PI / 2, hw: 2.3, hl: 4.2, y: groundH(x0 + 13, z0), pitch });
      const end = addBox({ x: 364, z: z0, th: Math.PI / 2, hw: 2.3, hl: 4.2 });
      return { start: { x: 268, z: z0, th: Math.PI / 2 }, steps: [
        { type: 'ready', text: READY_TXT() },
        { type: 'stop', box: hold, park: true, text: TL`Drive onto the slope and stop inside the yellow box. Hold the car there: ${SECURE_TXT()}.` },
        { type: 'cp', x: x0 + up + top / 2, z: z0, r: 3, hill: true, text: tx(
          'Hill start: hold the brake (S), select D, then move to the gas (W) and pull away without rolling back.',
          'Hill start: clutch down (Shift), select 1st, press the gas (W), bring the clutch up — and release the parking brake (Space) as the car starts to pull. Do not roll back.') },
        { type: 'stop', box: end, park: true, text: TL`Go down the far side under control — brake to stay below 20 km/h. Stop in the box, then ${SECURE_TXT()}.` },
      ] };
    } },
  { id: 'city', title: '6 · City exam', desc: 'Follow the route through traffic: obey lights and signs, give way to pedestrians, signal every turn.', build() {
      const route = [[-2, 0], [-1, 0], [0, 0], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-2, 0]];
      const st = [{ type: 'ready', text: READY_TXT() + tr(' Watch for speed-limit signs, STOP signs and zebra crossings.') }];
      for (let k = 1; k < route.length - 1; k++) {
        const a = route[k], b = route[k + 1], p = route[k - 1];
        const d = [b[0] - a[0], b[1] - a[1]], d0 = [a[0] - p[0], a[1] - p[1]], l = laneVec(d);
        const cross = d0[0] * d[1] - d0[1] * d[0];
        const text = tr(cross < 0 ? 'At the next junction turn LEFT. Signal first (Q) and give way to oncoming traffic.'
          : cross > 0 ? 'At the next junction turn RIGHT. Signal first (E) and slow down for the corner.'
          : 'Go straight on at the junction. Stop if the light is red.');
        const extra = (STOP_NODES.has(a[0] + ',' + a[1]) ? tr(' It has a STOP sign: come to a complete stop first.') : '')
          + (ZONE30.has(segKey({ i: p[0], j: p[1] }, { i: a[0], j: a[1] })) ? tr(' 30 zone ahead — give way at the zebra crossing.') : '');
        const mx = (a[0] + b[0]) / 2 * S + l[0] * LANE, mz = (a[1] + b[1]) / 2 * S + l[1] * LANE;
        if (k === route.length - 2) {
          const box = addBox({ x: mx + l[0] * 0.6, z: mz + l[1] * 0.6, th: Math.atan2(d[0], d[1]), hw: 2.2, hl: 5 });
          st.push({ type: 'stop', box, park: true, text: text + extra + TL` Then pull over in the yellow box, stop and ${SECURE_TXT()}.` });
        } else st.push({ type: 'cp', x: mx, z: mz, r: 4.5, text: text + extra });
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
  cones = []; statics = []; ramp = null; rollDist = 0; lastH = 0;
  const built = l.build();
  steps = built.steps; stepIdx = 0; startPose = built.start;
  Object.assign(car, built.start, { v: 0, steer: 0, gear: manual ? 'N' : 'P', engine: false, belt: false, signal: 0, clutch: 0, hand: manual, rpm: 0 });
  score = 100; violations = {}; lastPen = {}; wrongT = 0; curNode = null; activeBox = null;
  curLimit = limitAt(car.x, car.z) || 50; limitSince = clock; stopNode = null;
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
  $('stepNum').textContent = steps.length ? TL`Step ${Math.min(stepIdx + 1, steps.length)} / ${steps.length}` : tr('Free drive');
  $('stepText').textContent = s ? s.text : tr('Drive wherever you like. Obey the lights, keep to your side of the road and signal your turns.');
  ring.visible = !!s && s.type === 'cp';
  if (ring.visible) { ring.position.set(s.x, groundH(s.x, s.z), s.z); ring.children[0].scale.set(s.r, 1, s.r); }
  activeBox = s && s.type === 'stop' ? s.box : null;
}
function stepDone(s) {
  switch (s.type) {
    case 'belt': return car.belt;
    case 'engine': return car.engine;
    case 'drive': return inDriveGear();
    case 'secure': return isSecured() && Math.abs(car.v) < 0.15;
    case 'reverse': return car.gear === 'R';
    case 'ready': return car.belt && car.engine && inDriveGear();
    case 'cp': return Math.hypot(car.x - s.x, car.z - s.z) < s.r;
    case 'stop': return inBox(s.box) && Math.abs(car.v) < 0.15 && (!s.park || isSecured());
  }
}
function finish(passed, why) {
  state = 'end';
  $('hud').hidden = true; $('result').hidden = false;
  $('resTitle').textContent = tr(passed ? 'Lesson passed' : 'Lesson failed');
  $('resTitle').className = passed ? 'pass' : 'fail';
  $('resText').textContent = TL`${tr(why)} Final score: ${Math.max(0, score)} / 100 (pass mark ${PASS_SCORE}).`;
  const names = Object.keys(violations);
  $('resList').innerHTML = names.length ? '' : `<li><span>${tr('No mistakes — clean drive!')}</span></li>`;
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
  const el = document.createElement('div'); el.className = 'toast ' + (cls || ''); el.textContent = tr(text);
  $('toasts').appendChild(el);
  while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
  setTimeout(() => el.remove(), 3500);
}
function penalize(name, pts, cooldown) {
  if (clock - (lastPen[name] ?? -99) < cooldown) return;
  lastPen[name] = clock;
  score -= pts;
  const label = tr(name);   // shown and listed in the player's language
  const v = violations[label] || (violations[label] = { n: 0, pts: 0 }); v.n++; v.pts += pts;
  toast(`${label}  −${pts}`);
  beep(180, 0.18);
  if (steps.length && score <= FAIL_SCORE) finish(false, 'Too many serious mistakes.');
}

// ---------------------------------------------------------------- controls
function setGear(g) {
  if (g === car.gear || !gearList().includes(g)) return;
  if (manual) {
    if (car.engine && car.clutch < 0.7) return toast('Press the clutch (Shift) to change gear', 'info');
    if (MG[g] && g !== 'R') {
      if (car.v < -1) return toast('Stop before selecting a forward gear', 'info');
      if (car.v > MG[g].max * 1.15) return toast(TL`Too fast for gear ${g}`, 'info');
    }
  }
  if (g === 'P' && Math.abs(car.v) > 0.5) return toast('Stop before selecting P', 'info');
  if (g === 'R' && car.v > 1) return toast('Stop before selecting R', 'info');
  if (g === 'D' && car.v < -1) return toast('Stop before selecting D', 'info');
  car.gear = g; beep(520, 0.04);
}
const shift = dir => { const l = gearList(); setGear(l[clamp(l.indexOf(car.gear) + dir, 0, l.length - 1)]); };
const toggleHand = () => { car.hand = !car.hand; beep(car.hand ? 300 : 420, 0.05); };
function toggleEngine() {
  if (!car.engine && manual && car.gear !== 'N' && car.clutch < 0.7 && !inp.clutch) return toast('Select neutral or hold the clutch to start', 'info');
  if (!car.engine && !manual && car.gear !== 'P' && car.gear !== 'N') return toast('Select P or N to start the engine', 'info');
  car.engine = !car.engine;
}
const toggleBelt = () => { car.belt = !car.belt; beep(700, 0.05); };
const toggleSignal = s => { car.signal = car.signal === s ? 0 : s; };
function togglePause() {
  if (state === 'run') { state = 'pause'; $('pause').hidden = false; }
  else if (state === 'pause') { state = 'run'; $('pause').hidden = true; }
}
const HOLD = { KeyW: 'gas', ArrowUp: 'gas', KeyS: 'brake', ArrowDown: 'brake', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', ShiftLeft: 'clutch', ShiftRight: 'clutch', KeyH: 'horn' };
window.addEventListener('keydown', e => {
  if (HOLD[e.code]) { keys[HOLD[e.code]] = true; e.preventDefault(); return; }
  if (e.code === 'Space') e.preventDefault();   // parking brake, not "click the focused button"
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
    case 'KeyV': mirrorsOn = !mirrorsOn; break;
    case 'KeyR': startLesson(lesson); break;
    case 'Space': toggleHand(); break;
    case 'KeyN': case 'Digit0': setGear('N'); break;
    case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': case 'Digit5':
      setGear(manual ? e.code.slice(5) : AUTO_GEARS[+e.code.slice(5) - 1]); break;
  }
});
window.addEventListener('keyup', e => { if (HOLD[e.code]) keys[HOLD[e.code]] = false; if (e.code === 'Space') e.preventDefault(); });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

// ---------------------------------------------------------------- audio (tiny synth, no assets)
let actx = null, engOsc = null, engGain = null, hornGain = null, muted = false;
function initAudio() {
  if (actx) return;
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    engOsc = actx.createOscillator(); engOsc.type = 'sawtooth';
    const lp = actx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
    engGain = actx.createGain(); engGain.gain.value = 0;
    engOsc.connect(lp).connect(engGain).connect(actx.destination); engOsc.start();
    hornGain = actx.createGain(); hornGain.gain.value = 0; hornGain.connect(actx.destination);
    for (const f of [415, 520]) { const o = actx.createOscillator(); o.type = 'square'; o.frequency.value = f; o.connect(hornGain); o.start(); }
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
  hornGain.gain.setTargetAtTime(inp.horn && state === 'run' && !muted ? 0.05 : 0, actx.currentTime, 0.01);
  const on = car.engine && state === 'run' && !muted;
  engGain.gain.setTargetAtTime(on ? 0.035 + inp.gas * 0.025 : 0, actx.currentTime, 0.08);
  engOsc.frequency.setTargetAtTime(manual ? 30 + car.rpm / 38 : 48 + Math.abs(car.v) * 5.5 + inp.gas * 18, actx.currentTime, 0.1);
}

// ---------------------------------------------------------------- steering wheel, pedals and game controllers
// Uses the browser Gamepad API. Each control is learned once on the setup screen ("move it and hold"),
// stored per device, and read every frame as an analog value next to the keyboard.
const inp = { steer: 0, gas: 0, brake: 0, clutch: 0, clutchAxis: false, horn: false, wheel: false };
const AXES = ['steer', 'gas', 'brake', 'clutch'];
const BTNS = ['gearUp', 'gearDown', 'gearR', 'gear1', 'gear2', 'gear3', 'gear4', 'gear5', 'sigL', 'sigR', 'horn', 'hand', 'engine', 'belt', 'cam', 'pause'];
const CTRL_NAMES = {
  steer: 'Steering', gas: 'Accelerator', brake: 'Brake', clutch: 'Clutch', gearUp: 'Gear up', gearDown: 'Gear down',
  gearR: 'Reverse (H-shifter)', gear1: '1st (H-shifter)', gear2: '2nd (H-shifter)', gear3: '3rd (H-shifter)', gear4: '4th (H-shifter)', gear5: '5th (H-shifter)',
  sigL: 'Left indicator', sigR: 'Right indicator', horn: 'Horn', hand: 'Parking brake', engine: 'Engine', belt: 'Seatbelt', cam: 'Camera', pause: 'Pause',
};
// Xbox / PlayStation style pads report the "standard" layout, so they work without setup.
const STANDARD_MAP = { axes: { steer: { axis: 0, rest: 0, full: -1 } }, trig: { gas: 7, brake: 6 },
  btn: { gearUp: 5, gearDown: 4, sigL: 14, sigR: 15, horn: 3, hand: 1, engine: 9, belt: 2, cam: 12, pause: 8 } };
let pad = null, padMap = null, prevBtn = [], learning = null;
const mapKey = id => 'driveready.wheel.' + id;
function loadMap(gp) {
  try { const m = JSON.parse(localStorage.getItem(mapKey(gp.id)) || 'null'); if (m) return m; } catch (e) { /* storage unavailable */ }
  return gp.mapping === 'standard' ? JSON.parse(JSON.stringify(STANDARD_MAP)) : { axes: {}, trig: {}, btn: {} };
}
function saveMap() { try { localStorage.setItem(mapKey(pad.id), JSON.stringify(padMap)); } catch (e) { /* storage unavailable */ } }
function findPad() {
  const list = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
  // prefer a device with many axes (a wheel) over a plain pad
  return list.sort((a, b) => b.axes.length - a.axes.length)[0] || null;
}
window.addEventListener('gamepadconnected', e => { toast(TL`Connected: ${e.gamepad.id.slice(0, 40)}`, 'good'); renderWheelUI(); });
window.addEventListener('gamepaddisconnected', () => { pad = null; renderWheelUI(); });

function axisValue(gp, a) {   // 0..1 for pedals, -1..1 for steering (+ = left)
  const v = gp.axes[a.axis]; if (v === undefined) return 0;
  const f = (v - a.rest) / ((a.full - a.rest) || 1);
  return a.center ? clamp(f, -1, 1) : clamp(f, 0, 1);
}
const btnDown = (gp, i) => i !== undefined && gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.5);
const pedal = v => v < 0.04 ? 0 : v;   // small dead zone so a resting pedal reads 0

function pollInput() {
  const gp = findPad();
  if (gp && (!pad || pad.id !== gp.id)) { padMap = loadMap(gp); prevBtn = []; }
  pad = gp;
  let steer = 0, gas = 0, brake = 0, clutch = 0, clutchAxis = false, horn = false;
  if (gp && padMap && !learning) {
    const ax = padMap.axes, tg = padMap.trig || {}, bt = padMap.btn;
    if (ax.steer) { const v = axisValue(gp, ax.steer); steer = Math.abs(v) < 0.02 ? 0 : v; }
    if (ax.gas) gas = pedal(axisValue(gp, ax.gas)); else if (tg.gas !== undefined && gp.buttons[tg.gas]) gas = pedal(gp.buttons[tg.gas].value);
    if (ax.brake) brake = pedal(axisValue(gp, ax.brake)); else if (tg.brake !== undefined && gp.buttons[tg.brake]) brake = pedal(gp.buttons[tg.brake].value);
    if (ax.clutch) { clutch = pedal(axisValue(gp, ax.clutch)); clutchAxis = true; }
    horn = btnDown(gp, bt.horn);
    const pressed = k => btnDown(gp, bt[k]) && !prevBtn[bt[k]];
    if (state === 'run') {
      if (pressed('gearUp')) shift(1);
      if (pressed('gearDown')) shift(-1);
      if (pressed('sigL')) toggleSignal(1);
      if (pressed('sigR')) toggleSignal(-1);
      if (pressed('hand')) toggleHand();
      if (pressed('engine')) toggleEngine();
      if (pressed('belt')) toggleBelt();
      if (pressed('cam')) camMode = (camMode + 1) % 3;
      // H-shifter: a gear is selected while its slot is held; back to neutral when released
      const hGear = ['gearR', 'gear1', 'gear2', 'gear3', 'gear4', 'gear5'].find(k => btnDown(gp, bt[k]));
      const hMapped = ['gearR', 'gear1', 'gear2', 'gear3', 'gear4', 'gear5'].some(k => bt[k] !== undefined);
      if (hGear) { const g = hGear === 'gearR' ? 'R' : manual ? hGear.slice(4) : 'D'; if (car.gear !== g) setGear(g); }
      else if (hMapped && manual && car.gear !== 'N' && MG[car.gear]) setGear('N');
    }
    if (pressed('pause') && (state === 'run' || state === 'pause')) togglePause();
    prevBtn = gp.buttons.map(b => b.pressed || b.value > 0.5);
  }
  // keyboard and on-screen pads still work alongside the device
  inp.steer = steer || ((keys.left ? 1 : 0) - (keys.right ? 1 : 0));
  inp.wheel = !!steer || (!!(gp && padMap && padMap.axes.steer) && !keys.left && !keys.right);
  inp.gas = Math.max(gas, keys.gas ? 1 : 0);
  inp.brake = Math.max(brake, keys.brake ? 1 : 0);
  inp.clutchAxis = clutchAxis && !keys.clutch;
  inp.clutch = Math.max(clutch, keys.clutch ? 1 : 0);
  inp.horn = horn || keys.horn;
  if (learning) stepLearning(gp);
  if (!$('wheel').hidden) updateWheelLive(gp);
}

// ---- learning a control: snapshot everything, then pick whatever moves the most
function startLearning(ctrl) {
  const gp = findPad(); if (!gp) return;
  learning = { ctrl, base: [...gp.axes], baseBtn: gp.buttons.map(b => b.pressed || b.value > 0.5), axis: -1, peak: 0, t: 0, last: performance.now() };
  renderWheelUI();
}
function stepLearning(gp) {
  const L = learning, now = performance.now(), dt = (now - L.last) / 1000; L.last = now;
  if (!gp) return;
  if (BTNS.includes(L.ctrl)) {
    const i = gp.buttons.findIndex((b, k) => (b.pressed || b.value > 0.5) && !L.baseBtn[k]);
    if (i >= 0) { padMap.btn[L.ctrl] = i; finishLearning(); }
    return;
  }
  let best = -1, dev = 0;
  gp.axes.forEach((v, k) => { const d = Math.abs(v - L.base[k]); if (d > dev) { dev = d; best = k; } });
  if (L.axis < 0) {
    if (dev > (L.ctrl === 'steer' ? 0.12 : 0.35)) { L.axis = best; L.peak = gp.axes[best]; }
    else if (L.ctrl !== 'steer') {   // pedals on some pads are analog buttons rather than axes
      const i = gp.buttons.findIndex((b, k) => b.value > 0.5 && !L.baseBtn[k]);
      if (i >= 0) { delete padMap.axes[L.ctrl]; padMap.trig = padMap.trig || {}; padMap.trig[L.ctrl] = i; finishLearning(); }
    }
    return;
  }
  const v = gp.axes[L.axis];
  if (Math.abs(v - L.base[L.axis]) > Math.abs(L.peak - L.base[L.axis]) + 0.01) { L.peak = v; L.t = 0; } else L.t += dt;
  if (L.t > 0.8) {   // held steady at the end of travel
    const a = { axis: L.axis, rest: L.base[L.axis], full: L.peak };
    if (L.ctrl === 'steer') a.center = true;
    if (padMap.trig) delete padMap.trig[L.ctrl];
    padMap.axes[L.ctrl] = a; finishLearning();
  }
}
function finishLearning() { learning = null; saveMap(); beep(880, 0.08); renderWheelUI(); }

// ---- setup screen
function renderWheelUI() {
  if ($('wheel').hidden) return;
  const gp = findPad();
  $('wheelDev').textContent = gp ? gp.id : tr('No wheel or controller found. Plug it in and press any button on it.');
  $('wheelRows').innerHTML = '';
  if (!gp || !padMap) return;
  for (const c of [...AXES, ...BTNS]) {
    const row = document.createElement('div'); row.className = 'wrow';
    const isAxis = AXES.includes(c), m = isAxis ? (padMap.axes[c] || (padMap.trig && padMap.trig[c] !== undefined && { trig: padMap.trig[c] })) : padMap.btn[c];
    const label = m === undefined || m === false ? tr('not set') : isAxis ? (m.trig !== undefined ? TL`button ${m.trig}` : TL`axis ${m.axis}`) : TL`button ${m}`;
    row.innerHTML = `<span class="wname"></span><span class="wval"></span>${isAxis ? '<span class="wbar"><i></i></span>' : ''}<button class="btn wset"></button>`;
    row.querySelector('.wname').textContent = tr(CTRL_NAMES[c]);
    row.querySelector('.wval').textContent = learning && learning.ctrl === c ? tr(c === 'steer' ? 'Turn the wheel fully LEFT and hold…' : isAxis ? 'Press it all the way and hold…' : 'Press the button…') : label;
    const b = row.querySelector('.wset'); b.textContent = tr('Set'); b.onclick = () => startLearning(c);
    row.dataset.ctrl = c; $('wheelRows').appendChild(row);
  }
}
function updateWheelLive(gp) {
  if (!gp || learning) return;
  for (const row of $('wheelRows').children) {
    const c = row.dataset.ctrl, bar = row.querySelector('.wbar i'); if (!bar) { row.classList.toggle('lit', btnDown(gp, padMap.btn[c])); continue; }
    const v = inp[c] || 0;
    bar.style.left = c === 'steer' ? (50 - Math.max(0, v) * 50) + '%' : '0';
    bar.style.width = (c === 'steer' ? Math.abs(v) * 50 : v * 100) + '%';
  }
}
function openWheel() { $('wheel').hidden = false; renderWheelUI(); }

// ---------------------------------------------------------------- player update
function updateCar(dt) {
  const px = car.x, pz = car.z, pth = car.th;
  const st = inp.steer, vabs = Math.abs(car.v), gas = inp.gas > 0.02;
  const maxSt = Math.min(0.6, Math.atan(WB * 7 / Math.max(vabs * vabs, 1)));   // limits cornering grip at speed
  const rate = (inp.wheel ? 6 : st ? 1.5 : 3) * dt;   // a real wheel is followed almost directly
  car.steer = clamp(car.steer + clamp(st * maxSt - car.steer, -rate, rate), -maxSt, maxSt);

  let acc = 0;
  const hint = text => { if (clock - (lastPen._hint ?? -9) > 4) { lastPen._hint = clock; toast(text, 'info'); } };
  if (gas && car.hand && Math.abs(car.v) < 1) hint('Release the parking brake (Space)');
  if (manual) {
    if (inp.clutchAxis) car.clutch = inp.clutch;   // real pedal: exactly where the foot is
    else car.clutch = inp.clutch ? Math.min(1, car.clutch + dt * 8) : Math.max(0, car.clutch - dt * 1.6);   // key: pedal comes up gradually
    const g = MG[car.gear], engage = 1 - car.clutch;
    let rpm = car.engine ? 800 + inp.gas * 2600 : 0;
    if (g && car.engine) {
      const dirn = car.gear === 'R' ? -1 : 1, vg = car.v * dirn;   // speed in the direction the gear drives
      if (car.clutch < 0.15 && vg < (inp.gas > 0.25 ? g.gasMin : g.idleMin)) {
        car.engine = false; rpm = 0; beep(120, 0.3);
        toast(Math.abs(car.v) < 1 ? 'Engine stalled — use the clutch when stopping, and gas when moving off' : TL`Engine stalled — too slow for gear ${car.gear}`, 'info');
        if (steps.length) penalize('Stalled the engine', 5, 2);
      } else {
        if (gas) acc = dirn * g.acc * inp.gas * (1 - vg / g.max) * engage * clamp(vg / (0.3 * g.max), g.low, 1);
        else if (g.creep && vg < g.creep) acc = dirn * engage;                                  // idles along in 1st / reverse
        else acc = -dirn * engage * g.brake * (1 + 3 * Math.max(0, vg / g.max - 1));           // engine braking
        if (car.clutch < 0.5) rpm = 800 + Math.max(0, vg) / g.max * 5700;
      }
    } else if (gas && !car.engine) hint('Engine is off — press I');
    car.rpm += (rpm - car.rpm) * Math.min(1, dt * 8);
  } else if (car.engine && gas) {
    if (car.gear === 'D') acc = 3.6 * inp.gas * (1 - car.v / 45);
    else if (car.gear === 'R') acc = -2.5 * inp.gas * (1 + car.v / 9);
    else if (clock - (lastPen._hint ?? -9) > 4) { lastPen._hint = clock; toast('Select D or R to move', 'info'); }
  } else if (!car.engine && gas && clock - (lastPen._hint ?? -9) > 4) { lastPen._hint = clock; toast('Engine is off — press I', 'info'); }
  const slope = slopeAhead();
  car.v += (acc - 9.81 * slope / Math.hypot(1, slope)) * dt;
  const dec = (0.35 + 0.0005 * vabs * vabs + inp.brake * 9 + (car.hand ? 12 : 0) + (car.gear === 'P' ? 20 : 0)) * dt;
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
  if (!crash && Math.abs(car.v) > 0.5) for (const p of peds) {
    const [lx, lz] = toLocal(car, p.x, p.z);
    if (Math.abs(lx) < CW + 0.25 && Math.abs(lz) < CL + 0.25) { crash = 'Hit a pedestrian'; break; }
  }
  if (crash) {
    const hard = Math.abs(car.v) > 0.6;
    car.x = px; car.z = pz; car.th = pth; car.v = 0;
    if (hard) penalize(crash, crash === 'Hit a pedestrian' ? 60 : 20, 2.5);
  }
  if (ramp) {
    const hNow = groundH(car.x, car.z);
    if (lastH > 0.5 && hNow === 0) penalize('Drove off the ramp', 10, 2);
    lastH = hNow;
    const s = steps[stepIdx];
    if (s && s.hill) {   // hill start: rolling back more than about half a metre is a fault
      if (car.v < -0.05) rollDist -= car.v * dt; else if (car.v > 0.3) rollDist = 0;
      if (rollDist > 0.5) { penalize('Rolled back on the hill', 10, 3); rollDist = 0; }
    }
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
  const here = limitAt(car.x, car.z);
  if (here && here !== curLimit) { curLimit = here; limitSince = clock; }
  const limit = curLimit;
  if (Math.abs(car.v) > 1.5 && !car.belt) penalize('Driving without a seatbelt', 10, 20);
  if (kmh > limit + 3 && clock - limitSince > 2.5) penalize('Speeding', 5, 4);   // short grace to slow down after a sign
  if (!isDrivable(car.x + fx * 1.3, car.z + fz * 1.3) || !isDrivable(car.x - fx * 1.3, car.z - fz * 1.3))
    penalize(inLot() ? 'Left the training area' : 'Left the roadway', 5, 3);
  if (inLot()) { curNode = null; wrongT = 0; return limit; }

  // junction entry / exit: red lights and turn signals
  const i = Math.round(car.x / S), j = Math.round(car.z / S);
  const n = nodes.get(nodeKey(i, j));
  const inside = n && Math.abs(car.x - n.x) < W / 2 && Math.abs(car.z - n.z) < W / 2 ? n : null;
  if (!inside && n && n.stop && Math.abs(car.v) < 0.3 && Math.max(Math.abs(car.x - n.x), Math.abs(car.z - n.z)) < W / 2 + 10) { stopNode = n; stopTime = clock; }
  if (inside && !curNode) {
    if (inside.stop && car.v > 0.5 && !(stopNode === inside && clock - stopTime < 8)) penalize('Did not stop at a STOP sign', 15, 3);
    const px = car.x - fx * car.v * dt * 2;
    const axis = Math.abs(px - inside.x) >= W / 2 ? 'x' : 'z';
    if (inside.lights && car.v > 0.5 && lightState(inside, axis) === 'r') penalize('Ran a red light', 25, 3);
    entryTh = car.th; entrySig = car.signal;
  } else if (!inside && curNode) {
    let dth = car.th - entryTh; dth = Math.atan2(Math.sin(dth), Math.cos(dth));
    if (Math.abs(dth) > 0.8) {
      const dir = dth > 0 ? 1 : -1;
      if (entrySig !== dir) penalize(dir > 0 ? 'No left turn signal' : 'No right turn signal', 5, 1);
      if (car.signal === dir) car.signal = 0;   // self-cancelling indicator
    }
  }
  curNode = inside;

  // zebra crossings: do not drive onto one while someone is crossing in or near your path
  for (const cw of crosswalks) {
    const x = cw.ax === 'x', along = x ? car.x - cw.x : car.z - cw.z, lat = x ? car.z - cw.z : car.x - cw.x;
    if (Math.abs(along) < 3.8 && Math.abs(lat) < W / 2 && Math.abs(car.v) > 0.8 &&
        peds.some(p => p.cw === cw && p.walking && Math.abs(p.u) < W / 2 && Math.abs(p.u - lat) < 3.5))
      penalize('Did not give way to a pedestrian', 15, 5);
  }

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
  const fx = Math.sin(car.th), fz = Math.cos(car.th), gh = groundH(car.x, car.z);
  camera.up.set(0, 1, 0);
  if (state === 'menu') {
    const a = clock * 0.05;
    camera.position.set(Math.cos(a) * 150, 85, Math.sin(a) * 150); camera.lookAt(0, 0, 0);
    camTarget.set(0, 0, 0);
  } else if (camMode === 1) {
    const ox = side * 0.38;   // driver sits on the side nearest the road centre
    camera.position.set(car.x + fz * ox + fx * 0.05, 1.27 + gh, car.z - fx * ox + fz * 0.05);
    camera.lookAt(camera.position.x + fx * 10, 1.1 + gh + slopeAhead() * 10, camera.position.z + fz * 10);
    camTarget.set(car.x, 0, car.z);
  } else if (camMode === 2) {
    camera.up.set(fx, 0, fz);
    camera.position.set(car.x, 30 + gh, car.z); camera.lookAt(car.x, 0, car.z);
    camTarget.set(car.x, 0, car.z);
  } else {
    const k = 1 - Math.exp(-6 * dt);
    camera.position.x += (car.x - fx * 8 - camera.position.x) * k;
    camera.position.z += (car.z - fz * 8 - camera.position.z) * k;
    camera.position.y += (3.3 + gh - camera.position.y) * k;
    camera.lookAt(car.x + fx * 3, 1.2 + gh, car.z + fz * 3);
    camTarget.set(car.x, 0, car.z);
  }
  sun.position.set(camTarget.x + 55, 100, camTarget.z + 35);
  sun.target.position.copy(camTarget);
}

// ---------------------------------------------------------------- HUD
let gearBtns = [];
function applyGearbox() {   // rebuild the selector for the chosen transmission
  $('gears').innerHTML = '';
  gearBtns = gearList().map(g => { const b = document.createElement('button'); b.textContent = g; b.onclick = () => setGear(g); $('gears').appendChild(b); return b; });
  document.body.classList.toggle('manual', manual);
  for (const o of $('gearSel').children) o.classList.toggle('on', (o.dataset.manual === '1') === manual);
}
const mapCtx = $('map').getContext('2d');
function updateHud(limit, blinkOn) {
  const kmh = Math.round(Math.abs(car.v) * 3.6);
  $('speed').textContent = kmh; $('speed').classList.toggle('over', kmh > limit + 3);
  $('limit').textContent = limit;
  $('score').textContent = Math.max(0, score);
  gearBtns.forEach((b, k) => b.classList.toggle('on', gearList()[k] === car.gear));
  $('hand').classList.toggle('on', car.hand);
  if (manual) { $('rpmFill').style.width = clamp(car.rpm / 6500, 0, 1) * 100 + '%'; $('rpmFill').classList.toggle('red', car.rpm > 5600); }
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
  g.fillStyle = '#fff'; for (const cw of crosswalks) g.fillRect(X(cw.x) - (cw.ax === 'x' ? 2 : 5), Z(cw.z) - (cw.ax === 'x' ? 5 : 2), cw.ax === 'x' ? 4 : 10, cw.ax === 'x' ? 10 : 4);
  g.fillStyle = '#7dffa8'; for (const p of peds) if (p.walking) g.fillRect(X(p.x) - 2, Z(p.z) - 2, 4, 4);
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
  pollInput();
  if (state !== 'pause' && state !== 'end') {
    clock += dt;
    const blinkOn = (clock * 2.6) % 1 < 0.5;
    updateLights();
    updateTraffic(dt, blinkOn);
    updatePeds(dt);
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
    playerMesh.position.set(car.x, groundH(car.x, car.z), car.z);
    playerMesh.rotation.y = car.th; playerMesh.rotation.x = -Math.atan(slopeAhead());
    const u = playerMesh.userData;
    u.fw.forEach(p => { p.rotation.y = car.steer; });
    u.wheel.rotation.z = -car.steer * 4;
    setCarLamps(playerMesh, inp.brake > 0.05 || car.gear === 'P' || car.hand, car.signal, blinkOn);
    updateAudio();
  }
  updateCamera(dt);
  renderer.render(scene, camera);
  const showMirrors = mirrorsOn && camMode !== 2 && (state === 'run' || state === 'pause');
  document.body.classList.toggle('mirrors', showMirrors);
  if (showMirrors) {
    renderer.shadowMap.autoUpdate = false;   // reuse the shadows from the main view
    for (const m of mirrors) { m.quad.visible = m.frame.visible = m.show; if (m.show) { renderer.setRenderTarget(m.rt); renderer.render(scene, m.cam); } }
    renderer.setRenderTarget(null); renderer.shadowMap.autoUpdate = true;
    renderer.autoClear = false; renderer.render(overlay, overlayCam); renderer.autoClear = true;
  }
}

// ---------------------------------------------------------------- UI wiring
const HELP = [   // [keys, what they do]
  ['<kbd>W</kbd>/<kbd>↑</kbd>', 'accelerate'], ['<kbd>S</kbd>/<kbd>↓</kbd>', 'brake'], ['<kbd>A</kbd> <kbd>D</kbd> / <kbd>←</kbd> <kbd>→</kbd>', 'steer'],
  ['<kbd>B</kbd>', 'seatbelt'], ['<kbd>I</kbd>', 'engine'], ['<kbd>Z</kbd> <kbd>X</kbd>', 'gear down / up'], ['<kbd>Shift</kbd>', 'clutch (manual gearbox)'],
  ['<kbd>Q</kbd> <kbd>E</kbd>', 'left / right turn signal'], ['<kbd>Space</kbd>', 'parking brake'], ['<kbd>H</kbd>', 'horn'], ['<kbd>C</kbd>', 'camera'],
  ['<kbd>V</kbd>', 'mirrors on / off'], ['<kbd>R</kbd>', 'restart lesson'], ['<kbd>Esc</kbd>', 'pause'], ['<kbd>M</kbd>', 'sound on / off'],
];
function applyLanguage() {   // (re)draw every fixed text in the chosen language
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-tr]')) { el.dataset.en = el.dataset.en || el.textContent; el.textContent = tr(el.dataset.en); }
  $('lessons').innerHTML = '';
  for (const l of LESSONS) {
    const b = document.createElement('button'); b.className = 'lesson';
    b.innerHTML = '<b></b><span></span>'; b.children[0].textContent = tr(l.title); b.children[1].textContent = tr(l.desc);
    b.onclick = () => startLesson(l); $('lessons').appendChild(b);
  }
  $('help').innerHTML = HELP.map(([k, what]) => `<div>${k} ${tr(what)}</div>`).join('');
  for (const o of $('langSel').children) o.classList.toggle('on', o.dataset.lang === lang);
}
try { if (localStorage.getItem('driveready.lang') === 'ta') lang = 'ta'; } catch (e) { /* storage unavailable */ }
for (const b of $('langSel').children) b.onclick = () => {
  lang = b.dataset.lang;
  try { localStorage.setItem('driveready.lang', lang); } catch (e) { /* storage unavailable */ }
  applyLanguage();
};
applyLanguage();
$('wheelBtn').onclick = openWheel;
$('wheelDone').onclick = () => { learning = null; $('wheel').hidden = true; };
$('wheelReset').onclick = () => { if (pad) { try { localStorage.removeItem(mapKey(pad.id)); } catch (e) { /* storage unavailable */ } padMap = loadMap(pad); renderWheelUI(); } };
for (const b of $('sideSel').children) b.onclick = () => {
  side = +b.dataset.side;
  for (const o of $('sideSel').children) o.classList.toggle('on', o === b);
  try { localStorage.setItem('driveready.side', side); } catch (e) { /* storage unavailable */ }
  buildWorld();
};
$('sigL').onclick = () => toggleSignal(1); $('sigR').onclick = () => toggleSignal(-1);
$('belt').onclick = toggleBelt; $('engine').onclick = toggleEngine; $('hand').onclick = toggleHand;
$('cam').onclick = () => { camMode = (camMode + 1) % 3; };
$('pauseBtn').onclick = togglePause; $('resume').onclick = togglePause;
$('restart').onclick = $('retry').onclick = () => startLesson(lesson);
$('toMenu').onclick = $('resMenu').onclick = toMenu;
for (const p of document.querySelectorAll('.pad, .hold')) {
  const k = p.dataset.key, set = v => e => { keys[k] = v; e.preventDefault(); };
  p.addEventListener('pointerdown', set(true)); p.addEventListener('pointerup', set(false));
  p.addEventListener('pointerleave', set(false)); p.addEventListener('pointercancel', set(false));
}
if ('ontouchstart' in window || navigator.maxTouchPoints > 0) document.body.classList.add('touch');

try { const s = +localStorage.getItem('driveready.side'); if (s === 1 || s === -1) side = s; } catch (e) { /* storage unavailable */ }
for (const o of $('sideSel').children) o.classList.toggle('on', +o.dataset.side === side);
try { manual = localStorage.getItem('driveready.manual') === '1'; } catch (e) { /* storage unavailable */ }
for (const b of $('gearSel').children) b.onclick = () => {
  manual = b.dataset.manual === '1';
  try { localStorage.setItem('driveready.manual', manual ? '1' : '0'); } catch (e) { /* storage unavailable */ }
  applyGearbox();
};
applyGearbox();
buildWorld();
window.__sim = { car, keys, tr, get lang() { return lang; }, get state() { return state; }, get score() { return score; }, get stepIdx() { return stepIdx; }, get traffic() { return traffic; }, get peds() { return peds; }, get crosswalks() { return crosswalks; }, get violations() { return violations; } };
requestAnimationFrame(frame);
})();
