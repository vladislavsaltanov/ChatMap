// Spatial spread for the word map — the ONLY place that decides where a word
// lands. Design: specs/2026-11-13-leaf-tissue-plan.md (P1: leaf tissue).
//
// Shape grammar (assignment, not force equilibrium):
//   groups -> landmarks + soft affinity (Dijkstra phi) -> stress -> seats.
// Density comes from edge weights (strong links pull almost touching, weak ones
// stretch); sulci between clean zones are kept by the collision solver, bridges
// stay stitched. No global repulsion anywhere: the solver only separates
// accidental overlaps.
//
// Everything here is pure and deterministic: no Math.random, no graphology, and
// every tie is broken by node id so a re-run is byte-identical.

import {
  computeTau,
  dijkstra,
  landmarkPositions,
  softInit,
  stressLeaf,
} from './leaf'

export type SpreadNode = {
  id: number
  // Rendered body radius in world units. Drives the seat pitch.
  size?: number
  // Cached position from a previous run: biases strand assignment only.
  prevXY?: { x: number; y: number }
}

export type SpreadEdge = { a: number; b: number; weight: number }

export type SpreadOpts = {
  seed: number
  // Width of the final frame, in the SAME units as node `size` (screen px at the
  // reference viewport). The caller scales positions to world units afterwards;
  // keeping one unit system is what makes a seat pitch comparable to a clearance.
  span: number
}

export type SpreadPort = { x: number; y: number; mass: number; members: number }

export type SpreadResult = {
  positions: Map<number, { x: number; y: number }>
  // Landmark port per group: the zone centre every corridor of that topic
  // funnels into. Edge routing uses it, so terminals of one topic visibly merge.
  ports: Map<number, SpreadPort>
  groupOf: Map<number, number>
  // Edge count per ordered group pair — the corridor weight the renderer needs.
  corridors: Map<string, number>
  // Soft-zone sharpness per node (max phi): the solver keeps sulci between
  // clean representatives and leaves bridges stitched. Absent = no sulci.
  dominance?: Map<number, number>
  // Fascicle identity per node (impl-plan §2.1), encoded in GROUP-id space so a
  // stem's trunk hub is the port key. Absent = no trunk bundling.
  stemOf?: Map<number, number>
}

// Final width / height of the figure. Chosen so the silhouette stays a band on a
// widescreen plate (gate S1 allows 1.55..3.2).
export const FIGURE_ASPECT = 1.9
// Hard cap on one group's share of the map. A real chat puts ~85% of the words on
// one mega-hub; without the cap that hub becomes the whole figure.
const MAX_GROUP_SHARE = 0.3
const MIN_GROUP = 3
const GROUP_SWEEPS = 8
// (Trunk/fan helpers deleted in P1: landmarks carry the layout now.)

// Deterministic 2D hash -> [0, 1). Same integer arithmetic as the old layout so
// the maps keep the established "hand-made" jitter character.
export function hashAt(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 2246822519)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

type Adjacency = Map<number, Array<{ id: number; w: number }>>

function buildAdjacency(nodes: SpreadNode[], edges: SpreadEdge[]): Adjacency {
  const adj: Adjacency = new Map()
  for (const node of nodes) adj.set(node.id, [])
  for (const edge of edges) {
    if (edge.a === edge.b) continue
    const a = adj.get(edge.a)
    const b = adj.get(edge.b)
    // Guard: an edge to a node outside the selection is dropped, not created.
    if (!a || !b) continue
    a.push({ id: edge.b, w: Math.max(1e-6, edge.weight) })
    b.push({ id: edge.a, w: Math.max(1e-6, edge.weight) })
  }
  return adj
}

// Weighted label propagation over a fixed node set. Iteration order and ties are
// pinned to node ids, so the labels are a pure function of the input.
function labelPropagate(ids: number[], adj: Adjacency, sweeps: number): Map<number, number> {
  const label = new Map<number, number>()
  for (const id of ids) label.set(id, id)
  const order = [...ids].sort((a, b) => a - b)
  const inside = new Set(ids)
  for (let sweep = 0; sweep < sweeps; sweep++) {
    let changed = 0
    for (const id of order) {
      const tally = new Map<number, number>()
      let pull = 0
      for (const nb of adj.get(id) ?? []) {
        if (!inside.has(nb.id)) continue
        const l = label.get(nb.id)
        if (l === undefined) continue
        tally.set(l, (tally.get(l) ?? 0) + nb.w)
        pull += nb.w
      }
      // Self term: a node with weak links keeps its own label instead of being
      // recoloured by a single strong neighbour on the first sweep.
      const cur = label.get(id)!
      tally.set(cur, (tally.get(cur) ?? 0) + pull * 0.35 + 1)
      let best = cur
      let bestW = -1
      for (const [l, w] of tally) {
        // Guard: exact float ties resolve to the smaller label, never to map order.
        if (w > bestW + 1e-9 || (Math.abs(w - bestW) <= 1e-9 && l < best)) {
          best = l
          bestW = w
        }
      }
      if (best !== cur) {
        label.set(id, best)
        changed++
      }
    }
    if (changed === 0) break
  }
  return label
}

type Group = { id: number; members: number[]; mass: number }

// Multi-source weighted BFS: k seeds (the highest intra-degree words) grow into
// their own nuclei. This is the structural split for a group over the mass cap —
// cutting it by id would put unrelated words in one nucleus.
function partition(members: number[], adj: Adjacency, k: number): number[][] {
  const inside = new Set(members)
  const degree = new Map<number, number>()
  for (const id of members) {
    let sum = 0
    for (const nb of adj.get(id) ?? []) if (inside.has(nb.id)) sum += nb.w
    degree.set(id, sum)
  }
  const seeds = [...members]
    .sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || a - b)
    .slice(0, Math.max(1, k))
  const owner = new Map<number, number>()
  // Cost = 1/weight: a strong link is a short step, so the frontier follows topics
  // rather than geometry. Settled nodes are never relaxed again.
  const cost = new Map<number, number>()
  const frontier: Array<{ id: number; seedId: number; cost: number }> = []
  seeds.forEach((id, i) => {
    owner.set(id, i)
    cost.set(id, 0)
    frontier.push({ id, seedId: i, cost: 0 })
  })
  while (frontier.length > 0) {
    let best = 0
    for (let i = 1; i < frontier.length; i++) if (frontier[i].cost < frontier[best].cost) best = i
    const step = frontier.splice(best, 1)[0]
    for (const nb of adj.get(step.id) ?? []) {
      if (!inside.has(nb.id) || owner.has(nb.id)) continue
      const next = step.cost + 1 / nb.w
      owner.set(nb.id, step.seedId)
      frontier.push({ id: nb.id, seedId: step.seedId, cost: next })
    }
  }
  // Guard: unreachable members (a disconnected satellite) join the first nucleus.
  const parts: number[][] = seeds.map(() => [])
  for (const id of members) parts[owner.get(id) ?? 0].push(id)
  return parts.filter((p) => p.length > 0)
}

// Merge down to the nucleus budget. Label propagation over-fragments a chat (a
// topic is not one connected blob), and a figure with thirty nuclei is a column
// of tiny fans, not a band. The smallest group is absorbed by its most affine
// neighbour until the budget is met, so topics stay whole.
function mergeToTarget(groups: Group[], adj: Adjacency, target: number): Group[] {
  const ofNode = new Map<number, number>()
  const update = (): void => {
    ofNode.clear()
    for (const g of groups) for (const id of g.members) ofNode.set(id, g.id)
  }
  update()
  let current = [...groups]
  while (current.length > target) {
    current.sort((a, b) => a.mass - b.mass || a.id - b.id)
    const victim = current[0]
    const affinity = new Map<number, number>()
    for (const id of victim.members) {
      for (const nb of adj.get(id) ?? []) {
        const other = ofNode.get(nb.id)
        if (other === undefined || other === victim.id) continue
        affinity.set(other, (affinity.get(other) ?? 0) + nb.w)
      }
    }
    let host = current[1]
    let best = -1
    for (const [id, weight] of affinity) {
      // Guard: a group with no link to the victim still needs a host — the heaviest
      // one wins, so the merge never depends on Map order.
      const holder = current.find((g) => g.id === id)
      if (!holder) continue
      const share = weight / Math.sqrt(holder.mass)
      if (share > best + 1e-9 || (Math.abs(share - best) <= 1e-9 && holder.id < host.id)) {
        best = share
        host = holder
      }
    }
    current = current.filter((g) => g !== victim && g !== host)
    current.push({
      id: Math.min(host.id, victim.id),
      members: [...host.members, ...victim.members],
      mass: host.mass + victim.mass,
    })
    update()
  }
  return current
}

// Groups with a hard mass cap. A capped group is re-partitioned along its own
// strongest spokes, so a mega-hub's community becomes several nuclei instead of
// one map-wide blob.
function detectGroups(nodes: SpreadNode[], adj: Adjacency): Group[] {
  const ids = nodes.map((n) => n.id)
  const cap = Math.max(MIN_GROUP * 2, Math.ceil(ids.length * MAX_GROUP_SHARE))
  const label = labelPropagate(ids, adj, GROUP_SWEEPS)
  const buckets = new Map<number, number[]>()
  for (const [id, l] of label) {
    const list = buckets.get(l) ?? []
    list.push(id)
    buckets.set(l, list)
  }
  const out: Group[] = []
  for (const members of buckets.values()) {
    if (members.length <= cap) {
      out.push({ id: members[0], members, mass: members.length })
      continue
    }
    for (const part of partition(members, adj, Math.ceil(members.length / cap))) {
      out.push({ id: part[0], members: part, mass: part.length })
    }
  }
  // Guard: fewer than three nuclei means the figure reads as a blob, so the
  // largest group is partitioned along its spokes until the grammar has a figure.
  let guard = 0
  while (out.length < 3 && guard++ < 4) {
    out.sort((a, b) => b.mass - a.mass || a.id - b.id)
    const victim = out[0]
    if (victim.mass < 6) break
    const parts = partition(victim.members, adj, 2)
    if (parts.length < 2) break
    out.splice(0, 1, ...parts.map((p) => ({ id: p[0], members: p, mass: p.length })))
  }
  return out.sort((a, b) => b.mass - a.mass || a.id - b.id)
}

// Greedy affinity chain: the trunk order is the order in which topics are
// neighbours, not the order of their ids. Heaviest group starts, then each next
// one maximises its total weight to what is already placed.
function orderGroups(groups: Group[], adj: Adjacency): Group[] {
  const ofNode = new Map<number, number>()
  for (const g of groups) for (const id of g.members) ofNode.set(id, g.id)
  const link = new Map<string, number>()
  for (const g of groups) {
    for (const id of g.members) {
      for (const nb of adj.get(id) ?? []) {
        const other = ofNode.get(nb.id)
        if (other === undefined || other === g.id) continue
        const key = g.id < other ? `${g.id}:${other}` : `${other}:${g.id}`
        link.set(key, (link.get(key) ?? 0) + nb.w)
      }
    }
  }
  const affinity = (a: number, b: number): number => link.get(a < b ? `${a}:${b}` : `${b}:${a}`) ?? 0
  const placed: Group[] = [groups[0]]
  const rest = groups.slice(1)
  while (rest.length > 0) {
    let bestIndex = 0
    let bestScore = -1
    for (let i = 0; i < rest.length; i++) {
      let score = 0
      for (const p of placed) score += affinity(rest[i].id, p.id)
      const normalised = score / Math.sqrt(rest[i].mass)
      if (normalised > bestScore + 1e-9) {
        bestScore = normalised
        bestIndex = i
      }
    }
    placed.push(rest.splice(bestIndex, 1)[0])
  }
  return placed
}

// (Strand grammar deleted in P1: stress places every node now.)

// (Sunflower/pitch constants deleted in P1: targetLen owns spacing now.)

export function spread(
  nodes: SpreadNode[],
  edges: SpreadEdge[],
  opts: SpreadOpts,
): SpreadResult {
  const positions = new Map<number, { x: number; y: number }>()
  const ports = new Map<number, SpreadPort>()
  const groupOf = new Map<number, number>()
  const corridors = new Map<string, number>()
  const seed = opts.seed >>> 0
  const span = Math.max(600, opts.span)

  if (nodes.length === 0) return { positions, ports, groupOf, corridors }

  // Guard: a handful of words has no macrostructure. One wide ring keeps the
  // "strong links are closer" invariant intact, which the spread cannot express
  // with a single nucleus.
  if (nodes.length < 8) {
    const cx = 0
    const cy = 0
    const radius = span * 0.32
    nodes.forEach((node, i) => {
      const angle = (i / nodes.length) * Math.PI * 2 + seed * 0.001
      positions.set(node.id, {
        x: cx + Math.cos(angle) * radius * FIGURE_ASPECT,
        y: cy + Math.sin(angle) * radius,
      })
      groupOf.set(node.id, nodes[0].id)
    })
    ports.set(nodes[0].id, { x: cx, y: cy, mass: nodes.length, members: nodes.length })
    return { positions, ports, groupOf, corridors }
  }

  const adj = buildAdjacency(nodes, edges)
  // Words with no links at all are dust: they cannot vote for a topic, so they are
  // handed to the smallest group after the layout exists.
  const isolated = nodes.filter((n) => (adj.get(n.id) ?? []).length === 0).map((n) => n.id)
  const linked = nodes.filter((n) => (adj.get(n.id) ?? []).length > 0)
  const groups = orderGroups(
    mergeToTarget(
      detectGroups(linked, adj),
      adj,
      // Nucleus count: sqrt(n)/3.2 → 5 (271) / 7 (541) / 9 (1000). Splitting further
      // (measured at sqrt(n)/2.4) spread the same words over more knots and thinned
      // every one of them: clumpRatio on the stand fell 16 → 2.5. Variety comes from
      // the two-row fold below, not from more top-level nuclei.
      Math.max(3, Math.min(9, Math.round(Math.sqrt(linked.length) / 3.2))),
    ),
    adj,
  )
  const groupById = new Map(groups.map((g) => [g.id, g] as const))

  // Leaf-tissue placement (P1, spec 2026-11-13-leaf-tissue-plan.md): landmarks +
  // soft affinity + stress. Groups survive only as routing identities
  // (ports/groupOf/corridors); the trunk, sunflower cores and fibre fans are
  // deleted below together with their helpers.
  // Hub = the heaviest-linked word of a group: the Dijkstra source of its zone,
  // so the topic's centre of mass is literally its densest word.
  const hubOf = new Map<number, number>()
  for (const g of groups) {
    const inG = new Set(g.members)
    let hub = g.members[0]
    let bestDeg = -1
    for (const id of g.members) {
      let deg = 0
      for (const nb of adj.get(id) ?? []) if (inG.has(nb.id)) deg += nb.w
      // Guard: equal weight resolves to the smaller id, never to array order.
      if (deg > bestDeg + 1e-9 || (Math.abs(deg - bestDeg) <= 1e-9 && id < hub)) {
        bestDeg = deg
        hub = id
      }
    }
    hubOf.set(g.id, hub)
  }

  // Zone affinity: backbone weight crossing two groups, normalised by the max
  // pair. Linked zones sit closer, unlinked ones only repel at close range.
  const memberGroup = new Map<number, number>()
  for (const g of groups) for (const id of g.members) memberGroup.set(id, g.id)
  const cross = new Map<string, number>()
  for (const g of groups) {
    for (const id of g.members) {
      for (const nb of adj.get(id) ?? []) {
        const other = memberGroup.get(nb.id)
        if (other === undefined || other === g.id) continue
        const key = g.id < other ? `${g.id}:${other}` : `${other}:${g.id}`
        cross.set(key, (cross.get(key) ?? 0) + nb.w)
      }
    }
  }
  const maxCross = Math.max(1e-9, ...cross.values(), 0)
  const affinity = new Map<string, number>()
  for (const [k, v] of cross) affinity.set(k, v / maxCross)
  const landmarks = groups.map((g) => hubOf.get(g.id)!)
  const landmarkPos = landmarkPositions(
    groups.map((g) => g.id),
    affinity,
    span,
    seed,
  )
  // Dijkstra sources are hub node ids; trees stay parallel to the groups array.
  const raw = landmarks.map((h) => dijkstra(adj, h))
  const tau = computeTau(raw)
  const trees = landmarks.map((h) => dijkstra(adj, h, tau * 0.55))
  const smallestGroup = [...groups].sort((a, b) => a.mass - b.mass || a.id - b.id)[0]!
  const init = softInit(
    nodes,
    landmarks,
    new Map(groups.map((g, i) => [landmarks[i]!, landmarkPos.get(g.id)!] as const)),
    trees,
    tau,
    seed,
    hubOf.get(smallestGroup.id),
  )
  const order = groups.map((g) => g.id)
  // Stem ids leave leaf.ts in landmark-index space (softInit never sees group ids)
  // and must reach the renderer in group-id space, because a fascicle's trunk hub
  // is the port key. Remapping once keeps the equivalence classes (same stem, slot
  // 0 = soma) intact, so the solver and geometry agree.
  const stemOf = new Map<number, number>()
  for (const [id, stem] of init.stemOf) {
    if (stem < 0) {
      stemOf.set(id, stem)
      continue
    }
    const group = order[Math.floor(stem / 16)]
    // Guard: an unknown owner index must not fall back to group 0, which would
    // merge two unrelated fascicles; it simply joins no fascicle.
    if (group === undefined) {
      stemOf.set(id, -1)
      continue
    }
    stemOf.set(id, group * 16 + (stem % 16))
  }
  const ownerOf = (nodeId: number): number => {
    const row = init.phi.get(nodeId) ?? []
    let best = 0
    for (let k = 1; k < row.length; k++) if (row[k]! > (row[best] ?? -1)) best = k
    return order[best]!
  }
  const dominance = new Map<number, number>()
  for (const n of nodes) {
    groupOf.set(n.id, ownerOf(n.id))
    dominance.set(n.id, init.dominance.get(n.id) ?? 0)
  }
  for (const g of groups) {
    const p = landmarkPos.get(g.id)!
    ports.set(g.id, { x: p.x, y: p.y, mass: g.mass, members: g.members.length })
  }
  const stressed = stressLeaf(nodes, edges, init.positions, init.phi, { iters: 80, seed, stemOf })
  for (const [id, p] of stressed) positions.set(id, p)

  // Isolated words were parked above by softInit (smallest-hub pocket); their
  // routing tag follows the smallest group by mass, the rest by argmax phi.
  for (const id of isolated) groupOf.set(id, smallestGroup.id)

  // All seats placed by the leaf chain above; corridors next.

  // Corridor weights for edge routing: every pair of topics gets one number, and
  // all their edges share the corridor that carries it.
  for (const edge of edges) {
    const ga = groupOf.get(edge.a)
    const gb = groupOf.get(edge.b)
    if (ga === undefined || gb === undefined || ga === gb) continue
    const key = ga < gb ? `${ga}:${gb}` : `${gb}:${ga}`
    corridors.set(key, (corridors.get(key) ?? 0) + 1)
  }

  // Frame: one uniform normalisation. Word sizes are a separate attribute, so the
  // transform can never squash a body — and the solver runs after it, in the same
  // units, so it has nothing to undo.
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
  // Frame: centre + enforce an elongated plane. Stretch-only, never shrink:
  // expanding one axis only grows clearances, so the collision solver's work
  // is never undone (S4 stays green). Shrinking would re-create overlaps.
  // Target 1.8 data ~= 1.5 ink: ink tracks data at ~0.85x on real corpora
  // (giant top/bottom hubs + labels inflate vertical). Matches layout hold.
  const SPREAD_ASPECT = 1.8
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  let kx = 1
  let ky = 1
  const fw = maxX - minX
  const fh = maxY - minY
  if (fw > 1e-9 && fh > 1e-9) {
    const ratio = fw / fh
    if (ratio < SPREAD_ASPECT) kx = SPREAD_ASPECT / ratio
    else ky = ratio / SPREAD_ASPECT
  }
  const place = (p: { x: number; y: number }) => ({ x: cx + (p.x - cx) * kx, y: cy + (p.y - cy) * ky })
  for (const [id, p] of positions) positions.set(id, place(p))
  for (const [id, p] of ports) {
    const q = place(p)
    ports.set(id, { ...p, x: q.x, y: q.y })
  }

  // Guard: groups without members would leave a port in the routing tree.
  for (const [id] of ports) if (!groupById.has(id)) ports.delete(id)

  return { positions, ports, groupOf, corridors, dominance, stemOf }
}
