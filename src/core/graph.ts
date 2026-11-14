import { quadOf, visualCoreRadius } from './geometry'
import { FRAME_ASPECT, hashAt, spread } from './spread'

// World units per px of node radius that the collision solver may assume.
const MAX_SCALE_FACTOR = 10

// Reference viewport span in screen px. Node radii are screen-referenced
// (`itemSizesReference: 'screen'`), so the layout must express its collision
// clearance in the same px -> world factor it uses for the positions.
// Exported because the renderer-frame invariant is asserted by tests.
export const LAYOUT_SCREEN_SPAN = 1300
// Air between two drawn bodies, in screen px. The reservation is body + air: the
// dashed orbit sits at the core radius and the aura reaches `haloPx` past it, so
// reserving only the core made neighbouring rings interlock on small maps.
const NODE_GAP_PX = 2.5
const NODE_GAP_RATIO = 0.6

// Solver budget for a fresh figure. The spread already seats words on strands so
// the solver only has to separate accidental overlaps; the old pipeline needed
// 140-360 passes because its own steps kept re-packing the frame.
const SOLVER_PASSES = 28

// Query: air a node of this drawn radius reserves around itself, in screen px.
// Proportional to the body, so the visual gap/diameter ratio stays constant at
// every map size — the bodies themselves shrink with the footprint budget, and a
// fixed px gap would look tight on small maps and eat the clusters on big ones.
function airFor(size: number): number {
  return Math.max(NODE_GAP_PX, size * NODE_GAP_RATIO)
}

// Query: air multiplier by reservation size. Neural texture lives in UNEVEN air:
// dust huddles into tight knots around hubs while hubs keep their distance, so
// the gaps stay open. Uniform air gives every pair the same gap/diameter rhythm
// and the eye reads an even field at any zoom — the "petals" complaint.
export function dustTight(size: number): number {
  return size < 12 ? 0.45 : 1.15
}

// Query: radius the layout must reserve for one body, in screen px. `size` is the
// text-fit reservation (room for a caption), but the renderer draws
// `visualCoreRadius(size)` plus a halo, and for a small word that aura is wider
// than `size`. Reserving only `size` is why neighbouring rings interlocked while
// the pure body clearance looked satisfied.
export function reservePx(size: number): number {
  return Math.max(size, quadOf(visualCoreRadius(size)))
}

// Fixed-capacity LRU kept for the incremental path: the worker stores the canon
// form of a word -> its coordinates, and a filtered re-run reads them back.
export function getLruCache<K, V>(map: Map<K, V>, key: K): V | undefined {
  const value = map.get(key)
  if (value === undefined) return undefined
  map.delete(key)
  map.set(key, value)
  return value
}

export function setLruCache<K, V>(map: Map<K, V>, key: K, value: V, maxEntries = 2000): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > Math.max(maxEntries, 0)) map.delete(map.keys().next().value as K)
}

export type LayoutNodeInput = {
  id: number
  size?: number
  prevXY?: { x: number; y: number }
}

export type LayoutEdgeInput = {
  a: number
  b: number
  weight: number
}

export type LayoutOpts = {
  seed: number
  fullRun: boolean
  iterations?: number
  onStage?: (done: number, stage: string) => void
}

export type LayoutPort = { x: number; y: number; mass: number; members: number }

export type LayoutResult = {
  positions: Map<number, { x: number; y: number }>
  iterationsDone: number
  // Routing data for the edge layer: the funnels of the figure and which topic a
  // word belongs to. Edge geometry uses them so fibres of one corridor coincide.
  ports?: Map<number, LayoutPort>
  groupOf?: Map<number, number>
  corridors?: Map<string, number>
  // Soft-zone sharpness per node (audit B3): the solver keeps sulci between
  // clean representatives and leaves bridges stitched.
  dominance?: Map<number, number>
  // Fascicle identity per node (impl-plan §2.1): geometry routes edges along a
  // shared trunk, so it must survive the layout result, not just the solver.
  stemOf?: Map<number, number>
}

export function collisionIterationsForCount(nodeCount: number): number {
  return nodeCount <= 400 ? 80 : 30
}

// Uniformly fits the cloud into a square frame of `targetSpan`, centred. The
// transform is the same one the renderer applies when it fits the content, so
// running it here is what makes every collision lane below honest on screen.
// Shape is preserved: it is a scale, never a deformation.
export function fitToSpan(points: Array<{ x: number; y: number }>, targetSpan: number): void {
  if (points.length === 0 || !(targetSpan > 0)) return
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const w = maxX - minX
  const h = maxY - minY
  const span = Math.max(w, h)
  // Guard: a single point (or a degenerate cloud) has nothing to scale.
  if (!(span > 0) || !Number.isFinite(span)) return
  const s = targetSpan / span
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  for (const p of points) {
    p.x = (p.x - cx) * s
    p.y = (p.y - cy) * s
  }
}

function measuredSpan(points: Array<{ x: number; y: number }>): number {
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
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return 0
  return Math.max(maxX - minX, maxY - minY)
}

export type SolverOpts = {
  // Snapshot to pull toward after every pass: hubs stand still, dust walks.
  anchors?: Map<number, { x: number; y: number }>
  // Zone tags for sulci: cross-zone pairs of clean representatives keep extra air.
  groupOf?: Map<number, number>
  dominance?: Map<number, number>
  // Extra clearance between clean zones (audit B3): bridges get none.
  sulcusPad?: number
  // Fascicle id per node (stem contract §2.1). Absent = today's uniform clearance.
  stemOf?: Map<number, number>
  // World-unit gap between two clean nodes of DIFFERENT fascicles: 0 = off.
  cleftPad?: number
}

// Bodies of one fascicle may interlock: 88% of their reserved radii still keeps
// every drawn core apart, and the shared 12% is what makes a strand read as ONE
// nerve instead of a row of beads. Safe for S4, which compares raw `size` while
// the solver reserves `reservePx(size) >= size` plus air.
const SAME_STEM_PACK = 0.88

// Radius compression factor for the dust tail: past the P90 radius the tail is
// squeezed toward this multiple of it. 1.45 keeps real structure (a hub stratum can
// sit wide) while stopping a few leaves from owning the frame.
const TAIL_CAP = 1.2

// Command: pulls the dust tail inside the frame. The renderer normalises the map by
// its bounding box, so a few low-degree leaves on the rim cost the whole tissue its
// scale (real export: the outermost 10% of nodes owned 60% of the width). The radius
// past P90 is compressed monotonically with an asymptote, so the order of points
// along a ray never changes; whatever this tightens, the collision passes either
// side of it clear again.
function containTail(points: Array<{ x: number; y: number }>): void {
  const n = points.length
  // Guard: too few points to have a mass and a tail at all.
  if (n < 8) return
  const median = (values: number[]): number => {
    const s = [...values].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.5))]!
  }
  const cx = median(points.map((p) => p.x))
  const cy = median(points.map((p) => p.y))
  const radii = points.map((p) => Math.hypot(p.x - cx, p.y - cy)).sort((a, b) => a - b)
  const r0 = radii[Math.min(radii.length - 1, Math.floor(radii.length * 0.9))]!
  // Guard: a collapsed cloud has no tail worth containing.
  if (!(r0 > 1e-6)) return
  const knee = r0 * (TAIL_CAP - 1)
  for (const p of points) {
    const dx = p.x - cx
    const dy = p.y - cy
    const r = Math.hypot(dx, dy)
    if (r <= r0) continue
    const over = r - r0
    // Strictly increasing in `over` and always below `r`: shrink only, never reorder.
    const k = (r0 + (over * knee) / (knee + over)) / r
    p.x = cx + dx * k
    p.y = cy + dy * k
  }
}

export function resolveCollisions(
  nodes: Array<{ id: number; x: number; y: number; size?: number }>,
  padding: number = 8,
  maxIterations: number = 80,
  scaleFactor: number = 1,
  // padScale: density distribution. null = uniform padding (default, tests).
  // Gets the node index so callers can vary the clearance per node: an exact
  // minimum distance for every pair packs a cluster into bead chains.
  padScale: ((size: number, index: number) => number) | null = null,
  opts: SolverOpts = {},
): void {
  const count = nodes.length
  if (count <= 1) return
  const scale = Math.min(scaleFactor, MAX_SCALE_FACTOR)
  const padFor = (size: number | undefined, index: number): number => {
    const s = size || 20
    return padScale ? padScale(s, index) : padding
  }

  // Radii depend on sizes only, so they are stable across passes and iterations;
  // recomputing them per pair was pure overhead.
  const radii = new Float64Array(count)
  for (let i = 0; i < count; i++) {
    const n = nodes[i]
    radii[i] = (n.size || 20) * scale + padFor(n.size, i) * 0.5
  }
  const sulcus = opts.sulcusPad ?? 0
  const cleftPad = opts.cleftPad ?? 0
  const hasZones = sulcus > 0 && opts.groupOf !== undefined && opts.dominance !== undefined
  // Cleft padding keys on stem presence alone: a fascicle only exists for a word
  // that has a clear owner, and max-phi is not a usable proxy for that (see
  // softInit) — using it here would leave the clefts permanently switched off.
  const hasCleft = cleftPad > 0 && opts.stemOf !== undefined
  // Hot-loop tables: zones and anchors as flat arrays, so the O(N^2) scan does
  // zero Map lookups per pair (measured S9 saver on 1000 nodes).
  const gids = new Int32Array(count).fill(-1)
  const doms = new Float64Array(count)
  const anchorX = new Float64Array(count)
  const anchorY = new Float64Array(count)
  const hasAnchor = new Uint8Array(count)
  // -1 = no fascicle (isolate): never merged and never padded (stem contract).
  const stems = new Int32Array(count).fill(-1)
  for (let i = 0; i < count; i++) {
    const nd = nodes[i]
    if (hasZones) gids[i] = opts.groupOf!.get(nd.id) ?? -1
    // doms drive the sulcus rule only: the cleft keys on stem presence, and a stem
    // already means "has a clear owner" (see softInit).
    if (hasZones) doms[i] = opts.dominance!.get(nd.id) ?? 0
    if (hasCleft) stems[i] = opts.stemOf?.get(nd.id) ?? -1
    if (opts.anchors !== undefined) {
      const a = opts.anchors.get(nd.id)
      if (a !== undefined) {
        anchorX[i] = a.x
        anchorY[i] = a.y
        hasAnchor[i] = 1
      }
    }
  }
  // Production clearances make a uniform-grid broadphase slower than this scan:
  // its neighbourhood radius spans several cells. Keep the O(N^2) scan unless maps
  // get an order of magnitude bigger.
  // ponytail: quadratic in node count, fine up to ~1000 nodes (topN cap).
  for (let iter = 0; iter < maxIterations; iter++) {
    let hasCollision = false
    let maxShift = 0

    for (let i = 0; i < count; i++) {
      const a = nodes[i]
      const ra = radii[i]

      for (let j = i + 1; j < count; j++) {
        const b = nodes[j]
        let minDist = ra + radii[j]
        if (hasCleft) {
          const si = stems[i]
          const sj = stems[j]
          const sa = si % 16
          const sb = sj % 16
          // Same fascicle per §2.1 — the SAME predicate geometry routes by: one owner
          // and either the same slot or one end is the soma (slot 0). Without the
          // slot-0 union the cleft also fired between a hub and its own leaves and
          // pushed every soma out of its own arm.
          if (si >= 0 && sj >= 0 && (si >> 4) === (sj >> 4) && (sa === sb || sa === 0 || sb === 0)) {
            // Pack to 88%, but never closer than the larger radius: at extreme size
            // ratios 0.88*(ra+rb) would let the big body swallow the small one.
            minDist = Math.max((ra + radii[j]) * SAME_STEM_PACK, Math.max(ra, radii[j]))
          }
          // Different fascicles: the pad IS the canyon between two nerves.
          // Two real stems only, so isolates (-1) stay unmerged and unpadded.
          else if (si >= 0 && sj >= 0) minDist += cleftPad
        }
        // Sulcus: cross-zone pairs of clean representatives keep extra air;
        // bridge nodes (dom 0.45..0.60) get none and stay stitched.
        if (hasZones) {
          const ga = gids[i]
          if (ga >= 0 && ga !== gids[j] && doms[i] > 0.68 && doms[j] > 0.68) minDist += sulcus
        }

        let dx = b.x - a.x
        let dy = b.y - a.y
        const distSq = dx * dx + dy * dy

        // Cheap reject first: the squared test avoids a sqrt on most pairs.
        if (distSq >= minDist * minDist) continue

        hasCollision = true
        let dist = Math.sqrt(distSq)
        // Identical centres: a deterministic nudge keeps the normals finite.
        if (dist < 0.001) {
          dx = ((i * 17 + j * 31) % 10 - 5) || 1
          dy = ((i * 23 + j * 13) % 10 - 5) || 1
          dist = Math.sqrt(dx * dx + dy * dy)
        }

        const overlap = minDist - dist
        if (overlap > maxShift) maxShift = overlap

        const nx = dx / dist
        const ny = dy / dist
        const shift = overlap * 0.5

        a.x -= nx * shift
        a.y -= ny * shift
        b.x += nx * shift
        b.y += ny * shift
      }
    }

    // Anchor: hubs stand still, dust walks. Resists the displacement so the
    // solver separates overlaps but never relayouts (audit B3 / spec P1.2).
    if (opts.anchors !== undefined) {
      for (let i = 0; i < count; i++) {
        if (!hasAnchor[i]) continue
        const p = nodes[i]
        const s = p.size || 20
        const k = s > 20 ? 0.12 : s > 12 ? 0.06 : 0.02
        p.x += (anchorX[i]! - p.x) * k
        p.y += (anchorY[i]! - p.y) * k
      }
    }

    if (!hasCollision || maxShift < 0.2) break
  }
}

// (FRAME_START ring retired in P1: fresh nodes seat by neighbours, not gold.)

// Command: seats words that have no cached coordinates next to their already
// placed neighbours. Cached bodies are never moved — a filter switch must not
// reshape the silhouette — so this path runs no solver and no rescale.
// P1: fresh nodes start at the weight-averaged seat of their placed neighbours
// (not a golden ring, which stamped ring artefacts on every filter switch),
// then relax locally with settled bodies pinned.
function seatNewNodes(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[],
  positions: Map<number, { x: number; y: number }>,
  seed: number,
): void {
  const settled: Array<{ x: number; y: number; size: number }> = []
  let cx = 0
  let cy = 0
  for (const node of nodes) {
    if (!node.prevXY) continue
    positions.set(node.id, node.prevXY)
    settled.push({ ...node.prevXY, size: reservePx(node.size ?? 20) })
    cx += node.prevXY.x
    cy += node.prevXY.y
  }
  if (settled.length > 0) {
    cx /= settled.length
    cy /= settled.length
  }
  // Mean spacing of the cached frame: a new word must land at the same scale as
  // the bodies around it, or it either buries itself or flies off the map.
  const span = measuredSpan(settled)
  const pitch = span > 0 ? span / Math.sqrt(settled.length) : 200

  const neighbours = new Map<number, Array<{ id: number; w: number }>>()
  for (const edge of edges) {
    const w = Math.max(1e-6, edge.weight)
    const a = neighbours.get(edge.a)
    if (a) a.push({ id: edge.b, w })
    else neighbours.set(edge.a, [{ id: edge.b, w }])
    const b = neighbours.get(edge.b)
    if (b) b.push({ id: edge.a, w })
    else neighbours.set(edge.b, [{ id: edge.a, w }])
  }

  const fresh = nodes.filter((n) => !n.prevXY).sort((a, b) => a.id - b.id)
  for (const node of fresh) {
    let ax = cx
    let ay = cy
    let sw = 0
    for (const nb of neighbours.get(node.id) ?? []) {
      const p = positions.get(nb.id)
      if (!p) continue
      ax += p.x * nb.w
      ay += p.y * nb.w
      sw += nb.w
    }
    // Guard: a word with no placed neighbour falls back to the cached centroid.
    if (sw > 0) {
      ax /= sw
      ay /= sw
    }
    // Jitter breaks exact overlap; deterministic on the id (never Math.random).
    const point = {
      x: ax + (hashAt(node.id, 17, seed) - 0.5) * 8,
      y: ay + (hashAt(node.id, 19, seed) - 0.5) * 8,
    }
    // Local stress, settled pinned: the fresh word slides toward its own edges'
    // rest lengths without moving a single cached body (S8 stays exact).
    const own = reservePx(node.size ?? 20)
    for (let iter = 0; iter < 10; iter++) {
      for (const nb of neighbours.get(node.id) ?? []) {
        const q = positions.get(nb.id)
        if (!q) continue
        const rest = own + reservePx(nodes.find((m) => m.id === nb.id)?.size ?? 20)
        const dx = point.x - q.x
        const dy = point.y - q.y
        const d = Math.hypot(dx, dy) || 1
        const f = ((d - rest) / d) * 0.1
        point.x -= dx * f
        point.y -= dy * f
      }
    }
    for (let pass = 0; pass < 2; pass++) {
      for (const other of settled) {
        const dx = point.x - other.x
        const dy = point.y - other.y
        const minDist = own + other.size + pitch * 0.12
        const dist = Math.hypot(dx, dy)
        if (dist >= minDist) continue
        const push = (minDist - dist) / (dist || 1)
        point.x += dx * push
        point.y += dy * push
      }
    }
    positions.set(node.id, point)
    settled.push({ ...point, size: own })
  }
}

export function layout(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[],
  opts: LayoutOpts,
): LayoutResult {
  const positions = new Map<number, { x: number; y: number }>()
  if (nodes.length === 0) return { positions, iterationsDone: 0 }

  const iterations = opts.iterations !== undefined ? opts.iterations : opts.fullRun ? 1200 : 20
  // Zero-iteration probe (tests, tools): report the cache verbatim.
  if (iterations === 0) {
    for (const node of nodes) positions.set(node.id, node.prevXY ?? { x: 0, y: 0 })
    return { positions, iterationsDone: 0 }
  }

  const cachedShare = nodes.filter((n) => n.prevXY).length / nodes.length
  // Audit #10: below 0.65 the frame is mostly new — a full re-spread beats
  // seating strangers into stale barycentres (long webs across the map).
  const reuseFrame = !opts.fullRun && cachedShare >= 0.65
  if (reuseFrame) {
    seatNewNodes(nodes, edges, positions, opts.seed)
    return { positions, iterationsDone: 0 }
  }

  // Frame width: the renderer fits the full extent, so the width IS the scale that
  // every clearance below is expressed in.
  const spanTarget = Math.max(6000, Math.min(10000, Math.sqrt(nodes.length) * 320))
  const pxToWorld = spanTarget / LAYOUT_SCREEN_SPAN
  // The spread works in screen-px units, where a node `size` and a clearance are
  // directly comparable; only the finished figure is converted to world units.
  const figure = spread(nodes, edges, { seed: opts.seed, span: LAYOUT_SCREEN_SPAN })
  opts.onStage?.(92, 'Разведение пересечений...')

  const points = nodes.map((node) => {
    const p = figure.positions.get(node.id) ?? { x: 0, y: 0 }
    return { id: node.id, x: p.x * pxToWorld, y: p.y * pxToWorld, size: reservePx(node.size ?? 20) }
  })
  // Air varies 60..140% per node (deterministic on the index): with one exact
  // minimum distance every pair settles into an even field instead of bead chains.
  const padScale = (size: number, index: number): number =>
    2 * airFor(size) * dustTight(size) * (1.4 + 0.8 * hashAt(index, 7919, 1)) * pxToWorld
  // P1.2: two phases, same 28-pass budget. Phase 1 separates without an anchor:
  // in a dense pile the per-node net force cancels out and an anchor would pin
  // every node to its packed init forever (S4 stuck at d=20, worst -0.87).
  // Phase 2 re-anchors to the expanded layout and refines sulci (hubs stand).
  // One stem packs tight (0.88) and two stems keep an extra cleft, so the canyons
  // carved by the assignment survive both solver phases instead of being filled by
  // the isotropic expansion of phase 1.
  const zoneOpts = {
    groupOf: figure.groupOf,
    dominance: figure.dominance,
    stemOf: figure.stemOf,
    cleftPad: 8 * pxToWorld,
    sulcusPad: 10 * pxToWorld,
  }
  resolveCollisions(points, 0, 8, Math.min(MAX_SCALE_FACTOR, pxToWorld), padScale, zoneOpts)
  // Tail containment between the phases: the renderer normalises the map by its
  // bounding box, so a handful of low-degree leaves on the rim shrink the whole
  // tissue into a small clump with empty margins (measured on a real export: 10% of
  // nodes owned 60% of the width — bbox aspect 1.80 against a q05..q95 mass of 1.52,
  // which is why "elongated" never showed). Radius is compressed monotonically past
  // R0 with an asymptote, never reordered, and phase 1 runs again below so any
  // overlap this creates is cleared before the anchored phase.
  containTail(points)
  resolveCollisions(points, 0, 8, Math.min(MAX_SCALE_FACTOR, pxToWorld), padScale, zoneOpts)
  const anchors = new Map(points.map((p) => [p.id, { x: p.x, y: p.y }] as const))
  resolveCollisions(points, 0, SOLVER_PASSES - 16, Math.min(MAX_SCALE_FACTOR, pxToWorld), padScale, {
    anchors,
    ...zoneOpts,
  })
  // Aspect hold by bounding box: the renderer normalises the map by its box, so the
  // box is what the eye sees. holdAspect must run AFTER containTail, otherwise a
  // single stray leaf satisfies the ratio while the tissue stays a fat oval
  // (measured on a real export: bbox 1.80 against a q05..q95 mass of 1.52).
  // Stretch-only (kx, ky >= 1): growing an axis can only grow clearances, so S4
  // cannot regress. Returns the affine map; ports ride it at conversion time so
  // corridors stay glued to their zones (figure.ports stay in screen px until
  // converted).
  const holdAspect = (target: number): { cx: number; cy: number; kx: number; ky: number } => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of points) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    // Quantile mass span per axis: the bbox is owned by stray leaves, the P10..P90
    // mass is the tissue the eye reads. Same quantile helper as the S1 gate.
    const qspan = (values: number[]): number => {
      const s = [...values].sort((a, b) => a - b)
      const at = (q: number): number => {
        const pos = q * (s.length - 1)
        const lo = Math.floor(pos)
        const hi = Math.min(s.length - 1, lo + 1)
        return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo)
      }
      return at(0.9) - at(0.1)
    }
    const w = qspan(points.map((p) => p.x))
    const h = qspan(points.map((p) => p.y))
    let kx = 1
    let ky = 1
    // Guard: a degenerate frame has no ratio to correct.
    if (w > 1e-9 && h > 1e-9) {
      const ratio = w / h
      if (ratio < target) kx = target / ratio
      else ky = ratio / target
      for (const p of points) {
        p.x = cx + (p.x - cx) * kx
        p.y = cy + (p.y - cy) * ky
      }
    }
    return { cx, cy, kx, ky }
  }
  // FRAME_ASPECT (spread.ts): the flattened plane target; S1 caps the top.
  const aspectMap = holdAspect(FRAME_ASPECT)
  // Principal-axis probe (log only): area-weighted covariance on the held frame.
  // Local on purpose — leaf.ts owns alignPrincipalAxis but imports reservePx from
  // here, so importing it would close a cycle. Rotation stays OFF unless the axis
  // sits stably >15deg off horizontal on synthetic (guards: L1/L2>1.2, dx>=0).
  {
    let sw = 0
    let mx = 0
    let my = 0
    for (const p of points) {
      const w = p.size * p.size
      sw += w
      mx += p.x * w
      my += p.y * w
    }
    if (sw > 1e-9) {
      mx /= sw
      my /= sw
      let sxx = 0
      let syy = 0
      let sxy = 0
      for (const p of points) {
        const w = p.size * p.size
        const dx = p.x - mx
        const dy = p.y - my
        sxx += w * dx * dx
        syy += w * dy * dy
        sxy += w * dx * dy
      }
      const half = 0.5 * (sxx + syy)
      const disc = Math.sqrt(Math.max(0, half * half - (sxx * syy - sxy * sxy)))
      const l1 = half + disc
      const l2 = half - disc
      let dev = (0.5 * Math.atan2(2 * sxy, sxx - syy) * 180) / Math.PI
      if (Math.cos((dev * Math.PI) / 180) < 0) dev += 180
      if (dev > 90) dev -= 180
      dev = Math.abs(dev)
      console.log(
        `layout principal axis: dev=${dev.toFixed(1)}deg l1/l2=${l2 > 1e-9 ? (l1 / l2).toFixed(2) : 'inf'} n=${points.length}`,
      )
    }
  }
  for (const p of points) positions.set(p.id, { x: p.x, y: p.y })

  const ports = new Map<number, LayoutPort>()
  for (const [id, port] of figure.ports) {
    const wx = port.x * pxToWorld
    const wy = port.y * pxToWorld
    ports.set(id, {
      ...port,
      x: aspectMap.cx + (wx - aspectMap.cx) * aspectMap.kx,
      y: aspectMap.cy + (wy - aspectMap.cy) * aspectMap.ky,
    })
  }

  return {
    positions,
    iterationsDone: SOLVER_PASSES,
    ports,
    groupOf: figure.groupOf,
    corridors: figure.corridors,
    dominance: figure.dominance,
    stemOf: figure.stemOf,
  }
}
