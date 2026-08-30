/*
 * A stroke font generated *from* the grid.
 *
 * Everything is measured in grid squares. A glyph is built from two integers:
 *
 *   H  squares per cap height (baseline y = 0, cap line y = H)
 *   N  stroke width in squares
 *
 * Strokes are described by their centre lines, and the extruder gives every
 * stroke a half-width of N/2 plus square caps. So a centre line at x = N/2
 * produces a stroke whose left edge is exactly x = 0 and whose right edge is
 * exactly x = N -- both on grid lines, N squares apart. Every horizontal and
 * vertical stroke in this font is placed that way: the E's stem sits on the
 * lines at 0 and N, its top bar's upper edge is the cap line, its bottom bar's
 * lower edge is the baseline.
 *
 * Diagonals and curves can't have their long edges on lines -- no straight
 * diagonal can. They're pinned the way you'd pin them on paper instead: end
 * points on lattice points, and the extremes of every bowl touching the
 * bounding lines of the glyph.
 *
 * Glyph advance is W + 1 squares, and words are laid out on whole squares, so
 * the alignment holds across the whole line of text.
 */

/** Flatten an elliptical arc into a point chain, in squares. */
function arcPts(cx, cy, rx, ry, d0, d1) {
  rx = Math.max(0.2, rx);
  ry = Math.max(0.2, ry);
  const sweep = d1 - d0;
  const closed = Math.abs(sweep) >= 359.9;
  const steps = Math.max(6, Math.ceil(Math.abs(sweep) / 10));
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    if (closed && i === steps) break;          // don't repeat the seam point
    const t = ((d0 + (sweep * i) / steps) * Math.PI) / 180;
    pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return { pts, closed };
}

/** The measurements every glyph builder works from. */
function metrics(H, N, W) {
  const a = N / 2;                       // half stroke: the inset of a centre line
  // snap a centre line so that both of its edges land on grid lines
  const sc = (c) => Math.round(c - a) + a;
  return {
    H, N, W, a,
    x0: a, x1: W - a,                    // left / right stems, edges on 0 and W
    y0: a, y1: H - a,                    // baseline / cap line strokes
    xm: W / 2, ym: H / 2,                // true centre (for bowls)
    cx: sc(W / 2), cy: sc(H / 2),        // snapped centre (for straight strokes)
    mid: Math.ceil((H - N) / 2) + a,     // middle bar, a touch above centre
    third: Math.round((H - N) / 3) + a,  // lower crossbar (A)
    sc,
    seg: (...pts) => ({ pts, closed: false }),
    arc: arcPts,
    ell: (ccx, ccy, rx, ry) => arcPts(ccx, ccy, rx, ry, 0, 360),
  };
}

// r = glyph width as a fraction of the cap height; b = builder
const GLYPHS = {
  ' ': { r: 0.44, b: () => [] },

  A: { r: 0.70, b: (g) => {
    const t = (g.third - g.y0) / (g.y1 - g.y0);
    const xl = g.x0 + (g.cx - g.x0) * t, xr = g.x1 - (g.x1 - g.cx) * t;
    return [g.seg([g.x0, g.y0], [g.cx, g.y1], [g.x1, g.y0]), g.seg([xl, g.third], [xr, g.third])];
  } },
  B: { r: 0.70, b: (g) => {
    const ru = (g.y1 - g.mid) / 2, rl = (g.mid - g.y0) / 2;
    return [
      g.seg([g.x0, g.y0], [g.x0, g.y1]),
      g.arc(g.x0, g.mid + ru, g.W - 1 - g.N, ru, 90, -90),
      g.arc(g.x0, g.y0 + rl, g.W - g.N, rl, 90, -90),
    ];
  } },
  C: { r: 0.72, b: (g) => [g.arc(g.xm, g.ym, g.xm - g.a, g.ym - g.a, 55, 305)] },
  D: { r: 0.74, b: (g) => [
    g.seg([g.x0, g.y0], [g.x0, g.y1]),
    g.arc(g.x0, g.ym, g.W - g.N, g.ym - g.a, 90, -90),
  ] },
  E: { r: 0.64, b: (g) => [
    g.seg([g.x0, g.y0], [g.x0, g.y1]),
    g.seg([g.x0, g.y1], [g.x1, g.y1]),
    g.seg([g.x0, g.mid], [Math.max(g.x0 + 1, g.x1 - 1), g.mid]),
    g.seg([g.x0, g.y0], [g.x1, g.y0]),
  ] },
  F: { r: 0.60, b: (g) => [
    g.seg([g.x0, g.y0], [g.x0, g.y1]),
    g.seg([g.x0, g.y1], [g.x1, g.y1]),
    g.seg([g.x0, g.mid], [Math.max(g.x0 + 1, g.x1 - 1), g.mid]),
  ] },
  G: { r: 0.76, b: (g) => [
    g.arc(g.xm, g.ym, g.xm - g.a, g.ym - g.a, 55, 360),
    g.seg([g.x1, g.ym], [g.cx, g.ym]),
  ] },
  H: { r: 0.70, b: (g) => [
    g.seg([g.x0, g.y0], [g.x0, g.y1]),
    g.seg([g.x1, g.y0], [g.x1, g.y1]),
    g.seg([g.x0, g.mid], [g.x1, g.mid]),
  ] },
  I: { r: 0.40, b: (g) => [
    g.seg([g.cx, g.y0], [g.cx, g.y1]),
    g.seg([g.x0, g.y1], [g.x1, g.y1]),
    g.seg([g.x0, g.y0], [g.x1, g.y0]),
  ] },
  J: { r: 0.60, b: (g) => [
    g.seg([g.x1, g.y1], [g.x1, g.mid]),
    g.arc(g.xm, g.mid, g.xm - g.a, g.mid - g.a, 0, -180),
  ] },
  K: { r: 0.70, b: (g) => [
    g.seg([g.x0, g.y0], [g.x0, g.y1]),
    g.seg([g.x1, g.y1], [g.x0, g.mid], [g.x1, g.y0]),
  ] },
  L: { r: 0.58, b: (g) => [
    g.seg([g.x0, g.y0], [g.x0, g.y1]),
    g.seg([g.x0, g.y0], [g.x1, g.y0]),
  ] },
  M: { r: 0.86, b: (g) => [
    g.seg([g.x0, g.y0], [g.x0, g.y1], [g.cx, g.mid], [g.x1, g.y1], [g.x1, g.y0]),
  ] },
  N: { r: 0.72, b: (g) => [
    g.seg([g.x0, g.y0], [g.x0, g.y1], [g.x1, g.y0], [g.x1, g.y1]),
  ] },
  O: { r: 0.76, b: (g) => [g.ell(g.xm, g.ym, g.xm - g.a, g.ym - g.a)] },
  P: { r: 0.66, b: (g) => {
    const r = (g.y1 - g.mid) / 2;
    return [g.seg([g.x0, g.y0], [g.x0, g.y1]), g.arc(g.x0, g.mid + r, g.W - g.N, r, 90, -90)];
  } },
  Q: { r: 0.78, b: (g) => [
    g.ell(g.xm, g.ym, g.xm - g.a, g.ym - g.a),
    g.seg([g.xm + (g.xm - g.a) * 0.35, g.ym - (g.ym - g.a) * 0.5], [g.x1, g.y0]),
  ] },
  R: { r: 0.70, b: (g) => {
    const r = (g.y1 - g.mid) / 2;
    return [
      g.seg([g.x0, g.y0], [g.x0, g.y1]),
      g.arc(g.x0, g.mid + r, g.W - g.N, r, 90, -90),
      g.seg([g.x0, g.mid], [g.x1, g.y0]),
    ];
  } },
  S: { r: 0.68, b: (g) => {
    const ru = (g.y1 - g.mid) / 2, rl = (g.mid - g.y0) / 2;
    const rx = g.xm - g.a;
    const up = g.arc(g.xm, g.mid + ru, rx, ru, 10, 205);
    const lo = g.arc(g.xm, g.y0 + rl, rx, rl, 25, -190);
    const e = up.pts[up.pts.length - 1], s = lo.pts[0];
    return [up, g.seg(e, s), lo];
  } },
  T: { r: 0.68, b: (g) => [
    g.seg([g.x0, g.y1], [g.x1, g.y1]),
    g.seg([g.cx, g.y0], [g.cx, g.y1]),
  ] },
  U: { r: 0.72, b: (g) => [
    g.seg([g.x0, g.y1], [g.x0, g.mid]),
    g.seg([g.x1, g.y1], [g.x1, g.mid]),
    g.arc(g.xm, g.mid, g.xm - g.a, g.mid - g.a, 180, 360),
  ] },
  V: { r: 0.72, b: (g) => [g.seg([g.x0, g.y1], [g.cx, g.y0], [g.x1, g.y1])] },
  W: { r: 0.98, b: (g) => [g.seg(
    [g.x0, g.y1], [g.sc((g.x0 + g.cx) / 2), g.y0], [g.cx, g.mid],
    [g.sc((g.cx + g.x1) / 2), g.y0], [g.x1, g.y1],
  )] },
  X: { r: 0.72, b: (g) => [
    g.seg([g.x0, g.y0], [g.x1, g.y1]),
    g.seg([g.x0, g.y1], [g.x1, g.y0]),
  ] },
  Y: { r: 0.72, b: (g) => [
    g.seg([g.x0, g.y1], [g.cx, g.mid], [g.x1, g.y1]),
    g.seg([g.cx, g.mid], [g.cx, g.y0]),
  ] },
  Z: { r: 0.68, b: (g) => [g.seg([g.x0, g.y1], [g.x1, g.y1], [g.x0, g.y0], [g.x1, g.y0])] },

  0: { r: 0.72, b: (g) => [
    g.ell(g.xm, g.ym, g.xm - g.a, g.ym - g.a),
    g.seg([g.x0 + (g.x1 - g.x0) * 0.18, g.y0 + (g.y1 - g.y0) * 0.22],
          [g.x1 - (g.x1 - g.x0) * 0.18, g.y1 - (g.y1 - g.y0) * 0.22]),
  ] },
  1: { r: 0.48, b: (g) => [
    g.seg([g.x0, g.y1 - (g.y1 - g.y0) * 0.22], [g.cx, g.y1], [g.cx, g.y0]),
    g.seg([g.x0, g.y0], [g.x1, g.y0]),
  ] },
  2: { r: 0.68, b: (g) => {
    const ry = g.y1 - g.mid;
    const top = g.arc(g.xm, g.mid, g.xm - g.a, ry, 180, -25);
    const e = top.pts[top.pts.length - 1];
    return [top, g.seg(e, [g.x0, g.y0]), g.seg([g.x0, g.y0], [g.x1, g.y0])];
  } },
  3: { r: 0.68, b: (g) => {
    const ru = (g.y1 - g.mid) / 2, rl = (g.mid - g.y0) / 2, rx = g.xm - g.a;
    return [
      g.arc(g.xm, g.mid + ru, rx, ru, 150, -70),
      g.arc(g.xm, g.y0 + rl, rx, rl, 70, -160),
    ];
  } },
  4: { r: 0.74, b: (g) => {
    const dx = g.sc(g.x1 - (g.x1 - g.x0) * 0.25);
    return [
      g.seg([dx, g.y1], [g.x0, g.third], [g.x1, g.third]),
      g.seg([dx, g.y1], [dx, g.y0]),
    ];
  } },
  5: { r: 0.68, b: (g) => {
    const rl = (g.mid - g.y0) / 2;
    return [
      g.seg([g.x1, g.y1], [g.x0, g.y1]),
      g.seg([g.x0, g.y1], [g.x0, g.mid]),
      g.seg([g.x0, g.mid], [g.xm, g.mid]),
      g.arc(g.xm, g.y0 + rl, g.xm - g.a, rl, 90, -180),
    ];
  } },
  6: { r: 0.70, b: (g) => {
    const top = g.mid + g.a;               // outer top of the bowl
    const cy = top / 2, ry = top / 2 - g.a;
    return [
      g.ell(g.xm, cy, g.xm - g.a, ry),
      g.arc(g.xm, cy, g.xm - g.x0, g.y1 - cy, 90, 180),
    ];
  } },
  7: { r: 0.66, b: (g) => [
    g.seg([g.x0, g.y1], [g.x1, g.y1]),
    g.seg([g.x1, g.y1], [g.sc(g.x0 + (g.x1 - g.x0) * 0.3), g.y0]),
  ] },
  8: { r: 0.70, b: (g) => {
    const bu = g.mid - g.a, cu = (bu + g.H) / 2, ru = (g.H - bu) / 2 - g.a;
    const tl = g.mid + g.a, cl = tl / 2, rl = tl / 2 - g.a;
    return [
      g.ell(g.xm, cu, (g.xm - g.a) * 0.82, ru),
      g.ell(g.xm, cl, g.xm - g.a, rl),
    ];
  } },
  9: { r: 0.70, b: (g) => {
    const bot = g.mid - g.a;               // outer bottom of the bowl
    const cy = (bot + g.H) / 2, ry = (g.H - bot) / 2 - g.a;
    return [
      g.ell(g.xm, cy, g.xm - g.a, ry),
      g.arc(g.xm, cy, g.x1 - g.xm, cy - g.y0, 0, -90),
    ];
  } },

  '.': { r: 0.34, b: (g) => [g.seg([g.x0, g.y0], [g.x0, g.y0])] },
  ',': { r: 0.34, b: (g) => [g.seg([g.x0 + g.a, g.y0 + g.a], [g.x0, g.y0 - g.N])] },
  '!': { r: 0.36, b: (g) => [
    g.seg([g.x0, g.mid], [g.x0, g.y1]),
    g.seg([g.x0, g.y0], [g.x0, g.y0]),
  ] },
  '?': { r: 0.62, b: (g) => {
    // arch across the top, then the stem drops back to the centre line
    const ry = (g.y1 - g.mid) / 2;
    const top = g.arc(g.xm, g.mid + ry, g.xm - g.a, ry, 195, -25);
    const e = top.pts[top.pts.length - 1];
    return [top, g.seg(e, [g.cx, g.third]), g.seg([g.cx, g.y0], [g.cx, g.y0])];
  } },
  '-': { r: 0.56, b: (g) => [g.seg([g.x0, g.mid], [g.x1, g.mid])] },
  '+': { r: 0.62, b: (g) => {
    const d = Math.max(1, Math.round(g.H * 0.25));
    return [g.seg([g.x0, g.mid], [g.x1, g.mid]), g.seg([g.cx, g.mid - d], [g.cx, g.mid + d])];
  } },
  ':': { r: 0.34, b: (g) => [
    g.seg([g.x0, g.y0], [g.x0, g.y0]),
    g.seg([g.x0, g.mid], [g.x0, g.mid]),
  ] },
  "'": { r: 0.30, b: (g) => [g.seg([g.x0, g.y1 - Math.max(1, Math.round(g.H * 0.22))], [g.x0, g.y1])] },
  '/': { r: 0.60, b: (g) => [g.seg([g.x0, g.y0], [g.x1, g.y1])] },
  '*': { r: 0.58, b: (g) => {
    const d = Math.max(1, Math.round(g.H * 0.2));
    return [
      g.seg([g.cx, g.mid], [g.cx, g.mid + d * 1.4]),
      g.seg([g.cx - d, g.mid + d * 0.5], [g.cx + d, g.mid + d * 1.1]),
      g.seg([g.cx - d, g.mid + d * 1.1], [g.cx + d, g.mid + d * 0.5]),
    ];
  } },
  '#': { r: 0.78, b: (g) => {
    const q = Math.max(1, Math.round(g.H * 0.22));
    return [
      g.seg([g.sc(g.x0 + (g.x1 - g.x0) * 0.3), g.y0], [g.sc(g.x0 + (g.x1 - g.x0) * 0.42), g.y1]),
      g.seg([g.sc(g.x0 + (g.x1 - g.x0) * 0.62), g.y0], [g.sc(g.x0 + (g.x1 - g.x0) * 0.74), g.y1]),
      g.seg([g.x0, g.y0 + q], [g.x1, g.y0 + q]),
      g.seg([g.x0, g.y1 - q], [g.x1, g.y1 - q]),
    ];
  } },
};

/**
 * Build one glyph on an H-square cap height with an N-square stroke.
 * Returns { W, adv, chains } in grid squares -- W and adv are whole squares.
 */
function glyphChains(ch, H, N) {
  const spec = GLYPHS[ch] || GLYPHS[ch.toUpperCase()];
  if (!spec) return null;
  const W = Math.max(N + 1, Math.round(H * spec.r));
  const g = metrics(H, N, W);
  return { W, adv: W + 1, chains: spec.b(g) };
}
