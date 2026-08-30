# 3D text renderer with knobs + movable light — notes

## Goal
Interactive JS app: type short text -> render it as 3D extruded letters built
mostly from straight strokes (curves only where a letter really needs them:
S, O, C, G, ...), with knobs for depth and boldness, and a draggable light
source that casts a simple shadow.

## Design decisions (before writing code)
- **No font files, no libraries.** A hand-authored stroke font gives exact
  control over "mostly straight lines" and makes extrusion trivial. Each glyph
  is a list of `['L', x1,y1,x2,y2]` line strokes and `['A', cx,cy,rx,ry,a0,a1]`
  elliptical arcs. Arcs get flattened to short line strokes at build time, so
  downstream everything is a segment.
- **Boldness = stroke half-width.** Each segment becomes a rectangular
  *prism* (box): 8 vertices, 6 quad faces. Ends are extended by the half-width
  (square caps) so joins fill in without any miter maths.
- **Depth = extrusion along +/- Z.** Box spans z in [-d/2, +d/2].
- **Renderer = painter's algorithm on quads**, 2D canvas only. Backface cull
  with the analytic face normal (winding-independent), then sort faces by
  camera-space z and draw far-to-near. Overlapping boxes at joints are fine
  because faces are opaque.
- **Lighting** is done in *world* space (point light): ambient + Lambert
  diffuse + Blinn-ish specular, with mild inverse-square-ish falloff.
- **Shadow** = project each box's 8 corners from the light point onto the floor
  plane y = floorY, take the convex hull, fill. All hulls are drawn onto an
  offscreen canvas in solid black then composited once with alpha + blur, so
  overlapping shadows don't darken each other.
- **Dragging the light**: the light lives in world space; to convert a screen
  drag into a world delta I project light+eps in x and y, build the 2x2
  Jacobian numerically and invert it. Robust regardless of camera rotation.

## Build log

1. **First pass** — one prism per straight segment, ends extended by the half
   stroke width so butt joints fill in. Straight letters looked right
   immediately; curves did not. Flattening an arc into independent segments and
   then extending *both* ends of each one by `hw` makes every joint overshoot,
   so the O came out with a sawtooth silhouette.
2. **Fix: mitred chains.** `glyphSegments` became `glyphChains` — arcs stay one
   polyline (closed for a full ellipse). `extrudeChain` offsets the chain by
   +/- hw at every vertex along the *angle bisector*, scaled by `1/cos(half
   angle)` and clamped to 3x hw so a hairpin can't spike. Square caps survive
   for open chains by pushing the two endpoints out by hw before offsetting.
   Curves are clean now, and straight strokes still fuse where they butt.
3. **Fit bug.** The first fit computed the focal length from the *glyph-space*
   width, which ignores both perspective and the orbit angle: `ABCDEFGHIJKLM`
   ran straight off both edges of the canvas. Replaced with a real fit —
   project every vertex at focal 1, take the bounding box, then solve for focal
   length and screen centre. Depth and orbit can no longer push the word out of
   frame.
4. **The light kept leaving the frame.** Because the fit rescales per text
   length, a light fixed in *world* space projects way off-canvas for a short
   word (the view is zoomed right in) and near the centre for a long one. Fixed
   by storing the lamp's position as a *screen fraction* (`lightAnchor`) and
   re-solving its world position after every re-fit with the same Newton /
   Jacobian step the drag uses. Dragging the lamp updates the anchor, so it
   stays where you put it when you retype the text. As a backstop, a lamp that
   still lands outside the canvas draws as a clamped ring on the edge and stays
   grabbable.
5. **Zero depth artefacts.** At depth 0 the four side walls of each prism
   collapse into ~1px slivers that shaded differently from the front face and
   read as stray hairlines across the letters. `makePrism` now drops the side
   faces below hd = 0.004.
6. **Contrast pass.** The floor was almost as dark as the shadow, so the shadow
   was invisible. Lightened the floor with a vertical gradient that fades into
   the backdrop at the horizon, and raised the shadow alpha.

## Things worth remembering

- Painter's algorithm with per-face analytic normals means winding order never
  has to be right for *culling* — but it does for the side-wall normals, so
  `makePrism` reverses the quad when its signed area is negative.
- Filling *and* stroking each face with the same colour (lineWidth 1) hides the
  antialiasing seams between coplanar prisms. Without it every joint shows a
  faint bright crack.
- Drawing all shadow hulls into an offscreen canvas as solid black and
  compositing once with `globalAlpha` + `filter: blur()` keeps overlapping
  shadows from stacking into black blobs, and gives soft edges for free.
- Perspective projection of coplanar points is a projective map, so the convex
  hull can be taken *after* projecting to screen — no need to hull in 3D.

## Verified with headless Chromium

Screenshotted defaults, all 26 letters, the digits and punctuation, a scripted
light drag, and the parameter extremes (depth 0 and 1.4, boldness 0.03 and
0.26, intensity 0, empty and whitespace-only text). No console errors in any
case.

## Follow-up: squared-paper guides

Goal: a toggleable grid that extends outward from the front of the letters,
like drawing on a checked notebook — and that actually helps with copying the
letters onto real squared paper.

- **Where the grid lives.** In the plane of the letter *fronts*, `z = depth/2`,
  drawn after the shadow and before the type, so the faces sit exactly on the
  paper and the letters occlude the lines they cover. Ruled in cap-height units
  (`gridDiv` squares per cap height, default 4), with a heavier line every whole
  cap height and the baseline and cap line picked out in the accent colour.
- **Sizing the grid to the canvas.** Needed the inverse projection onto a plane
  `z = zp`. No iteration required: the camera transform is linear and the
  perspective divide is linear-fractional, so substituting `u = a(D-w)` and
  `v = b(D-w)` turns it into a 2x2 linear system in (x, y). Solved at the four
  canvas corners to get the visible extent, clamped to ±26 cap-heights because
  the vanishing side of the plane runs to infinity, and the cell size doubles
  if the line count would exceed ~900.
- **Perspective defeats the point.** A 3/4 perspective view can't be measured
  against squares — even head-on, a point camera shows the side walls of
  off-centre letters. So the *Front on* button parks the eye at 220 units
  instead of 6.2, which is orthographic for all practical purposes, and squares
  up to yaw 0 / pitch 0. Now cap height is exactly `gridDiv` squares anywhere on
  the canvas and the letters measure 1:1.
  - This needed one fix: `fit()` capped the focal length at a flat 2200, which
    is right at eye distance 6.2 and wildly wrong at 220 — the type came out
    postage-stamp sized. The cap now scales with eye distance.
  - In flat view the floor is edge-on and its shadow smears into a grey slab
    over the squares below the baseline, so both are skipped in that mode. The
    lighting still shades the front faces, and the lamp is still draggable.

Checked: grid on/off, front on/off/reset round-trip, a light drag while flat,
`gridDiv` at 1 and 8, depth 0 and 1.2, and a hard orbit while flat. No console
errors, and the state ends up where it should after each toggle.
