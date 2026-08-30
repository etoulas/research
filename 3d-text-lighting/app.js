/* 3D stroke-font text renderer with a draggable point light. Canvas 2D only. */

// ---------------------------------------------------------------- state ----
const S = {
  text: 'HELLO',
  // The font is generated from the grid: `capSq` squares per cap height, and a
  // stroke exactly `strokeSq` squares wide. Both are whole numbers, which is
  // what puts every stroke edge on a grid line.
  capSq: 8,
  strokeSq: 1,
  depth: 0.42,      // total extrusion along z
  lightZ: 2.6,
  intensity: 1.15,
  softness: 12,     // shadow blur radius, px
  grid: true,       // squared-paper guides in the plane of the letter fronts
  flat: false,      // head-on, near-orthographic: what you'd copy from
  yaw: -0.30,
  pitch: 0.22,
  light: { x: -1.2, y: 1.8, z: 2.6 },
  color: '#e8b04b',
};

const FLOOR_Y = -0.45;
// Camera distance. Pushing the eye far away makes the projection effectively
// orthographic, which is what the flat copying view wants: no perspective means
// the grid squares stay square and the letters measure 1:1 against them.
let EYE_D = 6.2;
const EYE_NEAR_D = 6.2, EYE_FLAT_D = 220;
const NEAR = 0.6;      // near clip in camera space

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const shadowCv = document.createElement('canvas');
const sctx = shadowCv.getContext('2d');

let W = 0, H = 0, DPR = 1;
let FOCAL = 600, CX = 0, CY = 0;
// where the lamp should sit on screen, as a fraction of the canvas. Kept stable
// across re-fits (new text, new depth) so the handle never wanders off-frame.
let lightAnchor = [0.11, 0.14];
let pendingReanchor = true;
let geom = { faces: [], boxes: [], width: 1 };

// ------------------------------------------------------------- geometry ----
function rebuild() {
  buildGeometry();
  pendingReanchor = true;
  draw();
}

/**
 * Lay the word out in grid squares, then scale into world units where the cap
 * height is 1 and a square is 1/capSq. Glyph origins land on whole squares and
 * the baseline is y = 0, so every edge the font puts on a line stays on a line
 * right across the text.
 */
function buildGeometry() {
  const capSq = S.capSq;
  const strokeSq = strokeLimit(capSq, S.strokeSq);
  const cell = 1 / capSq;

  const glyphs = [];
  let totalSq = 0;
  for (const ch of [...S.text.toUpperCase()]) {
    const g = glyphChains(ch, capSq, strokeSq);
    if (!g) continue;
    glyphs.push(g);
    totalSq += g.adv;
  }
  totalSq = Math.max(totalSq - 1, 1);          // trailing tracking isn't ink

  const hw = (strokeSq * cell) / 2;
  const hd = S.depth / 2;
  const boxes = [];
  let xSq = -Math.round(totalSq / 2);          // whole squares: keeps the phase
  for (const g of glyphs) {
    for (const ch of g.chains) {
      const moved = ch.pts.map((p) => [(p[0] + xSq) * cell, p[1] * cell]);
      extrudeChain(moved, ch.closed, hw, hd, boxes);
    }
    xSq += g.adv;
  }

  const faces = [];
  for (const b of boxes) for (const f of b.faces) faces.push(f);
  geom = { faces, boxes, width: totalSq * cell };
}

/** A stroke has to leave room for counters: at most half the cap height. */
function strokeLimit(capSq, n) {
  return clamp(Math.round(n), 1, Math.max(1, Math.floor(capSq / 2)));
}

/**
 * Turn a polyline into a run of prisms: offset the chain by +/- hw with mitred
 * joints, then extrude each resulting quad along z. Open chains get square caps
 * (endpoints pushed out by hw) so butted strokes fuse at letter joints.
 */
function extrudeChain(pts, closed, hw, hd, out) {
  let p = pts.filter((q, i) => i === 0 || Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]) > 1e-7);
  if (p.length < 1) return;
  if (p.length === 1) {
    // a dot: build the square outright rather than extruding a stub, so its
    // corners land exactly on grid intersections
    const [x, y] = p[0];
    out.push(makePrism([[x - hw, y - hw], [x + hw, y - hw], [x + hw, y + hw], [x - hw, y + hw]], hd));
    return;
  }

  if (!closed) {
    const d0 = unit(p[0], p[1]), dn = unit(p[p.length - 2], p[p.length - 1]);
    p = p.slice();
    p[0] = [p[0][0] - d0[0] * hw, p[0][1] - d0[1] * hw];
    p[p.length - 1] = [p[p.length - 1][0] + dn[0] * hw, p[p.length - 1][1] + dn[1] * hw];
  }

  const n = p.length;
  const dirs = [];
  for (let i = 0; i < n - 1; i++) dirs.push(unit(p[i], p[i + 1]));
  if (closed) dirs.push(unit(p[n - 1], p[0]));

  // mitred offsets at every vertex
  const L = [], R = [];
  for (let i = 0; i < n; i++) {
    const din = closed ? dirs[(i - 1 + dirs.length) % dirs.length] : dirs[Math.max(0, i - 1)];
    const dout = closed ? dirs[i % dirs.length] : dirs[Math.min(dirs.length - 1, i)];
    const nin = [-din[1], din[0]], nout = [-dout[1], dout[0]];
    let mx = nin[0] + nout[0], my = nin[1] + nout[1];
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) { mx = nout[0]; my = nout[1]; } else { mx /= ml; my /= ml; }
    const cosHalf = Math.max(0.30, mx * nout[0] + my * nout[1]);
    const s = Math.min(hw / cosHalf, hw * 3);
    L.push([p[i][0] + mx * s, p[i][1] + my * s]);
    R.push([p[i][0] - mx * s, p[i][1] - my * s]);
  }

  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    out.push(makePrism([L[i], L[j], R[j], R[i]], hd));
  }
}

function unit(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}

/** Extrude a planar quad (xy) to a prism spanning z in [-hd, +hd]. */
function makePrism(q, hd) {
  // ensure counter-clockwise so edge normals point outward
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const quad = area < 0 ? [q[3], q[2], q[1], q[0]] : q;
  const z = Math.max(hd, 0.0006);
  const v = [];
  for (const a of quad) v.push([a[0], a[1], z]);
  for (const a of quad) v.push([a[0], a[1], -z]);

  const face = (idx, nrm) => {
    const pp = idx.map((i) => v[i]);
    const c = [0, 0, 0];
    for (const a of pp) { c[0] += a[0] / 4; c[1] += a[1] / 4; c[2] += a[2] / 4; }
    return { p: pp, n: nrm, c };
  };
  const faces = [face([0, 1, 2, 3], [0, 0, 1]), face([4, 5, 6, 7], [0, 0, -1])];
  // at zero depth the side walls collapse to slivers that read as stray
  // hairlines, so drop them and let the face float flat
  if (hd < 0.004) return { v, faces };
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const e = unit(quad[i], quad[j]);
    faces.push(face([i, j, j + 4, i + 4], [e[1], -e[0], 0]));
  }
  return { v, faces };
}

// ---------------------------------------------------------------- camera ----
let cam = {};
function updateCamera() {
  const cy = Math.cos(S.yaw), sy = Math.sin(S.yaw);
  const cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
  cam = { cy, sy, cp, sp };
  cam.eye = [-EYE_D * cp * sy, EYE_D * sp + 0.18, EYE_D * cp * cy];
}
const TARGET = [0, 0.18, 0];

function toCam(p) {
  const x = p[0] - TARGET[0], y = p[1] - TARGET[1], z = p[2] - TARGET[2];
  const x1 = x * cam.cy + z * cam.sy;
  const z1 = -x * cam.sy + z * cam.cy;
  const y2 = y * cam.cp - z1 * cam.sp;
  const z2 = y * cam.sp + z1 * cam.cp;
  return [x1, y2, z2];
}
function projCam(c) {
  const s = FOCAL / (EYE_D - c[2]);
  return [CX + c[0] * s, CY - c[1] * s];
}
const project = (p) => projCam(toCam(p));

/** Sutherland-Hodgman clip of a camera-space polygon to z <= EYE_D - NEAR. */
function clipNear(poly) {
  const lim = EYE_D - NEAR;
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ain = a[2] <= lim, bin = b[2] <= lim;
    if (ain) out.push(a);
    if (ain !== bin) {
      const t = (lim - a[2]) / (b[2] - a[2]);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, lim]);
    }
  }
  return out;
}

/**
 * Move the light (keeping its world z) until it projects onto a given screen
 * point. Newton iteration on the numeric 2x2 Jacobian of the projection —
 * the same trick the drag handler uses, so the two agree exactly.
 */
function placeLightAtScreen(sx, sy) {
  for (let i = 0; i < 8; i++) {
    const b = project([S.light.x, S.light.y, S.light.z]);
    const dx = sx - b[0], dy = sy - b[1];
    if (Math.hypot(dx, dy) < 0.4) break;
    const eps = 0.02;
    const gx = project([S.light.x + eps, S.light.y, S.light.z]);
    const gy = project([S.light.x, S.light.y + eps, S.light.z]);
    const a11 = (gx[0] - b[0]) / eps, a12 = (gy[0] - b[0]) / eps;
    const a21 = (gx[1] - b[1]) / eps, a22 = (gy[1] - b[1]) / eps;
    const det = a11 * a22 - a12 * a21;
    if (Math.abs(det) < 1e-9) break;
    S.light.x = clamp(S.light.x + (a22 * dx - a12 * dy) / det, -40, 40);
    S.light.y = clamp(S.light.y + (-a21 * dx + a11 * dy) / det, FLOOR_Y + 0.35, 40);
  }
}

/** Clip a camera-space segment to z <= EYE_D - NEAR. Null if it's all behind. */
function clipSegNear(a, b) {
  const lim = EYE_D - NEAR;
  const ain = a[2] <= lim, bin = b[2] <= lim;
  if (ain && bin) return [a, b];
  if (!ain && !bin) return null;
  const t = (lim - a[2]) / (b[2] - a[2]);
  const m = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, lim];
  return ain ? [a, m] : [m, b];
}

/**
 * Inverse projection onto the world plane z = zp. The camera transform is
 * linear and the perspective divide is linear-fractional, so substituting
 * u = a(D-w), v = b(D-w) turns the whole thing into a 2x2 linear system in
 * (x, y) -- no iteration needed.
 */
function unprojectToPlaneZ(sx, sy, zp) {
  const { cy, sy: syw, cp, sp } = cam;
  const a = (sx - CX) / FOCAL;
  const b = -(sy - CY) / FOCAL;

  // u, v, w as affine functions of (x - Tx, y - Ty), at fixed world z = zp
  const ux = cy, uy = 0, u0 = syw * zp;
  const vx = sp * syw, vy = cp, v0 = -sp * cy * zp;
  const wx = -cp * syw, wy = sp, w0 = cp * cy * zp;

  const m11 = ux + a * wx, m12 = uy + a * wy;
  const m21 = vx + b * wx, m22 = vy + b * wy;
  const r1 = a * EYE_D - u0 - a * w0;
  const r2 = b * EYE_D - v0 - b * w0;
  const det = m11 * m22 - m12 * m21;
  if (Math.abs(det) < 1e-9) return null;
  return [
    TARGET[0] + (r1 * m22 - m12 * r2) / det,
    TARGET[1] + (m11 * r2 - r1 * m21) / det,
  ];
}

// ------------------------------------------------------------- utilities ----
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function hexToRgb(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function hull(pts) {
  if (pts.length < 3) return pts;
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  lo.pop(); up.pop();
  return lo.concat(up);
}

// ----------------------------------------------------------------- draw ----
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  const r = canvas.getBoundingClientRect();
  W = Math.round(r.width); H = Math.round(r.height);
  pendingReanchor = true;
  canvas.width = shadowCv.width = Math.round(W * DPR);
  canvas.height = shadowCv.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  sctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  draw();
}

/**
 * Choose the focal length and screen centre from the *projected* bounds of the
 * real geometry, so depth and orbit angle can't push the word off-canvas.
 */
function fit() {
  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
  for (const b of geom.boxes) {
    for (const p of b.v) {
      const c = toCam(p);
      const d = EYE_D - c[2];
      if (d < NEAR) continue;
      const u = c[0] / d, v = c[1] / d;
      if (u < umin) umin = u; if (u > umax) umax = u;
      if (v < vmin) vmin = v; if (v > vmax) vmax = v;
    }
  }
  if (umax < umin) { FOCAL = 600; CX = W / 2; CY = H / 2; return; }
  FOCAL = Math.min(
    (0.82 * W) / Math.max(1e-5, umax - umin),
    (0.52 * H) / Math.max(1e-5, vmax - vmin),
    // the zoom cap scales with eye distance -- the flat view parks the camera
    // far away, so its focal length is proportionally larger
    (2200 * EYE_D) / EYE_NEAR_D,
  );
  CX = W / 2 - (FOCAL * (umin + umax)) / 2;
  CY = 0.42 * H + (FOCAL * (vmin + vmax)) / 2;
}

function drawFloor() {
  const R = 16;
  const quad = [[-R, FLOOR_Y, -R], [R, FLOOR_Y, -R], [R, FLOOR_Y, R], [-R, FLOOR_Y, R]].map(toCam);
  const c = clipNear(quad);
  if (c.length < 3) return;
  const pts = c.map(projCam);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  let top = Infinity, bot = -Infinity;
  for (const q of pts) { top = Math.min(top, q[1]); bot = Math.max(bot, q[1]); }
  const fade = ctx.createLinearGradient(0, top, 0, Math.max(top + 1, bot));
  fade.addColorStop(0, '#101119');       // melts into the backdrop at the horizon
  fade.addColorStop(0.30, '#1c1e28');
  fade.addColorStop(1, '#282b36');
  ctx.fillStyle = fade;
  ctx.fill();
  ctx.clip();
  // pool of light where the lamp shines on the ground
  const g = project([S.light.x, FLOOR_Y, S.light.z]);
  const rad = Math.max(60, FOCAL * 1.3 / Math.max(0.6, S.light.y - FLOOR_Y));
  const grd = ctx.createRadialGradient(g[0], g[1], 0, g[0], g[1], rad);
  const a = clamp(S.intensity * 0.16, 0, 0.4);
  grd.addColorStop(0, `rgba(255,244,214,${a})`);
  grd.addColorStop(1, 'rgba(255,244,214,0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

function drawShadow() {
  sctx.clearRect(0, 0, W, H);
  sctx.fillStyle = '#000';
  const L = S.light;
  let any = false;
  for (const b of geom.boxes) {
    const pts = [];
    let ok = true;
    for (const p of b.v) {
      const den = L.y - p[1];
      if (den < 0.25) { ok = false; break; }
      const t = (FLOOR_Y - p[1]) / den;
      const s = [p[0] + (L.x - p[0]) * t, FLOOR_Y, p[2] + (L.z - p[2]) * t];
      const c = toCam(s);
      if (c[2] > EYE_D - NEAR) { ok = false; break; }
      pts.push(projCam(c));
    }
    if (!ok) continue;
    const hl = hull(pts);
    if (hl.length < 3) continue;
    any = true;
    sctx.beginPath();
    sctx.moveTo(hl[0][0], hl[0][1]);
    for (let i = 1; i < hl.length; i++) sctx.lineTo(hl[i][0], hl[i][1]);
    sctx.closePath();
    sctx.fill();
  }
  if (!any) return;
  ctx.save();
  ctx.globalAlpha = clamp(0.38 + S.intensity * 0.26, 0, 0.88);
  if (S.softness > 0.5) ctx.filter = `blur(${S.softness.toFixed(1)}px)`;
  ctx.drawImage(shadowCv, 0, 0, W, H);
  ctx.restore();
}

/**
 * Squared-paper guides drawn in the plane of the letter *fronts*, so the grid
 * carries the same perspective as the type and the faces sit exactly on it.
 * Ruled in cap-height units: `capSq` squares per cap height, with the
 * baseline and cap line picked out, so the drawing can be copied square for
 * square onto a real checked page.
 */
function drawGrid() {
  const zp = Math.max(S.depth / 2, 0.0006);

  // how much of the plane the canvas actually sees
  const corners = [[0, 0], [W, 0], [W, H], [0, H]]
    .map((c) => unprojectToPlaneZ(c[0], c[1], zp))
    .filter(Boolean);
  if (corners.length < 4) return;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const c of corners) {
    x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]);
    y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]);
  }
  // the vanishing side of the plane runs away to infinity -- keep it sane
  const SPAN = 26;
  x0 = clamp(x0, -SPAN, SPAN); x1 = clamp(x1, -SPAN, SPAN);
  y0 = clamp(y0, -SPAN, SPAN); y1 = clamp(y1, -SPAN, SPAN);
  if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3) return;

  let cell = 1 / S.capSq;
  while ((x1 - x0 + y1 - y0) / cell > 900) cell *= 2;   // never flood the canvas

  const line = (ax, ay, bx, by, style, width) => {
    const seg = clipSegNear(toCam([ax, ay, zp]), toCam([bx, by, zp]));
    if (!seg) return;
    const p = projCam(seg[0]), q = projCam(seg[1]);
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    ctx.lineTo(q[0], q[1]);
    ctx.stroke();
  };

  const MINOR = 'rgba(126,170,255,0.16)';
  const MAJOR = 'rgba(126,170,255,0.34)';
  const RULE = 'rgba(232,176,75,0.55)';
  const major = Math.max(1, Math.round(1 / cell));   // a heavier line each cap height

  ctx.save();
  for (let k = Math.ceil(x0 / cell); k * cell <= x1; k++) {
    const x = k * cell;
    const big = k % major === 0;
    line(x, y0, x, y1, big ? MAJOR : MINOR, big ? 1.3 : 1);
  }
  for (let k = Math.ceil(y0 / cell); k * cell <= y1; k++) {
    const y = k * cell;
    const big = k % major === 0;
    line(x0, y, x1, y, big ? MAJOR : MINOR, big ? 1.3 : 1);
  }
  // baseline and cap line: the two rules you'd draw first on paper
  line(x0, 0, x1, 0, RULE, 1.8);
  line(x0, 1, x1, 1, RULE, 1.8);
  ctx.restore();
}

function drawText() {
  const base = hexToRgb(S.color);
  const L = S.light, eye = cam.eye;
  const list = [];
  for (const f of geom.faces) {
    const n = f.n, c = f.c;
    // backface cull against the true eye position
    const vx = eye[0] - c[0], vy = eye[1] - c[1], vz = eye[2] - c[2];
    if (n[0] * vx + n[1] * vy + n[2] * vz <= 0) continue;
    const cp = f.p.map(toCam);
    const clipped = clipNear(cp);
    if (clipped.length < 3) continue;
    let zc = 0;
    for (const q of cp) zc += q[2] / cp.length;

    // point-light shading in world space
    let lx = L.x - c[0], ly = L.y - c[1], lz = L.z - c[2];
    const dist = Math.hypot(lx, ly, lz) || 1;
    lx /= dist; ly /= dist; lz /= dist;
    const atten = 9 / (5 + dist * dist);
    const diff = Math.max(0, n[0] * lx + n[1] * ly + n[2] * lz) * atten * S.intensity;
    const vl = Math.hypot(vx, vy, vz) || 1;
    const hx = lx + vx / vl, hy = ly + vy / vl, hz = lz + vz / vl;
    const hn = Math.hypot(hx, hy, hz) || 1;
    const spec = Math.pow(Math.max(0, (n[0] * hx + n[1] * hy + n[2] * hz) / hn), 26) * 0.55 * S.intensity;

    const k = 0.13 + diff * 1.05;
    const col = [
      clamp(base[0] * k + spec * 255, 0, 255) | 0,
      clamp(base[1] * k + spec * 250, 0, 255) | 0,
      clamp(base[2] * k + spec * 235, 0, 255) | 0,
    ];
    list.push({ z: zc, pts: clipped.map(projCam), fill: `rgb(${col[0]},${col[1]},${col[2]})` });
  }
  list.sort((a, b) => a.z - b.z);   // far (small z) first
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1;
  for (const f of list) {
    ctx.beginPath();
    ctx.moveTo(f.pts[0][0], f.pts[0][1]);
    for (let i = 1; i < f.pts.length; i++) ctx.lineTo(f.pts[i][0], f.pts[i][1]);
    ctx.closePath();
    ctx.fillStyle = ctx.strokeStyle = f.fill;
    ctx.fill();
    ctx.stroke();      // hides antialias seams between coplanar boxes
  }
}

let lightScreen = [0, 0];
function drawLight() {
  const c = toCam([S.light.x, S.light.y, S.light.z]);
  const behind = c[2] >= EYE_D - NEAR;
  let p = projCam(c);
  if (behind) p = [W - 24, 24];
  // keep the handle reachable even when the lamp sits outside the frame
  const inside = !behind && p[0] > 22 && p[0] < W - 22 && p[1] > 22 && p[1] < H - 22;
  p = [clamp(p[0], 22, W - 22), clamp(p[1], 22, H - 22)];
  lightScreen = p;
  if (!inside) {
    ctx.save();
    ctx.fillStyle = 'rgba(255,238,180,0.85)';
    ctx.beginPath(); ctx.arc(p[0], p[1], 7, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(255,238,180,0.45)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p[0], p[1], 13, 0, 7); ctx.stroke();
    ctx.restore();
    return;
  }
  ctx.save();
  const g = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], 46);
  g.addColorStop(0, 'rgba(255,238,180,0.85)');
  g.addColorStop(1, 'rgba(255,238,180,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(p[0], p[1], 46, 0, 7); ctx.fill();
  ctx.fillStyle = '#fff6d8';
  ctx.beginPath(); ctx.arc(p[0], p[1], 8, 0, 7); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(p[0] + Math.cos(a) * 13, p[1] + Math.sin(a) * 13);
    ctx.lineTo(p[0] + Math.cos(a) * 19, p[1] + Math.sin(a) * 19);
    ctx.stroke();
  }
  ctx.restore();
}

function draw() {
  if (!W) return;
  EYE_D = S.flat ? EYE_FLAT_D : EYE_NEAR_D;
  updateCamera();
  fit();
  if (pendingReanchor) {
    placeLightAtScreen(lightAnchor[0] * W, lightAnchor[1] * H);
    pendingReanchor = false;
  }
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0b0c10');
  bg.addColorStop(1, '#1b1d26');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  // the flat view is for copying, not for staging: an edge-on floor and its
  // smeared shadow would only obscure the squares under the baseline
  if (!S.flat) {
    drawFloor();
    drawShadow();
  }
  if (S.grid) drawGrid();
  drawText();
  drawLight();
}

// -------------------------------------------------------------- controls ----
function makeKnob(host, opt) {
  const wrap = document.createElement('div');
  wrap.className = 'knob';
  wrap.innerHTML = `
    <svg viewBox="0 0 100 100" class="dial">
      <circle cx="50" cy="50" r="40" class="trackbg"/>
      <path class="track" fill="none"/>
      <g class="cap"><circle cx="50" cy="50" r="30"/><line x1="50" y1="50" x2="50" y2="24"/></g>
    </svg>
    <div class="klabel">${opt.label}</div>
    <div class="kval"></div>`;
  host.appendChild(wrap);
  const path = wrap.querySelector('.track');
  const capG = wrap.querySelector('.cap');
  const val = wrap.querySelector('.kval');
  let v = opt.value;

  function render() {
    const t = (v - opt.min) / (opt.max - opt.min);
    const a0 = -220, a1 = 40;
    const a = a0 + (a1 - a0) * t;
    const rad = (d) => (d * Math.PI) / 180;
    const arc = (from, to) => {
      const x0 = 50 + 40 * Math.cos(rad(from)), y0 = 50 + 40 * Math.sin(rad(from));
      const x1 = 50 + 40 * Math.cos(rad(to)), y1 = 50 + 40 * Math.sin(rad(to));
      return `M ${x0} ${y0} A 40 40 0 ${Math.abs(to - from) > 180 ? 1 : 0} 1 ${x1} ${y1}`;
    };
    path.setAttribute('d', arc(a0, Math.max(a0 + 0.01, a)));
    capG.setAttribute('transform', `rotate(${a + 90} 50 50)`);
    val.textContent = opt.format ? opt.format(v) : v.toFixed(2);
  }
  function set(nv) {
    v = clamp(opt.step ? Math.round(nv / opt.step) * opt.step : nv, opt.min, opt.max);
    render();
    opt.onChange(v);
  }
  render();

  let dragging = false, lastY = 0, startV = 0;
  wrap.addEventListener('pointerdown', (e) => {
    dragging = true; lastY = e.clientY; startV = v;
    wrap.setPointerCapture(e.pointerId); wrap.classList.add('active');
    e.preventDefault();
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const span = (opt.max - opt.min);
    const fine = e.shiftKey ? 0.25 : 1;
    set(startV + ((lastY - e.clientY) / 180) * span * fine);
  });
  const up = () => { dragging = false; wrap.classList.remove('active'); startV = v; };
  wrap.addEventListener('pointerup', up);
  wrap.addEventListener('pointercancel', up);
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    set(v - Math.sign(e.deltaY) * (opt.max - opt.min) / 60);
  }, { passive: false });
  wrap.addEventListener('dblclick', () => set(opt.value));
  return { set, get: () => v };
}

const knobRow = document.getElementById('knobs');
makeKnob(knobRow, {
  label: 'Depth', min: 0, max: 1.4, value: S.depth,
  onChange: (v) => { S.depth = v; rebuild(); },
});
makeKnob(knobRow, {
  label: 'Stroke', min: 1, max: 6, value: S.strokeSq, step: 1,
  format: (v) => `${strokeLimit(S.capSq, v)} sq`,
  onChange: (v) => { S.strokeSq = v; rebuild(); },
});
makeKnob(knobRow, {
  label: 'Cap height', min: 4, max: 14, value: S.capSq, step: 1,
  format: (v) => `${v} sq`,
  onChange: (v) => { S.capSq = v; rebuild(); },
});
makeKnob(knobRow, {
  label: 'Light dist', min: -2.5, max: 7, value: S.lightZ,
  format: (v) => v.toFixed(1),
  // dolly the lamp toward/away from the viewer, keeping it visually in place
  onChange: (v) => { S.lightZ = v; S.light.z = v; pendingReanchor = true; draw(); },
});
makeKnob(knobRow, {
  label: 'Intensity', min: 0, max: 2.2, value: S.intensity,
  onChange: (v) => { S.intensity = v; draw(); },
});
makeKnob(knobRow, {
  label: 'Softness', min: 0, max: 34, value: S.softness,
  format: (v) => v.toFixed(0),
  onChange: (v) => { S.softness = v; draw(); },
});
const gridBox = document.getElementById('grid');
gridBox.checked = S.grid;
gridBox.addEventListener('change', () => { S.grid = gridBox.checked; draw(); });

const frontBtn = document.getElementById('front');
frontBtn.addEventListener('click', () => {
  S.flat = !S.flat;
  if (S.flat) { S.yaw = 0; S.pitch = 0; }   // square up to the page
  frontBtn.classList.toggle('on', S.flat);
  pendingReanchor = true;
  draw();
});

const input = document.getElementById('text');
input.value = S.text;
input.addEventListener('input', () => {
  S.text = input.value.slice(0, 24);
  rebuild();
});

document.querySelectorAll('.swatch').forEach((el) => {
  el.style.background = el.dataset.c;
  el.addEventListener('click', () => {
    document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('on'));
    el.classList.add('on');
    S.color = el.dataset.c;
    draw();
  });
});
document.querySelector('.swatch').classList.add('on');

document.getElementById('reset').addEventListener('click', () => {
  S.yaw = -0.30; S.pitch = 0.22;
  S.flat = false;
  frontBtn.classList.remove('on');
  lightAnchor = [0.11, 0.14];
  pendingReanchor = true;
  draw();
});

// ------------------------------------------------- canvas: drag light/view ----
let mode = null, prev = null;
canvas.addEventListener('pointerdown', (e) => {
  const r = canvas.getBoundingClientRect();
  const p = [e.clientX - r.left, e.clientY - r.top];
  mode = Math.hypot(p[0] - lightScreen[0], p[1] - lightScreen[1]) < 34 ? 'light' : 'orbit';
  prev = p;
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add(mode === 'light' ? 'grab-light' : 'grab-view');
});
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  const p = [e.clientX - r.left, e.clientY - r.top];
  if (!mode) {
    canvas.style.cursor =
      Math.hypot(p[0] - lightScreen[0], p[1] - lightScreen[1]) < 34 ? 'grab' : 'default';
    return;
  }
  const dx = p[0] - prev[0], dy = p[1] - prev[1];
  prev = p;
  if (mode === 'orbit') {
    S.yaw = clamp(S.yaw + dx * 0.006, -1.0, 1.0);
    S.pitch = clamp(S.pitch + dy * 0.005, -0.10, 0.75);
  } else {
    // screen delta -> world delta via a numeric 2x2 Jacobian of the projection
    const eps = 0.02;
    const b = project([S.light.x, S.light.y, S.light.z]);
    const gx = project([S.light.x + eps, S.light.y, S.light.z]);
    const gy = project([S.light.x, S.light.y + eps, S.light.z]);
    const a11 = (gx[0] - b[0]) / eps, a12 = (gy[0] - b[0]) / eps;
    const a21 = (gx[1] - b[1]) / eps, a22 = (gy[1] - b[1]) / eps;
    const det = a11 * a22 - a12 * a21;
    if (Math.abs(det) > 1e-6) {
      S.light.x = clamp(S.light.x + (a22 * dx - a12 * dy) / det, -12, 12);
      S.light.y = clamp(S.light.y + (-a21 * dx + a11 * dy) / det, FLOOR_Y + 0.35, 14);
    }
  }
  draw();
});
const endDrag = () => {
  if (mode === 'light' && W) lightAnchor = [lightScreen[0] / W, lightScreen[1] / H];
  mode = null;
  canvas.classList.remove('grab-light', 'grab-view');
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

window.addEventListener('resize', resize);
buildGeometry();
resize();
