// Leaf-tissue kernels: Dijkstra + branch-coherent soft init + bridge-aware
// targetLen + stress. PRODUCTION library — spread.ts builds its pipeline on
// these kernels. leafLayout() below is a test-only assembly (no production
// caller); tests pin determinism through it.
// All pure and deterministic: ties by id, no Math.random, hashing via spread.hashAt.

import { hashAt } from './spread'
import { reservePx } from './graph'

export type Pt = { x: number; y: number }
export type LeafNode = { id: number; size?: number }
export type LeafEdge = { a: number; b: number; weight: number }
export type Adjacency = Map<number, Array<{ id: number; w: number }>>

export function buildLeafAdjacency(nodes: LeafNode[], edges: LeafEdge[]): Adjacency {
  const adj: Adjacency = new Map()
  for (const n of nodes) adj.set(n.id, [])
  for (const e of edges) {
    if (e.a === e.b) continue
    const a = adj.get(e.a)
    const b = adj.get(e.b)
    // Guard: edge to a node outside the selection is dropped, not created.
    if (!a || !b) continue
    a.push({ id: e.b, w: Math.max(1e-6, e.weight) })
    b.push({ id: e.a, w: Math.max(1e-6, e.weight) })
  }
  return adj
}

export type DijkstraTree = {
  dist: Map<number, number>
  branch1: Map<number, number>
  branch2: Map<number, number>
}

// Single-source Dijkstra over backbone adjacency, cost = 1/w.
// branch1 = first step from src (lobe sector); branch2 = bottleneck node where
// dist first crossed splitDist (root of a semi-detached lobe).
// Binary min-heap ordered by (dist, id): deterministic pop order, O(log n) push.
// Audit #4: the naive sort-per-pop blew the S9 budget on 1000 nodes (601ms).
type HeapItem = [number, number] // [dist, node]
function heapLess(a: HeapItem, b: HeapItem): boolean {
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])
}
function heapPush(h: HeapItem[], item: HeapItem): void {
  h.push(item)
  let i = h.length - 1
  while (i > 0) {
    const p = (i - 1) >> 1
    if (!heapLess(h[i]!, h[p]!)) break
    const t = h[p]!
    h[p] = h[i]!
    h[i] = t
    i = p
  }
}
function heapPop(h: HeapItem[]): HeapItem | undefined {
  const top = h[0]
  const last = h.pop()!
  if (h.length > 0) {
    h[0] = last
    let i = 0
    for (;;) {
      const l = i * 2 + 1
      const r = l + 1
      let m = i
      if (l < h.length && heapLess(h[l]!, h[m]!)) m = l
      if (r < h.length && heapLess(h[r]!, h[m]!)) m = r
      if (m === i) break
      const t = h[m]!
      h[m] = h[i]!
      h[i] = t
      i = m
    }
  }
  return top
}
export function dijkstra(adj: Adjacency, src: number, splitDist = Infinity): DijkstraTree {
  const dist = new Map([[src, 0]])
  const branch1 = new Map([[src, src]])
  const branch2 = new Map([[src, src]])
  const pq: HeapItem[] = [[0, src]]
  let item = heapPop(pq)
  while (item !== undefined) {
    const d = item[0]
    const u = item[1]
    // Guard: tie-break by id lives in heapLess, never in push order.
    if (d > (dist.get(u) ?? Infinity)) {
      item = heapPop(pq)
      continue
    }
    for (const nb of adj.get(u) ?? []) {
      const nd = d + 1 / Math.max(1e-6, nb.w)
      if (nd < (dist.get(nb.id) ?? Infinity)) {
        dist.set(nb.id, nd)
        const b1 = u === src ? nb.id : (branch1.get(u) ?? nb.id)
        branch1.set(nb.id, b1)
        const b2 = d < splitDist && nd >= splitDist ? nb.id : (branch2.get(u) ?? b1)
        branch2.set(nb.id, b2)
        heapPush(pq, [nd, nb.id])
      }
    }
    item = heapPop(pq)
  }
  return { dist, branch1, branch2 }
}

// Global temperature: 55th percentile of finite positive distances, scaled 0.75.
// Isolates (d = Infinity) are excluded before sorting so they cannot push tau to Inf.
export function computeTau(trees: DijkstraTree[]): number {
  const all: number[] = []
  for (const t of trees) for (const v of t.dist.values()) {
    if (Number.isFinite(v) && v > 0) all.push(v)
  }
  if (all.length === 0) return 1
  all.sort((a, b) => a - b)
  return (all[Math.floor(all.length * 0.55)] ?? 1) * 0.75
}

export type SoftInit = {
  positions: Map<number, Pt>
  phi: Map<number, number[]>
  dominance: Map<number, number>
  tau: number
  stemOf: Map<number, number>
}

// Stem identity (shared invariant, impl-plan §2.1): one quantized first-hop
// fascicle of a hub. id = ownerIndex * 16 + slot (slot 0 = soma, 1..5 = stems).
// Missing entry or -1 = no stem; slot 0 vs slot 3 is never the same fascicle.
const ISOLATE_STEM = -1
const STEMS = 5
// Ownership margin a word needs before it joins a fascicle: (d2-d1)/d2 between the
// nearest and the second-nearest zone. Calibrated against the max-phi gate it
// replaced — that one was dead in production (see softInit), this one owns a star's
// leaves and releases an isthmus, without depending on k or tau.
const STEM_MARGIN = 0.4
// Fixed angular slots per stem: neighbours sit 0.72+ rad apart, so fascicles stay
// separated by canyons instead of painting one continuous ±105° fan (the pancake).
const SLOT_OFFSETS = [-1.45, -0.72, 0, 0.72, 1.45]

// Branch-coherent soft init: barycenter of landmarks + radial extrusion for
// dominant nodes (dom > 0.55) + coherent lobe shift past bottleneck b2.
// Bridges (dom < 0.55) stay inside the landmark hull and keep the sheet connected.
export function softInit(
  nodes: LeafNode[],
  landmarks: number[],
  landmarkPos: Map<number, Pt>,
  trees: DijkstraTree[],
  tau: number,
  seed: number,
  // Explicit smallest-landmark key: production passes the hub of the smallest
  // group; the spike default (min id) keeps tiny-fixture behaviour unchanged.
  smallest?: number,
): SoftInit {
  const positions = new Map<number, Pt>()
  const phi = new Map<number, number[]>()
  const dominance = new Map<number, number>()
  const stemOf = new Map<number, number>()
  let cx = 0
  let cy = 0
  for (const p of landmarkPos.values()) {
    cx += p.x
    cy += p.y
  }
  cx /= Math.max(1, landmarks.length)
  cy /= Math.max(1, landmarks.length)
  const span = 1300
  // Pre-pass: phi/dominance/barycenter math is untouched; stash per-node values
  // so stem quantization (which needs per-hub b1 mass) runs before placement.
  type Pre = {
    owner: number
    dom: number
    bx: number
    by: number
    dMin: number
    b1: number
    b2: number
    s: number
    owned: boolean
  }
  const pre = new Map<number, Pre>()
  const sizeById = new Map<number, number>()
  for (const n of nodes) {
    sizeById.set(n.id, n.size ?? 20)
    const raw = trees.map((t) => Math.exp(-((t.dist.get(n.id) ?? 1e6) / tau)))
    const s = raw.reduce((a, b) => a + b, 0) || 1
    const norm = raw.map((v) => v / s)
    phi.set(n.id, norm)
    // Owner by TRUE distance, not by argmax phi: exp(-d/tau) underflows to 0 past
    // d/tau ≈ 745, and then every phi row is identically zero while the argmax still
    // returned zone 0 — such a node got a stem for a zone that was not its nearest and
    // routed its trunk to the wrong soma. Ties keep the smallest index, which is
    // exactly what argmax over equal phi did.
    let owner = 0
    let d1 = Infinity
    let d2 = Infinity
    for (let k = 0; k < trees.length; k++) {
      const d = trees[k]?.dist.get(n.id) ?? Infinity
      if (d < d1) {
        d2 = d1
        d1 = d
        owner = k
      } else if (d < d2) d2 = d
    }
    const dom = norm[owner] ?? 0
    dominance.set(n.id, dom)
    let bx = 0
    let by = 0
    landmarks.forEach((L, k) => {
      const p = landmarkPos.get(L)!
      bx += norm[k] * p.x
      by += norm[k] * p.y
    })
    const dMin = trees[owner]?.dist.get(n.id) ?? Infinity
    // Ownership margin for the stem gate. phi is a softmax at temperature tau: with k
    // zones a typical word lands near 1/k, so `dom > 0.55` only ever matched the hubs
    // themselves (measured: 8 stems for 600 nodes, every hub-to-leaf edge un-bundled).
    // The margin (d2-d1)/d2 is scale-free and does not move with k or tau.
    const owned = Number.isFinite(d1) && (d2 === Infinity || (d2 - d1) / Math.max(d2, 1e-9) > STEM_MARGIN)
    const b1 = trees[owner]?.branch1.get(n.id) ?? n.id
    pre.set(n.id, {
      owner,
      dom,
      bx,
      by,
      dMin,
      b1,
      b2: trees[owner]?.branch2.get(n.id) ?? b1,
      s,
      owned,
    })
  }
  // Stem quantization per owner hub: top-STEMS b1 by mass are major slots;
  // spillover b1 joins a hash-picked slot (no adjacency in softInit, O(1) hash).
  const slotByNode = new Map<number, number>()
  const rankByNode = new Map<number, number>()
  const countByNode = new Map<number, number>()
  const domByOwner = new Map<number, number[]>()
  for (const n of nodes) {
    const st = pre.get(n.id)!
    if (n.id === landmarks[st.owner]) {
      // Soma: the hub landmark sits at the fascicle root, never on a stem.
      stemOf.set(n.id, st.owner * 16)
    } else if (st.owned && Number.isFinite(st.dMin)) {
      const list = domByOwner.get(st.owner) ?? []
      list.push(n.id)
      domByOwner.set(st.owner, list)
    }
  }
  for (const ids of domByOwner.values()) {
    const mass = new Map<number, number>()
    for (const id of ids) {
      const b1 = pre.get(id)!.b1
      mass.set(b1, (mass.get(b1) ?? 0) + (sizeById.get(id) ?? 20))
    }
    const ranked = [...mass.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])
    const slotOf = new Map<number, number>()
    ranked.slice(0, STEMS).forEach(([b1], i) => slotOf.set(b1, i))
    for (const [b1] of ranked.slice(STEMS)) {
      slotOf.set(b1, Math.min(STEMS - 1, Math.floor(hashAt(b1, 29, seed) * STEMS)))
    }
    const perStem = new Map<number, number[]>()
    for (const id of ids) {
      const slot = slotOf.get(pre.get(id)!.b1) ?? 0
      slotByNode.set(id, slot)
      const list = perStem.get(slot) ?? []
      list.push(id)
      perStem.set(slot, list)
    }
    for (const list of perStem.values()) {
      // Radial order: near-hub nodes first, big nodes first — rankRatio spreads
      // a star graph along the stem instead of stacking it on one ring.
      list.sort(
        (a, b) =>
          pre.get(a)!.dMin - pre.get(b)!.dMin ||
          (sizeById.get(b) ?? 0) - (sizeById.get(a) ?? 0) ||
          a - b,
      )
      list.forEach((id, i) => {
        rankByNode.set(id, (i + 1) / list.length)
        countByNode.set(id, list.length)
      })
    }
  }
  for (const n of nodes) {
    const st = pre.get(n.id)!
    let x = st.bx
    let y = st.by
    const slot = slotByNode.get(n.id)
    if (slot !== undefined && Number.isFinite(st.dMin) && st.owned) {
      // Quantized fascicle: fixed angular slot per stem (canyons between them),
      // radial progress by Dijkstra distance + rank (breaks the single ring).
      const hub = landmarks[st.owner]!
      const lp = landmarkPos.get(hub)!
      const base = Math.atan2(lp.y - cy, lp.x - cx)
      const off = SLOT_OFFSETS[slot]! + (hashAt(hub + slot, 31, seed) - 0.5) * 0.2
      const rank = rankByNode.get(n.id) ?? 1
      const count = countByNode.get(n.id) ?? 1
      const reach = span * (0.2 + 0.14 * Math.min(1, count / 24))
      const progress = 0.45 * Math.min(1.3, st.dMin / (tau * 1.35)) + 0.55 * Math.pow(rank, 0.8)
      const r = span * 0.03 + progress * reach
      // S-bend backbone + secondary fork past 35% + terminal fan past 78%.
      const sign = hashAt(hub * 31 + slot, 41, seed) > 0.5 ? 1 : -1
      const curl = sign * (0.22 + 0.14 * hashAt(hub + slot, 37, seed)) * Math.pow(progress, 1.3)
      const twig = (hashAt(st.b2, 43, seed) - 0.5) * 0.4 * Math.pow(Math.max(0, (progress - 0.35) / 0.65), 1.2)
      const tip = (hashAt(n.id, 47, seed) - 0.5) * 0.26 * Math.max(0, (progress - 0.78) / 0.22)
      const theta = base + off + curl + twig + tip
      x += Math.cos(theta) * r
      y += Math.sin(theta) * r
      stemOf.set(n.id, st.owner * 16 + slot + 1)
    } else if (!Number.isFinite(st.dMin) || st.s <= 1e-12) {
      // Guard: isolate with no finite path parks in the smallest-landmark pocket
      // (production: hub of the smallest group; spike default: smallest id).
      // Keeps dust out of the map centre.
      const small = smallest ?? landmarks.slice().sort((a, b) => a - b)[0] ?? landmarks[0]
      const lp = landmarkPos.get(small)!
      const a = hashAt(n.id, 53, seed) * Math.PI * 2
      x = lp.x + Math.cos(a) * 35
      y = lp.y + Math.sin(a) * 35
      // Isolates join no fascicle: marked -1, never merged, never padded.
      stemOf.set(n.id, ISOLATE_STEM)
    }
    x += (hashAt(n.id, 17, seed) - 0.5) * 12
    y += (hashAt(n.id, 19, seed) - 0.5) * 12
    positions.set(n.id, { x, y })
  }
  // Global extent by assignment: barycentric init packs everything centrally
  // and stress relaxes global modes diffusively (a 271-ring needs O(N^2) iters
  // to expand, not 80). Anisotropic fit so the cloud spans 0.9*span by
  // LEAF_ASPECT — an elongated plane, not a trunk line and not a round blob.
  // Shape is set here (assignment); stress only refines it locally, and rho
  // signal comes from Dijkstra anyway.
  // Guard: a degenerate cloud (one node, total overlap) has nothing to scale.
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of positions.values()) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  const w = maxX - minX
  const h = maxY - minY
  if (w > 1e-9 && h > 1e-9) {
    const sx = (span * 0.9) / w
    const sy = (span * 0.9) / LEAF_ASPECT / h
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    for (const p of positions.values()) {
      p.x = cx + (p.x - cx) * sx
      p.y = cy + (p.y - cy) * sy
    }
  }
  return { positions, phi, dominance, tau, stemOf }
}

// Leaf figure aspect (w/h): an elongated plane, not a trunk line (old 1.9)
// and not a round blob (what isotropic init produced: measured 0.79).
// Calibrated overshoot: isotropic stress+collisions round the init down
// (init 1.6 landed 1.36/1.13 on 271/600), so the init aims higher.
const LEAF_ASPECT = 1.9

// Cosine of phi profiles: 1 = same zone, low = bridge across zones.
export function phiCos(a: number, b: number, phi: Map<number, number[]>): number {
  const pa = phi.get(a)
  const pb = phi.get(b)
  if (!pa || !pb) return 1
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < pa.length; i++) {
    dot += pa[i] * pb[i]
    na += pa[i] * pa[i]
    nb += pb[i] * pb[i]
  }
  return dot / (Math.sqrt(na * nb) || 1)
}

// Bridge-aware target length: strong edges almost touch, weak stretch to 4.5x.
// Inter-zone bridges (sim < 0.65) stretch to 1.35x so isthmuses read as tracts.
// Floor sits AT clearance (not 0.85x): strong pairs must not start overlapped,
// otherwise the collision pass equalizes every strong edge and kills rho.
// MODIFIED 2026-11-13: 0.85 -> 1.0 (P0 audit fix, rho -0.25 -> target <-0.5).
export function targetLen(aSize: number, bSize: number, w: number, wmax: number, sim: number): number {
  const min = (reservePx(aSize) + reservePx(bSize)) * 1.0 + 4
  const max = min * 4.5
  const t = Math.pow(1 - w / Math.max(1e-9, wmax), 0.55)
  const stretch = sim < 0.65 ? 1 + (0.65 - sim) * 0.55 : 1
  return (min + (max - min) * t) * stretch
}

// Landmark choice: degree-first seed, then farthest-point spread (max min-dist
// to the picked set, ties by id). Pure degree picks k adjacent hubs on uniform
// graphs (a ring's top-k are neighbours) and the zones never cover the sheet —
// S4 overlapped by 10px. Farthest-point keeps every zone within reach.
// Count follows sqrt(n)/3.2, clamped 3..9. Returns the raw Dijkstra trees too,
// so callers never pay the k runs twice.
export function pickLandmarks(
  adj: Adjacency,
  nodes: LeafNode[],
  k: number,
): { landmarks: number[]; trees: DijkstraTree[] } {
  if (nodes.length === 0 || k <= 0) return { landmarks: [], trees: [] }
  const deg = new Map<number, number>()
  for (const n of nodes) deg.set(n.id, 0)
  for (const [, nbs] of adj) for (const nb of nbs) deg.set(nb.id, (deg.get(nb.id) ?? 0) + nb.w)
  const byDeg = [...nodes].sort((a, b) => (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0) || a.id - b.id)
  const landmarks: number[] = [byDeg[0]!.id]
  const trees: DijkstraTree[] = [dijkstra(adj, landmarks[0]!)]
  const minD = new Map<number, number>()
  for (const n of nodes) minD.set(n.id, trees[0]!.dist.get(n.id) ?? Infinity)
  while (landmarks.length < k) {
    let best = -1
    let bestD = -1
    for (const n of nodes) {
      const d = minD.get(n.id) ?? Infinity
      if (d > bestD + 1e-9 || (Math.abs(d - bestD) <= 1e-9 && n.id < best)) {
        bestD = d
        best = n.id
      }
    }
    if (best < 0) break
    landmarks.push(best)
    const t = dijkstra(adj, best)
    trees.push(t)
    for (const n of nodes) {
      const d = t.dist.get(n.id) ?? Infinity
      if (d < (minD.get(n.id) ?? Infinity)) minD.set(n.id, d)
    }
  }
  return { landmarks, trees }
}

export function selectLandmarks(nodes: LeafNode[], edges: LeafEdge[]): number[] {
  const adj = buildLeafAdjacency(nodes, edges)
  const k = Math.max(3, Math.min(9, Math.round(Math.sqrt(nodes.length) / 3.2)))
  return pickLandmarks(adj, nodes, k).landmarks
}

const pairKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`)

// PCA alignment: rotate the cloud so its principal axis lies on X. The Huber cap
// (600px) stops one detached hub from steering the axis; the guards keep tiny
// or perfectly isotropic clouds untouched instead of injecting a random rotation.
export function alignPrincipalAxis(positions: Map<number, Pt>): void {
  const pts = [...positions.values()]
  if (pts.length < 3) return
  let cx = 0
  let cy = 0
  for (const p of pts) {
    cx += p.x
    cy += p.y
  }
  cx /= pts.length
  cy /= pts.length
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (const p of pts) {
    const dx = p.x - cx
    const dy = p.y - cy
    const r = Math.hypot(dx, dy)
    const w = r > 600 ? 600 / r : 1
    sxx += w * dx * dx
    syy += w * dy * dy
    sxy += w * dx * dy
  }
  if (Math.abs(sxx - syy) < 1e-9 && Math.abs(sxy) < 1e-9) return
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  for (const p of positions.values()) {
    const dx = p.x - cx
    const dy = p.y - cy
    p.x = cx + dx * c + dy * s
    p.y = cy - dx * s + dy * c
  }
}

// Landmark spine: a constructive MST tree laid out once (trunk + fanning side
// branches), then repair-only relaxation. No affinity attraction — the layout
// already encodes it, and any attraction loop re-invents the wheel this removes.
export function landmarkPositions(
  ids: number[],
  affinity: Map<string, number>,
  span: number,
  seed: number,
): Map<number, Pt> {
  const pos = new Map<number, Pt>()
  const k = ids.length
  if (k === 0) return pos
  if (k === 1) {
    pos.set(ids[0]!, { x: 0, y: 0 })
    return pos
  }
  const aff = (a: number, b: number): number =>
    a === b ? 0 : (affinity.get(pairKey(a, b)) ?? 0)
  // Prim by max affinity, deterministic: larger aff wins, ties by id pair.
  // Absent pairs count as 0, so isolated zones hang off the cheapest edge.
  const start = ids.reduce((a, b) => (b < a ? b : a))
  const inTree = new Set<number>([start])
  const parentOf = new Map<number, { p: number; aff: number }>()
  const mstEdges = new Set<string>()
  while (inTree.size < k) {
    // Guard: duplicate ids make `inTree` stop growing while the search below keeps
    // picking an already-placed zone — an infinite loop, not a slow path.
    if (ids.find((v) => !inTree.has(v)) === undefined) break
    let bu = -1
    let bv = -1
    let ba = -1
    for (const u of inTree) {
      for (const v of ids) {
        if (inTree.has(v)) continue
        const a = aff(u, v)
        const lo = Math.min(u, v)
        const hi = Math.max(u, v)
        const blo = Math.min(bu, bv)
        const bhi = Math.max(bu, bv)
        if (a > ba + 1e-12 || (Math.abs(a - ba) <= 1e-12 && (bu < 0 || lo < blo || (lo === blo && hi < bhi)))) {
          ba = a
          bu = u
          bv = v
        }
      }
    }
    inTree.add(bv)
    parentOf.set(bv, { p: bu, aff: ba })
    mstEdges.add(pairKey(bu, bv))
  }
  // Root = strongest zone: max incident affinity, tie by min id.
  let root = start
  let rootInc = -1
  for (const u of ids) {
    let inc = 0
    for (const v of ids) inc += aff(u, v)
    if (inc > rootInc + 1e-12 || (Math.abs(inc - rootInc) <= 1e-12 && u < root)) {
      rootInc = inc
      root = u
    }
  }
  // Re-root the Prim tree at `root`. Prim grows from `start` (the min id) while the
  // trunk is rooted at the strongest zone, and the two are usually DIFFERENT nodes:
  // walking Prim's child links from `root` then reaches only its descendants and
  // silently drops every ancestor branch (crash on the real corpus: pos.get(id) was
  // undefined for the whole start-side branch). One BFS over the undirected tree
  // reorients every edge away from `root`, so placement and subtree sizes cover all.
  const nbrs = new Map<number, number[]>()
  for (const id of ids) nbrs.set(id, [])
  for (const [child, e] of parentOf) {
    nbrs.get(child)!.push(e.p)
    nbrs.get(e.p)!.push(child)
  }
  const children = new Map<number, number[]>()
  for (const id of ids) children.set(id, [])
  const rooted = new Set<number>([root])
  const queue = [root]
  while (queue.length > 0) {
    const u = queue.shift()!
    for (const v of nbrs.get(u) ?? []) {
      if (rooted.has(v)) continue
      rooted.add(v)
      children.get(u)!.push(v)
      // The Prim parent of `v` may be its child now; `aff(u,v)` IS the MST edge
      // weight Prim chose, so the branch keeps its real strength after the flip.
      parentOf.set(v, { p: u, aff: aff(u, v) })
      queue.push(v)
    }
  }
  // Subtree sizes for branch ordering: bigger subtrees stay on the trunk.
  const subSize = new Map<number, number>()
  const measure = (u: number): number => {
    let n = 1
    for (const v of children.get(u) ?? []) n += measure(v)
    subSize.set(u, n)
    return n
  }
  measure(root)
  for (const kids of children.values()) {
    kids.sort(
      (a, b) =>
        (subSize.get(b) ?? 0) - (subSize.get(a) ?? 0) ||
        (parentOf.get(b)?.aff ?? 0) - (parentOf.get(a)?.aff ?? 0) ||
        a - b,
    )
  }
  // Constructive placement: weak bonds sit far, trunk bends gently (S-curve),
  // side branches fan alternating ± with a per-parent flip; Y is pre-squashed
  // so the zone cloud starts wider than tall.
  pos.set(root, { x: 0, y: 0 })
  const baseOf = new Map<number, number>([[root, 0]])
  const place = (u: number): void => {
    children.get(u)!.forEach((v, j) => {
      const e = parentOf.get(v)!.aff
      const step = span * (0.22 + 0.14 * (1 - e))
      const base = baseOf.get(u)!
      let angle: number
      if (j === 0) {
        angle = base + (hashAt(v, 11, seed) - 0.5) * 0.7
      } else {
        const flip = hashAt(u, 17, seed) > 0.5 ? 1 : -1
        const sign = (j % 2 === 1 ? 1 : -1) * flip
        angle = base + sign * (0.72 + 0.22 * (j - 1)) + (hashAt(v, 13, seed) - 0.5) * 0.24
      }
      const pu = pos.get(u)!
      pos.set(v, { x: pu.x + Math.cos(angle) * step, y: pu.y + Math.sin(angle) * step * 0.72 })
      baseOf.set(v, angle)
      place(v)
    })
  }
  place(root)
  // Repair only, 40 passes: separate overlaps, keep MST edges from overstretch.
  // Forces are clamped so one crowded pair cannot fling a zone across the map.
  const clampF = (f: number): number => Math.max(-0.5 * span, Math.min(0.5 * span, f))
  for (let iter = 0; iter < 40; iter++) {
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        const A = pos.get(ids[i]!)!
        const B = pos.get(ids[j]!)!
        let dx = B.x - A.x
        let dy = B.y - A.y
        let d = Math.hypot(dx, dy)
        if (d < 1e-3) {
          // Identical centres: deterministic id nudge, never random.
          dx = ((ids[i]! * 17 + ids[j]! * 31) % 10) - 5 || 1
          dy = ((ids[i]! * 23 + ids[j]! * 13) % 10) - 5 || 1
          d = Math.hypot(dx, dy)
        }
        const minSep = span * 0.2
        if (d < minSep) {
          const f = clampF((d - minSep) * 0.05)
          A.x += (dx / d) * f
          A.y += (dy / d) * f
          B.x -= (dx / d) * f
          B.y -= (dy / d) * f
          dx = B.x - A.x
          dy = B.y - A.y
          d = Math.hypot(dx, dy) || 1
        }
        if (mstEdges.has(pairKey(ids[i]!, ids[j]!))) {
          const maxSep = span * 0.36
          if (d > maxSep) {
            const f = clampF((d - maxSep) * 0.05)
            A.x += (dx / d) * f
            A.y += (dy / d) * f
            B.x -= (dx / d) * f
            B.y -= (dy / d) * f
          }
        }
      }
    }
  }
  alignPrincipalAxis(pos)
  let mx = 0
  let my = 0
  for (const p of pos.values()) {
    mx += p.x
    my += p.y
  }
  mx /= Math.max(1, k)
  my /= Math.max(1, k)
  for (const p of pos.values()) {
    p.x -= mx
    p.y -= my
  }
  return pos
}

// Zone affinity from the backbone: sum of edge weights crossing two owner
// zones (owner = nearest landmark by Dijkstra distance), normalized by the max.
// Feeds landmarkPositions so linked zones sit closer and the sheet does not tear.
export function leafLayout(
  nodes: LeafNode[],
  edges: LeafEdge[],
  seed: number,
  iters = 80,
): { positions: Map<number, Pt>; phi: Map<number, number[]>; dominance: Map<number, number>; tau: number } {
  const adj = buildLeafAdjacency(nodes, edges)
  const k = Math.max(3, Math.min(9, Math.round(Math.sqrt(nodes.length) / 3.2)))
  const picked = pickLandmarks(adj, nodes, k)
  const landmarks = picked.landmarks
  const raw0 = picked.trees
  // Owner zone per node: nearest landmark by Dijkstra distance (= argmax phi).
  const owner = new Map<number, number>()
  nodes.forEach((n, i) => {
    let best = 0
    let bestD = raw0[0]?.dist.get(n.id) ?? Infinity
    for (let k = 1; k < raw0.length; k++) {
      const d = raw0[k]?.dist.get(n.id) ?? Infinity
      if (d < bestD || (d === bestD && landmarks[k]! < landmarks[best]!)) {
        best = k
        bestD = d
      }
    }
    void i
    owner.set(n.id, best)
  })
  // Affinity: backbone weight crossing zone pairs, normalized by the max pair.
  const cross = new Map<string, number>()
  for (const e of edges) {
    const a = owner.get(e.a) ?? -1
    const b = owner.get(e.b) ?? -1
    if (a === b || a < 0 || b < 0) continue
    const key = pairKey(landmarks[a]!, landmarks[b]!)
    cross.set(key, (cross.get(key) ?? 0) + e.weight)
  }
  const maxCross = Math.max(1e-9, ...cross.values(), 0)
  const affinity = new Map<string, number>()
  for (const [k, v] of cross) affinity.set(k, v / maxCross)
  const lp = landmarkPositions(landmarks, affinity, 1300, seed)
  const raw = raw0
  const tau = computeTau(raw)
  const trees = landmarks.map((L) => dijkstra(adj, L, tau * 0.55))
  const init = softInit(nodes, landmarks, lp, trees, tau, seed)
  const positions = stressLeaf(nodes, edges, init.positions, init.phi, { iters, seed, stemOf: init.stemOf })
  // Audit B3 / spec P1.2: final collision pass forms the sulci. Anchors are the
  // stress output itself: collisions separate overlaps but never relayout.
  const sizeOf = new Map(nodes.map((n) => [n.id, n.size ?? 20] as const))
  const groupOf = new Map<number, number>()
  for (const n of nodes) {
    const row = init.phi.get(n.id) ?? []
    let best = 0
    for (let k = 1; k < row.length; k++) if (row[k]! > (row[best] ?? -1)) best = k
    groupOf.set(n.id, best)
  }
  const anchors = new Map<number, Pt>()
  for (const [id, p] of positions) anchors.set(id, { ...p })
  resolveLeafCollisions(positions, anchors, groupOf, init.dominance, sizeOf)
  return { positions, phi: init.phi, dominance: init.dominance, tau }
}

// Audit B3: sulcus-forming collision pass (spec P1.2). Pairwise separation only
// (no global repulsion); cross-zone pairs of clean representatives keep an extra
// sulcusPad furrow, bridge nodes get none and stay stitched. The differential
// anchor (hubs 0.12, mid 0.06, dust 0.02) resists the displacement so the solver
// separates overlaps but never relayouts. Early exit at maxShift < 0.2.
export function resolveLeafCollisions(
  positions: Map<number, Pt>,
  anchors: Map<number, Pt>,
  groupOf: Map<number, number>,
  dominance: Map<number, number>,
  sizeOf: Map<number, number>,
  sulcusPad = 10,
  maxPasses = 28,
): void {
  const ids = [...positions.keys()]
  const n = ids.length
  if (n <= 1) return
  const radii = new Map<number, number>()
  for (const id of ids) radii.set(id, reservePx(sizeOf.get(id) ?? 20))
  for (let pass = 0; pass < maxPasses; pass++) {
    let maxShift = 0
    let moved = false
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = positions.get(ids[i]!)!
        const b = positions.get(ids[j]!)!
        const ra = radii.get(ids[i]!)!
        const rb = radii.get(ids[j]!)!
        let minDist = ra + rb
        const ga = groupOf.get(ids[i]!)
        const gb = groupOf.get(ids[j]!)
        if (ga !== undefined && gb !== undefined && ga !== gb) {
          const da = dominance.get(ids[i]!) ?? 0
          const db = dominance.get(ids[j]!) ?? 0
          if (da > 0.68 && db > 0.68) minDist += sulcusPad
        }
        const dx = b.x - a.x
        const dy = b.y - a.y
        const d2 = dx * dx + dy * dy
        if (d2 >= minDist * minDist) continue
        moved = true
        let d = Math.sqrt(d2)
        let nx = dx
        let ny = dy
        if (d < 1e-3) {
          // Guard: identical centres get a deterministic nudge (id hash, never random).
          nx = ((ids[i]! * 17 + ids[j]! * 31) % 10) - 5 || 1
          ny = ((ids[i]! * 23 + ids[j]! * 13) % 10) - 5 || 1
          d = Math.hypot(nx, ny)
        }
        const overlap = minDist - d
        if (overlap > maxShift) maxShift = overlap
        const shift = overlap * 0.5
        nx /= d
        ny /= d
        a.x -= nx * shift
        a.y -= ny * shift
        b.x += nx * shift
        b.y += ny * shift
      }
    }
    for (const [id, p] of positions) {
      const a = anchors.get(id)
      if (!a) continue
      const s = sizeOf.get(id) ?? 20
      const k = s > 20 ? 0.12 : s > 12 ? 0.06 : 0.02
      p.x += (a.x - p.x) * k
      p.y += (a.y - p.y) * k
    }
    if (!moved || maxShift < 0.2) break
  }
}

export type Spring = { a: number; b: number; rest: number; k: number }
// 2-hop membrane: at most 3 springs per node, only across similar zones
// (sim > 0.70) so inter-zone isthmuses and lobe roots are never stitched shut.
// Hubs are capped to their top-6 neighbours by weight: O(N), not O(degree^2).
// Length is capped at 3.2x the direct minimum so a long detour cannot drag zones together.
export function buildSprings(
  adj: Adjacency,
  phi: Map<number, number[]>,
  len: (a: number, b: number) => number,
  minLen: (a: number, b: number) => number,
): Spring[] {
  const out: Spring[] = []
  for (const [u, nbs] of adj) {
    const top = [...nbs].sort((a, b) => b.w - a.w || a.id - b.id).slice(0, 6)
    const cands: Array<{ w: number; rest: number; sim: number }> = []
    for (let i = 0; i < top.length; i++) {
      for (let j = i + 1; j < top.length; j++) {
        const x = top[i].id
        const y = top[j].id
        if (x === u || y === u) continue
        const sim = phiCos(x, y, phi)
        if (!(sim > 0.7)) continue
        const rest = Math.min(len(x, u) + len(u, y), minLen(x, y) * 3.2)
        cands.push({ w: x === u ? y : x, rest, sim })
      }
    }
    // Guard: pairs are enumerated per intermediate hub; keep the entry where u is an endpoint.
    const mine = cands.filter((c) => c.w !== u)
    mine.sort((a, b) => b.sim - a.sim)
    for (const c of mine.slice(0, 3)) out.push({ a: u, b: c.w, rest: c.rest, k: 0.12 })
  }
  return out
}

// Heart loop (P0.3): backbone attraction + weak 2-hop membrane + decaying anchor.
// No global repulsion — only edge springs and the anchor; collisions run once after.
// All stress stays in screen-px; recentering every 20 iters never rescales.
export function stressLeaf(
  nodes: LeafNode[],
  edges: LeafEdge[],
  init: Map<number, Pt>,
  phi: Map<number, number[]>,
  opts: { iters?: number; seed?: number; stemOf?: Map<number, number> } = {},
): Map<number, Pt> {
  const iters = opts.iters ?? 80
  const stemOf = opts.stemOf
  // Same fascicle per the shared invariant: equal non-negative ids (slot 0 vs
  // slot 3 is never the same). Absent stemOf keeps today's behaviour exactly.
  const sameStem = (a: number, b: number): boolean => {
    if (stemOf === undefined) return true
    const sa = stemOf.get(a) ?? -1
    const sb = stemOf.get(b) ?? -1
    return sa >= 0 && sa === sb
  }
  const pos = new Map<number, Pt>()
  for (const [id, p] of init) pos.set(id, { ...p })
  const anchors = new Map<number, Pt>()
  for (const [id, p] of init) anchors.set(id, { ...p })
  const sizeOf = new Map(nodes.map((n) => [n.id, n.size ?? 20] as const))
  const wOf = new Map<string, number>()
  let wmax = 0
  for (const e of edges) {
    const key = e.a < e.b ? `${e.a}:${e.b}` : `${e.b}:${e.a}`
    wOf.set(key, Math.max(wOf.get(key) ?? 0, e.weight))
    if (e.weight > wmax) wmax = e.weight
  }
  if (!(wmax > 0)) wmax = 1
  const wBetween = (a: number, b: number): number =>
    wOf.get(a < b ? `${a}:${b}` : `${b}:${a}`) ?? 0
  const len = (a: number, b: number): number =>
    targetLen(sizeOf.get(a) ?? 20, sizeOf.get(b) ?? 20, Math.max(wBetween(a, b), 1e-9), wmax, phiCos(a, b, phi))
  const minLen = (a: number, b: number): number =>
    (reservePx(sizeOf.get(a) ?? 20) + reservePx(sizeOf.get(b) ?? 20)) * 1.0 + 4
  const adj = buildLeafAdjacency(nodes, edges)
  // A 2-hop stitch across two fascicles would bridge the canyon: drop it.
  // Absent stemOf keeps every spring, i.e. today's behaviour exactly.
  const springs = buildSprings(adj, phi, len, minLen).filter((s) => {
    if (stemOf === undefined) return true
    const sa = stemOf.get(s.a) ?? -1
    const sb = stemOf.get(s.b) ?? -1
    return !(sa >= 0 && sb >= 0 && sa !== sb)
  })
  for (let iter = 0; iter < iters; iter++) {
    // A2 REVERTED 2026-11-13: 0.01 worsened rho (-0.33->-0.16) and pres.
    // The init already encodes weight->distance (Dijkstra); the anchor keeps it.
    const anchorK = 0.03 * Math.pow(0.97, iter)
    for (const e of edges) {
      const A = pos.get(e.a)
      const B = pos.get(e.b)
      if (!A || !B) continue
      const dx = B.x - A.x
      const dy = B.y - A.y
      const d = Math.hypot(dx, dy) || 1
      // Hub edges (either endpoint big) are never two fascicles: full pull.
      // Cross-stem weak edges pull softer and rest longer so canyons survive;
      // compression is kept — dropping it re-creates overlaps the solver pays for.
      const hubEdge = (sizeOf.get(e.a) ?? 20) > 22 || (sizeOf.get(e.b) ?? 20) > 22
      const same = sameStem(e.a, e.b) || hubEdge
      const L = same ? len(e.a, e.b) : len(e.a, e.b) * 1.2
      const k = 0.04 * (0.35 + 0.65 * Math.sqrt(e.weight / wmax)) * (same ? 1 : 0.35)
      const f = ((d - L) / d) * k
      A.x += dx * f
      A.y += dy * f
      B.x -= dx * f
      B.y -= dy * f
    }
    for (const s of springs) {
      const A = pos.get(s.a)
      const B = pos.get(s.b)
      if (!A || !B) continue
      const dx = B.x - A.x
      const dy = B.y - A.y
      const d = Math.hypot(dx, dy) || 1
      const f = ((d - s.rest) / d) * 0.04 * s.k
      A.x += dx * f
      A.y += dy * f
      B.x -= dx * f
      B.y -= dy * f
    }
    for (const [id, p] of pos) {
      const a = anchors.get(id)
      if (!a) continue
      p.x += (a.x - p.x) * anchorK
      p.y += (a.y - p.y) * anchorK
    }
    if (iter % 20 === 19) {
      // Recenter only: scale would invalidate every targetLen computed above.
      let cx = 0
      let cy = 0
      for (const p of pos.values()) {
        cx += p.x
        cy += p.y
      }
      cx /= Math.max(1, pos.size)
      cy /= Math.max(1, pos.size)
      for (const p of pos.values()) {
        p.x -= cx
        p.y -= cy
      }
    }
  }
  return pos
}
