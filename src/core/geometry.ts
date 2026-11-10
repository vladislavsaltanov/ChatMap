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
export function visualCoreRadius(layoutRadius: number): number {
  const r = Math.max(0, layoutRadius)
  return r <= 9 ? r : 9 + (r - 9) * 0.46
}

// Query: calculates the layout radius from word length and relative chat frequency.
// Yields reserved space of r = 72+ for landmark hubs and r = 5..9 for rare words.
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

  // Guard: missing counts or uniform distribution fallback to comfortable text fit
  if (maxCount <= 0 || count <= 0 || maxCount <= minCount) {
    return Math.max(26, fullFitRadius)
  }

  // Relative log-ratio across visible words in the chat: t in [0, 1]
  const logMin = Math.log(1 + Math.max(0, minCount))
  const logMax = Math.log(1 + maxCount)
  const logVal = Math.log(1 + count)

  // Guard: invalid log range avoids division by zero
  if (logMax <= logMin) {
    return Math.max(26, fullFitRadius)
  }

  const t = Math.max(0, Math.min(1, (logVal - logMin) / (logMax - logMin)))

  // Reserve layout space with high dynamic range (Obsidian-like contrast):
  // Rare words (t < 0.3) -> small compact dots (r = 5..9) whose labels hide until zoom-in
  // Medium words (0.3 <= t < 0.7) -> moderate circles (r = 9..24)
  // Top landmark words (t >= 0.7) -> dominant hubs (r = 26..72+).
  // The drawn radius is compressed by visualCoreRadius(); these are reservation radii.
  if (t < 0.30) {
    return Math.round(5 + 4 * (t / 0.30))
  }
  if (t < 0.70) {
    const p = (t - 0.30) / 0.40
    return Math.round(9 + 15 * p)
  }
  const p = (t - 0.70) / 0.30
  const minHub = 26
  // Top landmark hubs reach at least r = 72 to visually anchor the celestial graph
  const target = Math.max(72, fullFitRadius)
  return Math.round(minHub + (target - minHub) * Math.pow(p, 0.65))
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

const STRAIGHT_TRACT: Tract = [1 / 3, 0, 2 / 3, 0]
const SECTORS = 8
const TAU = Math.PI * 2
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

type TractGeom = {
  ax: number; ay: number; bx: number; by: number
  fromX: number; fromY: number; toX: number; toY: number
  dx: number; dy: number; len2: number; len: number; ux: number; uy: number; strength: number
  hubAtA: boolean; key: string; passKey: string
  p1x: number; p1y: number; p2x: number; p2y: number
}
type TractCell = { n: number; w: number; x1: number; y1: number; x2: number; y2: number }

export function bundleEdges(
  points: BundlePoint[],
  edges: BundleEdgeInput[],
  maxWeight = 0,
): BundleInfo[] {
  const out: BundleInfo[] = edges.map(() => ({
    tract: [...STRAIGHT_TRACT] as Tract, bundle: 0, rank: 0, tractRank: 0,
  }))
  const pos = new Map(points.map((p) => [p.id, p]))

  // A tract belongs to one hub and one outgoing sector: local by construction,
  // so long cross-map links are never dragged into a neighbours' corridor.
  const degree = new Map<number, number>()
  for (const e of edges) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1)
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1)
  }

  const geom: Array<TractGeom | null> = edges.map((e) => {
    const a = pos.get(e.a)
    const b = pos.get(e.b)
    if (!a || !b) return null
    const da = degree.get(e.a) ?? 0
    const db = degree.get(e.b) ?? 0
    const hubAtA = da > db || (da === db && e.a <= e.b)
    const from = hubAtA ? a : b
    const to = hubAtA ? b : a
    const fx = to.x - from.x
    const fy = to.y - from.y
    const len2 = fx * fx + fy * fy
    if (len2 < 1e-8) return null
    const theta = ((Math.atan2(fy, fx) % TAU) + TAU) % TAU
    // Rounding (not flooring) wraps sector 0 around the 0/2PI seam.
    const sector = Math.round(theta / (TAU / SECTORS)) % SECTORS
    return {
      ax: a.x, ay: a.y, bx: b.x, by: b.y,
      fromX: from.x, fromY: from.y, toX: to.x, toY: to.y,
      dx: b.x - a.x, dy: b.y - a.y, len2, len: Math.sqrt(len2),
      ux: fx / Math.sqrt(len2), uy: fy / Math.sqrt(len2),
      strength: maxWeight > 0 && e.weight ? Math.pow(clamp(e.weight / maxWeight, 0, 1), 0.6) : 0.5,
      hubAtA,
      key: `${hubAtA ? e.a : e.b}:${sector}`,
      passKey: '',
      p1x: from.x + fx / 3, p1y: from.y + fy / 3,
      p2x: from.x + 2 * fx / 3, p2y: from.y + 2 * fy / 3,
    }
  })

  // Two mean-shift passes: P1 and P2 of one tract converge to their own
  // centroids, so the middle third of every fibre shares the same corridor.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const cell = Math.max(1e-6, Math.max(maxX - minX, maxY - minY, 1)) / 8

  for (const pass of [0, 1, 2]) {
    const groups = new Map<string, TractCell>()
    const axis = new Map<string, { dx: number; dy: number }>()
    // Pass 0 gathers the fibres of one hub; passes 1-2 dominate and merge
    // parallel nearby edges of DIFFERENT hubs into one long corridor — this is
    // the FDEB signature. A hub-only grouping produced a starburst, not a tract.
    geom.forEach((g) => {
      if (!g) return
      let key = g.key
      if (pass > 0) {
        const mx = (g.p1x + g.p2x) / 2
        const my = (g.p1y + g.p2y) / 2
        const raw = Math.atan2(g.dy, g.dx)
        const half = ((raw % Math.PI) + Math.PI) % Math.PI
        const dir = Math.round(half / (Math.PI / 6)) % 6
        key = `c${dir}:${Math.floor(mx / cell)}:${Math.floor(my / cell)}`
      }
      const c = groups.get(key) ?? { n: 0, w: 0, x1: 0, y1: 0, x2: 0, y2: 0 }
      const w = 0.5 + 0.5 * g.strength
      c.n++
      c.w += w
      c.x1 += g.p1x * w; c.y1 += g.p1y * w
      c.x2 += g.p2x * w; c.y2 += g.p2y * w
      groups.set(key, c)
      if (pass === 0) {
        const a = axis.get(key) ?? { dx: 0, dy: 0 }
        a.dx += g.ux * w
        a.dy += g.uy * w
        axis.set(key, a)
      }
      g.passKey = key
    })

    geom.forEach((g, i) => {
      if (!g) return
      const c = groups.get(g.passKey)!
      if (c.n < 2 || c.w <= 0) return
      const density = Math.min(1, (c.n - 1) / 6)
      // Strong links must converge too: they are the visible spine, and a
      // straight spine between curved fibres reads as a scattered starburst.
      const base = pass === 0 ? 0.78 : pass === 1 ? 0.92 : 0.82
      const pull = base * density * (0.8 + 0.2 * g.strength)
      let m1x = c.x1 / c.w
      let m1y = c.y1 / c.w
      let m2x = c.x2 / c.w
      let m2y = c.y2 / c.w
      if (pass === 0) {
        // Hub tract: every fibre leaves along ONE shared axis and only peels
        // off toward its own node near the end. Scaling by each edge's own
        // length avoids the shortening cusps a plain centroid would create.
        const a = axis.get(g.passKey)!
        const al = Math.hypot(a.dx, a.dy) || 1
        const ux = a.dx / al
        const uy = a.dy / al
        m1x = g.fromX + ux * g.len / 3
        m1y = g.fromY + uy * g.len / 3
        m2x = g.fromX + ux * 2 * g.len / 3
        m2y = g.fromY + uy * 2 * g.len / 3
      }
      // Lanes keep individual fibres visible inside the merged tract.
      const ax = m2x - m1x
      const ay = m2y - m1y
      const alen = Math.hypot(ax, ay) || 1
      const lane = (Math.imul(i + 1, 0x9e3779b1) >>> 0) / 4294967296 - 0.5
      const off = lane * cell * 0.005
      const ox = (-ay / alen) * off
      const oy = (ax / alen) * off
      g.p1x += pull * (m1x + ox - g.p1x)
      g.p1y += pull * (m1y + oy - g.p1y)
      g.p2x += pull * (m2x + ox - g.p2x)
      g.p2y += pull * (m2y + oy - g.p2y)
      out[i].bundle = Math.max(out[i].bundle, density)
    })
  }

  // Final snap: nearby passing lines are glued at EVERY LOD. Geometry is
  // computed once in the worker, so this cannot be a style/zoom trick.
  // Control points are expressed in the edge's own normalized chord basis,
  // which makes edges of different lengths comparable without cusps.
  type SnapCell = { n: number; w: number; a1: number; b1: number; a2: number; b2: number }
  type SnapGeom = { i: number; ux: number; uy: number; vx: number; vy: number; len: number; fx: number; fy: number }
  const snapCell = cell * 2
  const snapGroups = new Map<string, SnapCell>()
  const snapItems = new Map<string, SnapGeom[]>()
  geom.forEach((g, i) => {
    if (!g) return
    const ux = g.ux, uy = g.uy
    const vx = -uy, vy = ux
    const len = g.len
    const d1x = g.p1x - g.fromX, d1y = g.p1y - g.fromY
    const d2x = g.p2x - g.fromX, d2y = g.p2y - g.fromY
    const a1 = (d1x * ux + d1y * uy) / len
    const b1 = (d1x * vx + d1y * vy) / len
    const a2 = (d2x * ux + d2y * uy) / len
    const b2 = (d2x * vx + d2y * vy) / len
    const half = ((Math.atan2(uy, ux) % Math.PI) + Math.PI) % Math.PI
    const dir = Math.round(half / (Math.PI / 6)) % 6
    const mx = (g.fromX + g.toX) / 2
    const my = (g.fromY + g.toY) / 2
    const key = `s${dir}:${Math.floor(mx / snapCell)}:${Math.floor(my / snapCell)}`
    const w = 0.5 + 0.5 * g.strength
    const c = snapGroups.get(key) ?? { n: 0, w: 0, a1: 0, b1: 0, a2: 0, b2: 0 }
    c.n++; c.w += w
    c.a1 += a1 * w; c.b1 += b1 * w
    c.a2 += a2 * w; c.b2 += b2 * w
    snapGroups.set(key, c)
    const items = snapItems.get(key) ?? []
    items.push({ i, ux, uy, vx, vy, len, fx: g.fromX, fy: g.fromY })
    snapItems.set(key, items)
  })
  for (const [key, c] of snapGroups) {
    if (c.n < 2 || c.w <= 0) continue
    const ma1 = c.a1 / c.w, mb1 = c.b1 / c.w
    const ma2 = c.a2 / c.w, mb2 = c.b2 / c.w
    const density = Math.min(1, (c.n - 1) / 6)
    for (const it of snapItems.get(key)!) {
      const g = geom[it.i]!
      const s1x = it.fx + (ma1 * it.ux + mb1 * it.vx) * it.len
      const s1y = it.fy + (ma1 * it.uy + mb1 * it.vy) * it.len
      const s2x = it.fx + (ma2 * it.ux + mb2 * it.vx) * it.len
      const s2y = it.fy + (ma2 * it.uy + mb2 * it.vy) * it.len
      g.p1x += 0.94 * (s1x - g.p1x)
      g.p1y += 0.94 * (s1y - g.p1y)
      g.p2x += 0.94 * (s2x - g.p2x)
      g.p2y += 0.94 * (s2y - g.p2y)
      out[it.i].bundle = Math.max(out[it.i].bundle, density)
    }
  }

  geom.forEach((g, i) => {
    // Edges outside any tract keep the exact straight chord.
    if (!g || out[i].bundle === 0) return
    // Cubic Bezier through P1 at t=1/3 and P2 at t=2/3, oriented hub -> target.
    let k1x = 3 * g.p1x - 1.5 * g.p2x - (5 / 6) * g.fromX + (1 / 3) * g.toX
    let k1y = 3 * g.p1y - 1.5 * g.p2y - (5 / 6) * g.fromY + (1 / 3) * g.toY
    let k2x = 3 * g.p2x - 1.5 * g.p1x - (5 / 6) * g.toX + (1 / 3) * g.fromX
    let k2y = 3 * g.p2y - 1.5 * g.p1y - (5 / 6) * g.toY + (1 / 3) * g.fromY
    // Bound control points by a fraction of the chord length. Clamping raw
    // coefficients independently produced cusps ("kinks") on the tract spines.
    const maxOff = 0.26 * Math.sqrt(g.len2)
    const ax = g.toX - g.fromX
    const ay = g.toY - g.fromY
    const s1x = g.fromX + ax / 3, s1y = g.fromY + ay / 3
    const s2x = g.fromX + 2 * ax / 3, s2y = g.fromY + 2 * ay / 3
    const limit = (px: number, py: number, sx: number, sy: number): [number, number] => {
      const vx = px - sx
      const vy = py - sy
      const d = Math.hypot(vx, vy)
      if (d <= maxOff) return [px, py]
      const k = maxOff / d
      return [sx + vx * k, sy + vy * k]
    }
    ;[k1x, k1y] = limit(k1x, k1y, s1x, s1y)
    ;[k2x, k2y] = limit(k2x, k2y, s2x, s2y)
    // Sigma's source is `a`; swap control points when the hub was `b`.
    const c1x = g.hubAtA ? k1x : k2x
    const c1y = g.hubAtA ? k1y : k2y
    const c2x = g.hubAtA ? k2x : k1x
    const c2y = g.hubAtA ? k2y : k1y
    const px = -g.dy
    const py = g.dx
    out[i].tract = [
      clamp(((c1x - g.ax) * g.dx + (c1y - g.ay) * g.dy) / g.len2, -0.1, 1.1),
      clamp(((c1x - g.ax) * px + (c1y - g.ay) * py) / g.len2, -0.3, 0.3),
      clamp(((c2x - g.ax) * g.dx + (c2y - g.ay) * g.dy) / g.len2, -0.1, 1.1),
      clamp(((c2x - g.ax) * px + (c2y - g.ay) * py) / g.len2, -0.3, 0.3),
    ]
  })

  // On the overview only the spine of a tract is readable: rank 0 is its
  // heaviest link, higher ranks are redundant fibres on the same corridor.
  const byTract = new Map<string, number[]>()
  geom.forEach((g, i) => {
    if (!g) return
    const list = byTract.get(g.key) ?? []
    list.push(i)
    byTract.set(g.key, list)
  })
  for (const list of byTract.values()) {
    list.sort((x, y) => (geom[y] as TractGeom).strength - (geom[x] as TractGeom).strength || x - y)
    list.forEach((i, rank) => { out[i].rank = rank })
  }

  // The overview is a skeleton of the few heaviest TRACTS, not one stray fibre
  // from every tract. Rank whole corridors by their total connection weight.
  const weights = new Map<string, number>()
  geom.forEach((g) => {
    if (!g) return
    weights.set(g.key, (weights.get(g.key) ?? 0) + g.strength + 0.05)
  })
  const ordered = [...weights.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  const tractOrder = new Map(ordered.map(([key], i) => [key, i]))
  geom.forEach((g, i) => {
    if (g) out[i].tractRank = tractOrder.get(g.key) ?? 0
  })

  return out
}

// Neuron dendrites: angles (in turns 0..1) to top 5 heaviest neighbors. -1 means no arm.
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
