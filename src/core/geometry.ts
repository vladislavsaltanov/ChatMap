// Geometry and styling calculations for neural graph rendering and node sizes.

// Zoom-in "fisheye": a pronounced radial magnification around the camera centre.
// Neighbouring words drift apart near the focus, distant words stay put. All
// values are in graph units; MapView converts the screen-space reach into
// `fisheyeRadius` and derives `fisheyeStrength` from the camera ratio.
export type FisheyeConfig = {
  fisheyeX?: number
  fisheyeY?: number
  fisheyeRadius?: number
  fisheyeStrength?: number
}

const FISHEYE_GAIN = 0.5

export function fisheyePoint(x: number, y: number, f: FisheyeConfig): { x: number; y: number } {
  const k = Math.max(0, Math.min(1, f.fisheyeStrength ?? 0))
  const radius = f.fisheyeRadius ?? 0
  if (k <= 0 || radius <= 0) return { x, y }
  const cx = f.fisheyeX ?? 0
  const cy = f.fisheyeY ?? 0
  const dx = x - cx
  const dy = y - cy
  const d = Math.hypot(dx, dy)
  if (d < 1e-6) return { x, y }
  const t = d / radius
  const gain = 1 + FISHEYE_GAIN * k * Math.exp(-1.8 * t * t)
  return { x: cx + dx * gain, y: cy + dy * gain }
}

// Pure gain factor of the fisheye magnifier at a distance: 1 far away,
// 1 + FISHEYE_GAIN * strength at the center. Exported so the camera fit can
// predict displaced positions through the same kernel it renders with.
export function fisheyeGain(distance: number, radius: number, strength: number): number {
  const k = Math.max(0, Math.min(1, strength))
  if (k <= 0 || radius <= 0 || !(distance > 1e-9)) return 1
  const t = distance / radius
  return 1 + FISHEYE_GAIN * k * Math.exp(-1.8 * t * t)
}

// Camera ratio -> divisor Sigma applies to node sizes (`scaleSize = size / f(ratio)`).
// ratio > 1 is zoom-out: node radii must shrink exactly like the positions (1/ratio),
// otherwise screen-referenced hubs keep their px size while the graph collapses into them.
// ratio < 1 is zoom-in: sqrt keeps hubs from swallowing the whole view.
export function zoomSizeRatio(ratio: number): number {
  const r = Math.max(0.05, ratio)
  return r >= 1 ? r : Math.sqrt(r)
}

// Camera ratio -> divisor Sigma applies to LABEL font size. Node radii follow
// positions (1/ratio), but text must stay readable from far away: zoom-out
// shrinks the kegel much slower, capped at 1.7x. Styles multiply the kegel by
// this same value, so the on-screen size is constant at every zoom level.
export function labelZoomRatio(ratio: number): number {
  const r = Math.max(0.05, ratio)
  return r >= 1 ? Math.min(1.7, Math.pow(r, 0.45)) : Math.sqrt(r)
}

// Rendered core radius in screen px. Used only for LOD / label decisions:
// the size style itself must NOT apply it (Sigma already scales the quad).
export function renderedNodeSize(core: number, ratio: number): number {
  return core / zoomSizeRatio(ratio)
}

// nodeFitSize() returns the radius the LAYOUT reserves for collision spacing.
// The drawn body is compressed so neighbouring bubbles keep a visible gap even
// in dense clusters (screen-referenced radii otherwise overlap on any framing).
// The compression stays mild: the size hierarchy between a landmark word and a
// rare one is the whole point of the map, so it must survive to the screen.
const CORE_KNEE = 9
const CORE_COMPRESSION = 0.72

export function visualCoreRadius(layoutRadius: number): number {
  const r = Math.max(0, layoutRadius)
  return r <= CORE_KNEE ? r : CORE_KNEE + (r - CORE_KNEE) * CORE_COMPRESSION
}

// Landmark cores (>= 18 px) are 0, dust is 1. One shared measure of "this word is
// only texture": node shrink, node dissolve, label weight and the link ceiling all
// answer to the same number, so a body and its links can never disagree.
const SMALL_CORE_PX = 18
const SMALL_RANGE_PX = 13

export function smallness(core: number): number {
  if (!(core < SMALL_CORE_PX)) return 0
  return Math.max(0, Math.min(1, (SMALL_CORE_PX - core) / SMALL_RANGE_PX))
}

// Screen-space dissolve window for drawn bodies. Below GONE a body must not exist
// at all (not "very dim"): a 1-2 px speck at 3% alpha still reads as dirt on the
// paper and keeps its links pointing at nothing. Above PRESENT it is fully there.
const LOD_GONE_PX = 1.6
const LOD_PRESENT_PX = 4.5
export { LOD_GONE_PX, LOD_PRESENT_PX }

// Query: 0..1 share of a body that should be drawn at the given rendered radius.
// Pass the radius BEFORE any density shrink: the shrink is its own visual stage,
// and folding it in here would dissolve the default overview instead of the
// zoom-out (measured: dust draws at 38% of its rendered size). NaN and negative
// input are treated as gone rather than propagated.
export function lodPresence(renderedPx: number): number {
  if (!(renderedPx > LOD_GONE_PX)) return 0
  if (renderedPx >= LOD_PRESENT_PX) return 1
  const t = (renderedPx - LOD_GONE_PX) / (LOD_PRESENT_PX - LOD_GONE_PX)
  return t * t * (3 - 2 * t)
}

// Frequency law: a power curve over the relative frequency. The previous
// log-normalised rank (three bands by log ratio) squashed a real chat's 1..3000
// spread into one band, so 90% of words got the same 5-8px reservation and the
// map read as uniform dust. 0.62 spreads the tail instead of crushing it: the
// rarest word is still a ~3px dot, but a word used 100x more is ~11px, not ~7px,
// so small words read as a gradation rather than identical dust; the landmark
// hub is capped at 68px so the top counts merge into one tier instead of one
// word towering over the map. 0.62 sits inside the old 0.42-0.7 band that once
// latticed the map — the difference is the footprint budget below, which absorbs
// the extra area by scaling the whole distribution instead of packing neighbours
// tighter. If census overlapShare regresses, retreat gamma first, not the cap.
const SIZE_MIN = 2.8
const SIZE_MAX = 68
const SIZE_GAMMA = 0.62

// Node radii are screen-referenced, so the same px law cannot serve a 30-word map
// and a 1000-word one: 1000 bodies of 15px radius cover two thirds of the canvas,
// and no layout can show clusters, voids or hierarchy inside that. The budget is
// the share of the canvas the bodies may cover; above it the WHOLE distribution
// is scaled down uniformly, so the hierarchy survives and only its screen size
// adapts to the map size. 1400x900 canvas -> ~14% coverage at the budget.
export const MAP_FOOTPRINT_PX2 = 170_000
// Never shrink below this share: dust must stay a visible dot, not a subpixel.
const FOOTPRINT_MIN_SCALE = 0.28

export function footprintScale(sizes: number[], budget: number = MAP_FOOTPRINT_PX2): number {
  let squares = 0
  for (const size of sizes) {
    const r = Math.max(0, size)
    squares += r * r
  }
  const footprint = Math.PI * squares
  // Guard: empty input or a map that already fits keeps the designed radii.
  if (footprint <= 0 || footprint <= budget) return 1
  return Math.max(FOOTPRINT_MIN_SCALE, Math.sqrt(budget / footprint))
}

// Applies the budget scale to one radius. Scaling the radius itself breaks the
// LOD law at the floor: r * s at s = 0.28 turns the 2.8px dust dot into 0.78px,
// below LOD_GONE_PX, so the word is gone instead of merely small. Scale only the
// increment above SIZE_MIN: the floor holds and the hierarchy still compresses.
export function footprintSize(r: number, scale: number): number {
  if (r <= SIZE_MIN) return r
  return SIZE_MIN + (r - SIZE_MIN) * scale
}

// Query: calculates the layout radius from word length and relative chat frequency.
// Yields reserved space of r = 68 for the most used word and r = 3.3 for the rarest.
export function nodeFitSize(
  word: string,
  count: number,
  boundA: number,
  boundB: number = 0
): number {
  const minCount = Math.min(boundA, boundB)
  const maxCount = Math.max(boundA, boundB)
  const len = Math.max(2, word ? word.length : 2)
  const fullFitRadius = Math.round(Math.max(24, len * 7.5 + 10) / 2 + 4)

  // Guard: missing counts or a uniform distribution leave no frequency axis to
  // spend, so every word gets the comfortable text-fit reservation instead.
  if (maxCount <= 0 || count <= 0 || maxCount <= minCount) {
    return Math.max(26, fullFitRadius)
  }

  const q = Math.max(0, Math.min(1, count / maxCount))
  return Math.round((SIZE_MIN + (SIZE_MAX - SIZE_MIN) * Math.pow(q, SIZE_GAMMA)) * 10) / 10
}

export function edgeWidth(w: number, wmax: number): number {
  if (wmax <= 0 || w <= 0) {
    return 0
  }
  return Math.pow(w / wmax, 0.6)
}

export function edgeColor(w: number, maxWeight: number, tint = '#e8e2d6'): string {
  // Voice thread tint: weak is faint paper shadow, strong shines brightly.
  const PAPER: [number, number, number] = [36, 34, 29]
  const h = (tint.startsWith('#') ? tint.slice(1) : tint).slice(0, 6)
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16)
  const tcol: [number, number, number] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  const mix = (k: number): [number, number, number] =>
    [PAPER[0] + (tcol[0] - PAPER[0]) * k, PAPER[1] + (tcol[1] - PAPER[1]) * k, PAPER[2] + (tcol[2] - PAPER[2]) * k].map((v) =>
      Math.round(v),
    ) as [number, number, number]
  const hex = (r: number, g: number, b: number, a: number): string =>
    `#${[r, g, b, a].map((v) => v.toString(16).padStart(2, '0')).join('')}`
  if (maxWeight <= 0 || w <= 0) {
    const [r, g, b] = mix(0.25)
    return hex(r, g, b, Math.round(0.1 * 255))
  }
  const t = Math.max(0, Math.min(1, Math.pow(w / maxWeight, 0.45)))
  const [r, g, b] = mix(0.25 + 0.75 * t)
  return hex(r, g, b, Math.round((0.1 + 0.55 * t) * 255))
}

// Glowing axon opacity: faint threads form nebular background, heavy threads form arteries.
export function edgeAlpha(w: number, wmax: number): number {
  if (wmax <= 0 || w <= 0) return 0.1
  const t = Math.max(0, Math.min(1, Math.pow(w / wmax, 0.5)))
  return 0.1 + 0.5 * t
}

// Long weak links stretch across clusters and read as noise, especially zoomed in:
// a trans-map hairline crosses the whole viewport. Dissolve them by geometric reach
// (edge length vs the map median). Strength only softens the dissolve: even the
// strongest corridor is still a line across the map, so it never gets a full veto.
// Thresholds from measurement: weak-half median reach ~2.1, strong-half ~0.35.
export function lengthFade(reach: number, strength: number): number {
  if (!(reach > 0)) return 1
  const s = Math.max(0, Math.min(1, strength))
  const t = Math.max(0, Math.min(1, (reach - 2) / (3.5 - 2)))
  const dissolve = t * t * (3 - 2 * t)
  return 1 - dissolve * (1 - 0.35 * s)
}

// A link to a rare word is weak by construction. Once that word is back on screen
// the link may return with it, but never brighter than this cap: the connection
// has to read as weak instead of competing with a corridor between two hubs.
// The cap is absolute alpha (1 = no cap), applied with Math.min, so a dim quiet
// line is never dimmed twice into invisibility.
// Overview cap kept low on purpose: a link to a rare word is a hairline, and a
// global 0.38 turned it into a corridor. Zoom-in opens the ceiling per edge, so
// the cap only governs the overview.
const WEAK_EDGE_CAP = 0.16

export function weakEdgeCeiling(weakEndpointCore: number): number {
  return 1 - (1 - WEAK_EDGE_CAP) * smallness(weakEndpointCore)
}

// Soft aura around the drawn core. Quad = core + halo is what Sigma uses for
// picking AND for the label start offset: a wide halo pushes text far off the dot
// and makes adjacent quads overlap. Keep the aura tight.
export function haloPx(core: number): number {
  return Math.min(10, Math.max(3, Math.round(core * 0.22 + 2)))
}

export function quadOf(core: number): number {
  return core + haloPx(core)
}

export function coreFrac(core: number): number {
  return core / quadOf(core)
}

// Hover growth and pin lift of the focused word, as ONE multiplier of its quad.
// Both stages are ramped by their own tween: hover ramps 0..1 (12%), pin ramps
// 0..1 (30%). Multiplicative on purpose — the pinned body stays 1.12 x 1.30 of
// the resting size, so animating the ramp does not resize the end state.
export function egoNodeScale(grow: number, promote: number): number {
  const hover = Math.max(0, Math.min(1, grow))
  const pin = Math.max(0, Math.min(1, promote))
  return (1 + 0.12 * hover) * (1 + 0.3 * pin)
}

// Shader ceiling for the drawn core share of a quad (see layerSoma: clamp(..., 0.05, 0.96)).
const FAN_CORE_MAX = 0.96

// Visible core share of a fan member. Sigma offsets a caption by half the node's
// QUAD, so the fan must NOT grow its quad to look bigger — it fills more of the
// SAME quad, which leaves every connected word's text exactly where it was.
// Dividing by the density shrink restores the body's full-size radius; the ceiling
// keeps the shader inside its quad. grow = 0 is the resting body.
// Growth is proportional to the member's OWN share: a fixed target for everyone
// would pull every small word to the same fill and erase the size hierarchy in
// the fan. Here the smallest word grows least and stays the smallest — the floor
// comes from the words themselves, not from a fixed number.
export function fanCoreFrac(base: number, lodScale: number, grow: number): number {
  const scale = Math.max(0.05, Math.min(1, lodScale))
  const target = Math.min(FAN_CORE_MAX, base / scale)
  const k = Math.max(0, Math.min(1, grow))
  return base + (target - base) * k * base
}

// Opacity of a body that touches the selected word's disc: the crowd hands the
// paper to the focus (down to a ghost), so the word is never crossed by it.
// `dim` is the focus tween 0..1 — entry and exit stay symmetric — and the test is a
// CONTINUOUS function of distance, so moving to another word slides the clearing
// instead of flashing a new set of nodes.
const YIELD_FLOOR = 0.2

function smooth01(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export function focusYield(distance: number, reach: number, ownRadius: number, dim: number): number {
  const k = Math.max(0, Math.min(1, dim))
  if (k <= 0) return 1
  const inner = Math.max(0, reach)
  const outer = inner + Math.max(0, ownRadius)
  const d = Math.max(0, distance)
  // A body with no radius has no contact band: the clearing ends at the reach.
  let touch: number
  if (outer - inner < 1e-6) {
    touch = d <= inner ? 1 : 0
  } else {
    touch = 1 - smooth01(inner, outer, d)
  }
  // Clamped: 1 - 0.8 * 1 lands on 0.19999999999999996 and the opacity styles read
  // this number directly.
  return Math.max(YIELD_FLOOR, 1 - (1 - YIELD_FLOOR) * k * touch)
}

// Edge bundling (FDEB-lite). Compatible edges share a corridor: their 1/3 and
// 2/3 subdivision points are pulled toward the group centroid, so the middle of
// every edge in the tract runs together and only the ends fan out to their nodes.
// `tract` holds dimensionless cubic-Bezier control coefficients [u1,v1,u2,v2]
// relative to (delta, perp) of the edge; it is invariant to Sigma's uniform
// coordinate normalization. `bundle` is the tract density 0..1.
export type BundlePoint = { id: number; x: number; y: number }
export type BundleEdgeInput = { a: number; b: number; weight?: number }
export type Tract = [number, number, number, number]
export type BundleInfo = { tract: Tract; bundle: number; rank: number; tractRank: number }

// Routing input straight from the layout: the funnels of the figure and which
// topic a word belongs to. Edge geometry is derived from them, so every fibre of
// one corridor runs through the same two control points.
export type RouteInfo = {
  ports: Map<number, { x: number; y: number }>
  groupOf: Map<number, number>
  // Fascicle id per node (stem contract §2.1). Absent = today's corridor routing.
  stemOf?: Map<number, number>
}

type Pt = { x: number; y: number }

// A fascicle's trunk, derived once from the placed nodes. `hub` is the soma port of
// the stem's owner, `dir`/`maxR` describe the arm it grows along. Every edge of one
// fascicle shares the first control point, which is what turns a searchlight fan of
// 200 different curves into one axon.
type Spine = { hub: Pt; dx: number; dy: number; maxR: number }

// Shared control sits 30% down the arm: the fibres are fused from the soma, i.e.
// where the eye reads a trunk, and only start to part after that point.
const SPINE_NEAR = 0.3
// 86% of the reach before the curve commits to its own terminal: the split happens
// at the tip, so the branch keeps the trunk for most of its length.
const SPINE_TRUNK = 0.86
// A fascicle packed inside 2 world units of its soma has no arm to bundle.
const SPINE_MIN_R = 2
// Terminals past the fascicle's own reach still split near the arm's end.
const SPINE_PROJ_CAP = 1.15
// Radius exponent of the direction mean: a far, heavy node outvotes a stray near
// the soma, which is what keeps the arm pointing along the tissue, not at it.
const SPINE_WEIGHT = 0.2

// Query: the shared trunk controls of an edge whose ends ride one fascicle, or null
// when the edge is not on a trunk (no spine, or the terminal never clears the neck).
function trunkControls(
  a: Pt,
  b: Pt,
  stemA: number | undefined,
  stemB: number | undefined,
  spines: Map<number, Spine>,
): { c1: Pt; c2: Pt } | null {
  if (stemA === undefined || stemB === undefined || stemA < 0 || stemB < 0) return null
  const owner = Math.floor(stemA / 16)
  const slotA = stemA % 16
  const slotB = stemB % 16
  // §2.1: same owner and either the same slot or one end is the soma (slot 0).
  if (owner !== Math.floor(stemB / 16) || (slotA !== slotB && slotA !== 0 && slotB !== 0)) return null
  const spine = spines.get(owner * 16 + Math.max(slotA, slotB))
  if (!spine) return null
  // The terminal is whichever end sits farther along the arm, never "b". Edge ids are
  // canonicalised min-first upstream, so a hub edge is stored (leaf, hub) as often as
  // (hub, leaf); keying on `b` alone silently un-bundled half of every hub's fibres.
  const reachA = (a.x - spine.hub.x) * spine.dx + (a.y - spine.hub.y) * spine.dy
  const reachB = (b.x - spine.hub.x) * spine.dx + (b.y - spine.hub.y) * spine.dy
  const termIsB = reachB >= reachA
  const reach = termIsB ? reachB : reachA
  // Guard: a terminal that does not clear the shared neck has no trunk to ride —
  // routing it through the neck would loop the fibre out past its own node and back.
  if (reach < SPINE_NEAR * spine.maxR * 1.2) return null
  const proj = Math.min(reach, spine.maxR * SPINE_PROJ_CAP)
  const term = termIsB ? b : a
  const neck: Pt = {
    x: spine.hub.x + spine.dx * SPINE_NEAR * spine.maxR,
    y: spine.hub.y + spine.dy * SPINE_NEAR * spine.maxR,
  }
  const split: Pt = {
    x: SPINE_TRUNK * (spine.hub.x + spine.dx * proj) + (1 - SPINE_TRUNK) * term.x,
    y: SPINE_TRUNK * (spine.hub.y + spine.dy * proj) + (1 - SPINE_TRUNK) * term.y,
  }
  // Controls stay ordered along the path a -> b, so the late split always sits next
  // to the terminal whichever end that is.
  return termIsB ? { c1: neck, c2: split } : { c1: split, c2: neck }
}

const STRAIGHT_TRACT: Tract = [1 / 3, 0, 2 / 3, 0]
// Intra-nucleus fibres lean toward the soma: the near control sits 75% of the
// way to the port and the far one 25% of the way there. Audit #7: with leaf
// landmarks a port sits inside a loose zone, not in a dense soma — a full pull
// overshoots into loops on short edges. Both at the port would double the line
// back on itself (a hairpin); part-way controls give a dendrite that leaves
// the soma and settles on its word.
const INTRA_NEAR_PULL = 0.75
const INTRA_FAR_PULL = 0.25
// Lateral half-width of a corridor, in world units. Fibres of one corridor must
// sit on top of each other to read as ONE nerve; 2 units stays sub-pixel at the
// overview and only separates inside a zoom, which is where the liquid texture is
// wanted. (6 units left visible parallel hairlines — the noise the map was called out for.)
const CORRIDOR_FAN = 2
// Coefficient guards. They must be wide: a soma port often sits far outside the
// chord of a long link, and clamping it to the segment was what kept every fibre
// straight (measured: the bundle never formed). A cubic stays inside the convex
// hull of its controls, so a wide clamp cannot overshoot the figure.
const MAX_U = 5
const MIN_U = -4
const MAX_V = 3
// Gateways per figure width. Control points are snapped to a grid of this many
// cells across the figure, so ports of neighbouring nuclei share ONE trunk instead
// of drawing a ribbon of near-parallel arcs. 12 keeps each cell at roughly half a
// nucleus, which merges neighbours without merging opposite ends of the map.
export const GATEWAY_CELLS = 14

// Query: grid centre a world point snaps to. Two ports inside one cell give the
// same answer, which is what turns several corridors into one trunk.
function gatewayOf(p: { x: number; y: number }, cell: number): { x: number; y: number } {
  // Guard: a degenerate figure has no grid; the exact port is the answer.
  if (!(cell > 0)) return p
  return {
    x: (Math.floor(p.x / cell) + 0.5) * cell,
    y: (Math.floor(p.y / cell) + 0.5) * cell,
  }
}

// Query: cubic control coefficients in the edge's own (delta, perp) basis.
// Dimensionless, so Sigma's uniform coordinate normalisation and the camera
// transform leave the curve intact — see pathTract in neural.ts.
function tractFromControls(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c1: { x: number; y: number },
  c2: { x: number; y: number },
  fan: number,
): Tract {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  // Guard: a zero-length chord has no basis; the straight tract is the answer.
  if (len2 < 1e-8) return [...STRAIGHT_TRACT] as Tract
  const len = Math.sqrt(len2)
  const u = (p: { x: number; y: number }) => ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  const v = (p: { x: number; y: number }) => ((p.x - a.x) * -dy + (p.y - a.y) * dx) / len2
  const clampU = (value: number) => Math.max(MIN_U, Math.min(MAX_U, value))
  const clampV = (value: number) => Math.max(-MAX_V, Math.min(MAX_V, value))
  // The fan offset is applied in world units and converted to the dimensionless
  // normal coefficient, so a corridor is 2*CORRIDOR_FAN wide at any map scale.
  const spread = fan / len
  return [clampU(u(c1)), clampV(v(c1) + spread), clampU(u(c2)), clampV(v(c2) + spread)]
}

// Command: assigns one cubic "tract" per edge. Two words of the same topic pair
// get the SAME control points, so their curves land on top of each other and
// accumulate into one bundle; inside a topic the curve only leans toward its own
// nucleus. This replaces the mean-shift over angular sectors: the corridor is now
// known from the structure instead of guessed from geometry.
export function bundleEdges(
  points: BundlePoint[],
  edges: BundleEdgeInput[],
  // Kept in the signature for callers that still pass the selection's max weight;
  // ranking is now derived from the weights themselves, so the bound is unused.
  _maxWeight = 0,
  routes?: RouteInfo,
): BundleInfo[] {
  const pos = new Map(points.map((p) => [p.id, p]))
  const ports = routes?.ports
  const groupOf = routes?.groupOf
  const stemOf = routes?.stemOf

  // Fascicle trunks, derived once per call (never per edge). Accumulating the
  // direction as a radius-weighted sum is what keeps the arm pointing along the
  // tissue: the far, heavy nodes outvote anything bunched near the soma.
  const spines = new Map<number, Spine>()
  if (stemOf && ports) {
    const acc = new Map<number, { sx: number; sy: number; maxR: number; hub: Pt }>()
    for (const p of points) {
      const stem = stemOf.get(p.id)
      if (stem === undefined || stem < 0) continue
      // Slot 0 is the soma itself: it carries no arm and would only drag the mean.
      if (stem % 16 === 0) continue
      const hub = ports.get(Math.floor(stem / 16))
      if (!hub) continue
      const dx = p.x - hub.x
      const dy = p.y - hub.y
      const r = Math.hypot(dx, dy)
      if (!(r > 0)) continue
      const entry = acc.get(stem) ?? { sx: 0, sy: 0, maxR: 0, hub }
      const w = Math.pow(r, SPINE_WEIGHT)
      entry.sx += dx * w
      entry.sy += dy * w
      if (r > entry.maxR) entry.maxR = r
      acc.set(stem, entry)
    }
    for (const [stem, entry] of acc) {
      // No arm to bundle: a fascicle huddled on its soma keeps today's routing.
      if (entry.maxR < SPINE_MIN_R) continue
      const len = Math.hypot(entry.sx, entry.sy)
      // Degenerate mean (a ring around the hub): fall back to the +x arm instead of
      // dropping the trunk, which would split one fascicle into two behaviours.
      const dx = len > 1e-9 ? entry.sx / len : 1
      const dy = len > 1e-9 ? entry.sy / len : 0
      spines.set(stem, { hub: entry.hub, dx, dy, maxR: entry.maxR })
    }
  }

  // Rank by weight (heaviest first): the renderer spends detail on rank 0.
  const order = edges
    .map((edge, index) => ({ edge, index }))
    .sort(
      (l, r) =>
        (r.edge.weight ?? 0) - (l.edge.weight ?? 0) ||
        l.edge.a - r.edge.a ||
        l.edge.b - r.edge.b,
    )
  const rank = new Array<number>(edges.length).fill(0)
  order.forEach((item, i) => {
    rank[item.index] = i
  })

  // Corridors: one bucket per unordered topic pair (or per topic, for a link
  // inside a nucleus). Counting first is what makes the fan deterministic.
  const corridorOf = edges.map((edge) => {
    const ga = groupOf?.get(edge.a)
    const gb = groupOf?.get(edge.b)
    if (ga === undefined || gb === undefined) return null
    if (ga === gb) return `${ga}:${ga}`
    return ga < gb ? `${ga}:${gb}` : `${gb}:${ga}`
  })
  const size = new Map<string, number>()
  for (const key of corridorOf) if (key) size.set(key, (size.get(key) ?? 0) + 1)
  const maxSize = Math.max(1, ...size.values())
  const seen = new Map<string, number>()

// Gateway grid, in world units, derived from the drawn extent so the same
// constant works on a 270-word map and on a 1000-word one.
// Leaf-tissue map (P1): 14 — on a 2D sheet 12 cells merge neighbouring
// inter-zone tracts into one crude trunk along the diagonal.
  let extent = 0
  if (points.length > 0) {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of points) {
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }
    extent = Math.max(maxX - minX, maxY - minY)
  }
  const cell = extent > 0 ? extent / GATEWAY_CELLS : 0

  return edges.map((edge, index) => {
    const a = pos.get(edge.a)
    const b = pos.get(edge.b)
    const key = corridorOf[index]
    const count = key ? size.get(key) ?? 1 : 1
    const seenCount = key ? seen.get(key) ?? 0 : 0
    if (key) seen.set(key, seenCount + 1)
    const bundle = count > 1 ? count / maxSize : 0
    const tractRank = count > 1 ? seenCount : 0
    // Guard: a link whose ends are not both placed cannot be routed.
    if (!a || !b) {
      return { tract: [...STRAIGHT_TRACT] as Tract, bundle, rank: rank[index], tractRank }
    }
    // Symmetric fan: rank 0 of the corridor sits a few units off-centre, the last
    // one mirrors it, so the bundle reads as a thick strand instead of one hairline.
    const fan = count > 1 ? ((seenCount / (count - 1)) * 2 - 1) * CORRIDOR_FAN : 0
    // Fascicle trunk first: every fibre of one stem leaves the soma along the SAME
    // arm and only splits at its own terminal, so it needs no port/gateway at all.
    const trunk = stemOf ? trunkControls(a, b, stemOf.get(edge.a), stemOf.get(edge.b), spines) : null
    if (trunk) {
      return {
        tract: tractFromControls(a, b, trunk.c1, trunk.c2, fan),
        bundle,
        rank: rank[index],
        tractRank,
      }
    }
    const ga = groupOf?.get(edge.a)
    const gb = groupOf?.get(edge.b)
    const portA = ga === undefined ? undefined : ports?.get(ga)
    const portB = gb === undefined ? undefined : ports?.get(gb)
    // Same nucleus: a dendrite that leaves the soma and settles on its word.
    if (ga !== undefined && ga === gb && portA) {
      return {
        tract: tractFromControls(
          a,
          b,
          { x: a.x + (portA.x - a.x) * INTRA_NEAR_PULL, y: a.y + (portA.y - a.y) * INTRA_NEAR_PULL },
          { x: b.x + (portA.x - b.x) * INTRA_FAR_PULL, y: b.y + (portA.y - b.y) * INTRA_FAR_PULL },
          fan,
        ),
        bundle,
        rank: rank[index],
        tractRank,
      }
    }
    if (!portA || !portB) {
      return { tract: [...STRAIGHT_TRACT] as Tract, bundle, rank: rank[index], tractRank }
    }
    // The corridor IS the chord between the two gateways: both controls sit exactly
    // there. Every fibre of this topic pair therefore runs the same path from just
    // outside its word to just outside the partner word, so a hundred links read as
    // ONE trunk. Gateways (not raw ports) are what merge NEIGHBOURING nuclei's
    // corridors into the same trunk instead of a ribbon of near-parallel arcs.
    return {
      tract: tractFromControls(a, b, gatewayOf(portA, cell), gatewayOf(portB, cell), fan),
      bundle,
      rank: rank[index],
      tractRank,
    }
  })
}

export type ArmsIndex = {
  pos: Map<number, { x: number; y: number }>
  adj: Map<number, Array<{ nid: number; weight: number }>>
}

// Adjacency index built once per layout: per-node queries drop from O(E) to
// O(degree). The worker builds it once instead of rescanning all edges per node.
export function buildArmsIndex(
  nodes: Array<{ id: number; x: number; y: number }>,
  edges: Array<{ a: number; b: number; weight: number }>
): ArmsIndex {
  const pos = new Map(nodes.map((n) => [n.id, n]))
  const adj = new Map<number, Array<{ nid: number; weight: number }>>()
  const link = (from: number, to: number, weight: number) => {
    let list = adj.get(from)
    if (!list) {
      list = []
      adj.set(from, list)
    }
    list.push({ nid: to, weight })
  }
  for (const e of edges) {
    if (!pos.has(e.a) || !pos.has(e.b)) continue
    link(e.a, e.b, e.weight)
    link(e.b, e.a, e.weight)
  }
  return { pos, adj }
}

export function armsFromIndex(index: ArmsIndex, id: number): number[] {
  const me = index.pos.get(id)
  if (!me) return [-1, -1, -1, -1, -1]
  const neighbours = [...(index.adj.get(id) ?? [])]
  neighbours.sort((x, y) => y.weight - x.weight || x.nid - y.nid)
  const arms = neighbours.slice(0, 5).map(({ nid }) => {
    const p = index.pos.get(nid)!
    const turns = Math.atan2(p.y - me.y, p.x - me.x) / (Math.PI * 2)
    return ((turns % 1) + 1) % 1
  })
  while (arms.length < 5) arms.push(-1)
  return arms
}

// Deterministic pulsation phase based on node id.
export function phaseFor(id: number): number {
  return (Math.imul(id, 2654435761) >>> 0) / 4294967296
}
