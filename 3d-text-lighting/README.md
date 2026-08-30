# 3D Stroke Type

An interactive toy that renders whatever you type as extruded 3D letters built
from a hand-authored stroke font — straight lines wherever a letter can be made
of them, arcs only where the shape genuinely needs one (S, O, C, G, Q, U, and
most digits). Depth and boldness are on knobs, and the light source is a sun you
drag around the canvas; it relights the faces and moves the shadow on the floor.

**Live demo: https://etoulas.github.io/research/3d-text-lighting/**

No libraries, no font files, no WebGL — one 2D canvas and about 500 lines of JS.

![Default view](preview.png)
![Deeper, bolder, blue](preview-deep.png)

## Using it

| Control | What it does |
| --- | --- |
| **Text** field | Up to 24 characters, A–Z, 0–9 and `. , ! ? - + : ' / * #` (lowercase is upper-cased) |
| **Depth** knob | Extrusion along z, from flat to 1.4 cap-heights |
| **Boldness** knob | Stroke width, 0.03 → 0.26 cap-heights |
| **Light dist** knob | Dollies the lamp toward or away from the viewer, keeping it visually in place |
| **Intensity** knob | Brightness of the point light, and how dark the shadow reads |
| **Softness** knob | Shadow blur |
| **Drag the sun** | Moves the light in the plane at its current distance |
| **Drag elsewhere** | Orbits the camera (yaw and pitch) |
| **Material swatches** | Base colour |

Knobs respond to vertical drags, the scroll wheel, and double-click to reset.
Hold shift while dragging for fine control.

## How it works

**The font** (`font.js`). Each glyph is a list of strokes in a coordinate system
where the baseline is `y = 0` and the cap height is `y = 1`: `['L', x1,y1,x2,y2]`
for a straight segment, `['A', cx,cy,rx,ry,deg0,deg1]` for an elliptical arc.
`glyphChains()` flattens the glyph into polyline *chains*, keeping each arc as a
single chain (closed for a full ellipse) so the extruder can miter its joints.

**Extrusion** (`extrudeChain` in `app.js`). Boldness is the stroke width, so a
chain is offset by ±half-width at every vertex along the angle bisector, scaled
by `1/cos(half-angle)` and clamped to 3× the half-width so a hairpin can't spike
off into space. Open chains get square caps by pushing their endpoints out by
the half-width first — that's what makes separate strokes fuse where they butt,
as in the crossbar of an A. Each resulting quad is extruded to a prism spanning
`z ∈ [-depth/2, +depth/2]`: 8 vertices, 6 quad faces, each carrying its own
analytic normal.

**Rendering.** Painter's algorithm on a 2D canvas. Faces are back-face culled
against the true eye position (using the stored normal, so winding order doesn't
matter), clipped against the near plane, sorted by camera-space depth and filled
far-to-near. Overlapping prisms at a joint are harmless because every face is
opaque. Each face is filled *and* stroked in its own colour so antialiasing
doesn't leave bright cracks between coplanar prisms.

**Lighting** is a point light evaluated in world space: ambient + Lambert
diffuse + a Blinn-style specular highlight, with a mild distance falloff. The
same light position drives the pool of light on the floor.

**Shadows.** Each prism's 8 corners are projected from the light onto the floor
plane `y = -0.45`; the convex hull of the projected points is the prism's
shadow. Perspective projection of coplanar points is a projective map, so the
hull can be taken after projecting to screen. All hulls are drawn as solid black
onto an offscreen canvas, then composited once with `globalAlpha` and a CSS blur
— that way overlapping shadows don't stack into a black blob, and the edges come
out soft for free.

**Framing.** The focal length and screen centre are solved every frame from the
projected bounding box of the actual geometry, so no combination of depth,
boldness, orbit angle and text length can push the word off the canvas.

**The draggable light.** Converting a screen drag into a world-space move is
done by projecting the light plus a small ε in x and y, building the 2×2
Jacobian of the projection numerically, and inverting it. The same step, run as
a Newton iteration, is used to re-place the lamp after the view refits: the
light's position is remembered as a *fraction of the canvas*, not as a world
coordinate, so it stays where you put it when the text changes and the view
rescales.

## Files

- `index.html` — page, styling, knob and swatch markup
- `font.js` — the stroke font and its flattener
- `app.js` — extrusion, camera, renderer, shadows, knob widget, interaction
- `notes.md` — working notes, including the bugs hit along the way
- `preview.png`, `preview-deep.png` — screenshots

## Known limitations

- Painter's algorithm, not a z-buffer, so pathological self-intersections
  between prisms could sort wrongly. In practice the letters are convex enough
  that it holds up.
- Letters don't shadow *each other* — the shadow is cast onto the floor only.
- The font is caps-only; unmapped characters are skipped.
