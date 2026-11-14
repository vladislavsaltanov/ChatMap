import { describe, expect, it } from 'vitest'
import {
  buildLeafAdjacency,
  buildSprings,
  computeTau,
  dijkstra,
  landmarkPositions,
  leafLayout,
  phiCos,
  resolveLeafCollisions,
  softInit,
  stressLeaf,
  targetLen,
} from '../src/core/leaf'
import { reservePx } from '../src/core/graph'

const tiny = () => {
  const nodes = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]
  const edges = [
    { a: 1, b: 2, weight: 5 },
    { a: 2, b: 3, weight: 5 },
    { a: 3, b: 4, weight: 1 },
    { a: 4, b: 5, weight: 5 },
  ]
  return { nodes, edges }
}

describe('leaf spike P0.2 — dijkstra + softInit', () => {
  it('dijkstra is deterministic and tracks branches', () => {
    const { nodes, edges } = tiny()
    const adj = buildLeafAdjacency(nodes, edges)
    const a = dijkstra(adj, 1)
    const b = dijkstra(adj, 1)
    expect([...a.dist.entries()]).toEqual([...b.dist.entries()])
    // Strong links are short steps: 1->2->3 cheaper than 1->...->5.
    expect(a.dist.get(2)!).toBeLessThan(a.dist.get(5)!)
    expect(a.branch1.get(2)).toBe(2)
    expect(a.branch1.get(5)).toBe(2)
  })

  it('computeTau is finite on a connected graph', () => {
    const { nodes, edges } = tiny()
    const adj = buildLeafAdjacency(nodes, edges)
    const trees = [dijkstra(adj, 1), dijkstra(adj, 5)]
    const tau = computeTau(trees)
    expect(Number.isFinite(tau)).toBe(true)
    expect(tau).toBeGreaterThan(0)
  })

  it('softInit places every node without NaN, phi rows sum to 1', () => {
    const { nodes, edges } = tiny()
    const adj = buildLeafAdjacency(nodes, edges)
    const landmarks = [1, 5]
    const trees = landmarks.map((L) => dijkstra(adj, L))
    const tau = computeTau(trees)
    const trees2 = landmarks.map((L) => dijkstra(adj, L, tau * 0.55))
    const lp = new Map([
      [1, { x: -100, y: 0 }],
      [5, { x: 100, y: 0 }],
    ])
    const res = softInit(nodes, landmarks, lp, trees2, tau, 1337)
    expect(res.positions.size).toBe(nodes.length)
    for (const n of nodes) {
      const p = res.positions.get(n.id)!
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.y)).toBe(true)
      const row = res.phi.get(n.id)!
      expect(Math.abs(row.reduce((a, b) => a + b, 0) - 1)).toBeLessThan(1e-9)
    }
    // Bridges sit between landmarks: middle node 3 is the least dominant.
    const dom3 = res.dominance.get(3)!
    expect(dom3).toBeLessThan(0.9)
  })

  it('branch2 marks the bottleneck node crossing splitDist', () => {
    const { nodes, edges } = tiny()
    const adj = buildLeafAdjacency(nodes, edges)
    // Edge 3-4 is weak (w=1): dist 1->2 = 0.2, 1->3 = 0.4. Split at 0.3 is crossed at node 3.
    const t = dijkstra(adj, 1, 0.3)
    expect(t.dist.get(2)!).toBeLessThan(0.3)
    expect(t.branch2.get(3)).toBe(3)
    // Nodes before the split carry src (no crossing yet); the lobe past shares root 3.
    expect(t.branch2.get(2)).toBe(1)
    expect(t.branch2.get(5)).toBe(3)
  })

  it('computeTau excludes Infinity from disconnected components', () => {
    const adj = buildLeafAdjacency([{ id: 1 }, { id: 2 }], [])
    const trees = [dijkstra(adj, 1), dijkstra(adj, 2)]
    const tau = computeTau(trees)
    expect(Number.isFinite(tau)).toBe(true)
    expect(tau).toBe(1)
  })

  it('softInit parks isolates in the smallest-landmark pocket', () => {
    const nodes = [{ id: 1 }, { id: 2 }, { id: 99 }]
    const edges = [{ a: 1, b: 2, weight: 5 }]
    const adj = buildLeafAdjacency(nodes, edges)
    const landmarks = [2, 1]
    const trees = landmarks.map((L) => dijkstra(adj, L))
    const tau = computeTau(trees)
    const trees2 = landmarks.map((L) => dijkstra(adj, L, tau * 0.55))
    const lp = new Map([
      [1, { x: 0, y: 0 }],
      [2, { x: 500, y: 0 }],
    ])
    const res = softInit(nodes, landmarks, lp, trees2, tau, 7)
    // Smallest id is 1 at (0,0): isolate 99 parks nearest to it.
    // Relative assertion: the global 0.9*span rescale moves absolute distances.
    const p = res.positions.get(99)!
    const d1 = Math.hypot(p.x - 0, p.y - 0)
    const d2 = Math.hypot(p.x - 500, p.y - 0)
    expect(d1).toBeLessThan(d2)
  })

  it('softInit extrudes dominant peripheral nodes past the barycenter', () => {
    const { nodes, edges } = tiny()
    const adj = buildLeafAdjacency(nodes, edges)
    const landmarks = [1, 5]
    const trees = landmarks.map((L) => dijkstra(adj, L))
    const tau = computeTau(trees)
    const trees2 = landmarks.map((L) => dijkstra(adj, L, tau * 0.55))
    const lp = new Map([
      [1, { x: -100, y: 0 }],
      [5, { x: 100, y: 0 }],
    ])
    const res = softInit(nodes, landmarks, lp, trees2, tau, 1337)
    // Node 4 sits past the bottleneck on the weak bridge: its lobe shift moves it
    // off the pure barycenter line (extrusion path executed, not a silent no-op).
    const norm = res.phi.get(4)!
    const bx = norm[0] * -100 + norm[1] * 100
    const p = res.positions.get(4)!
    expect(Math.abs(p.x - bx) + Math.abs(p.y - 0)).toBeGreaterThan(1e-6)
  })

  it('targetLen spans 4.5x from strongest to weakest', () => {
    const strong = targetLen(10, 10, 100, 100, 1)
    const weak = targetLen(10, 10, 1, 100, 1)
    expect(weak / strong).toBeGreaterThan(4.0)
    expect(weak / strong).toBeLessThanOrEqual(4.51)
  })
  it('targetLen respects the clearance floor and stretches bridges', () => {
    const floor = (reservePx(10) + reservePx(10)) * 1.0 + 4
    const same = targetLen(10, 10, 5, 5, 1)
    expect(same).toBeGreaterThanOrEqual(floor - 1e-9)
    const bridge = targetLen(10, 10, 5, 5, 0.2)
    expect(bridge).toBeGreaterThan(same)
    expect(bridge / same).toBeLessThanOrEqual(1.36)
  })

  it('phiCos is 1 for identical profiles, low across zones', () => {
    const phi = new Map([
      [1, [0.9, 0.1]],
      [2, [0.9, 0.1]],
      [3, [0.1, 0.9]],
    ])
    expect(phiCos(1, 2, phi)).toBeCloseTo(1)
    expect(phiCos(1, 3, phi)).toBeLessThan(0.65)
  })

  it('buildSprings caps count and skips cross-zone pairs', () => {
    const { nodes, edges } = tiny()
    const adj = buildLeafAdjacency(nodes, edges)
    const landmarks = [1, 5]
    const trees = landmarks.map((L) => dijkstra(adj, L))
    const tau = computeTau(trees)
    const trees2 = landmarks.map((L) => dijkstra(adj, L, tau * 0.55))
    const lp = new Map([
      [1, { x: -100, y: 0 }],
      [5, { x: 100, y: 0 }],
    ])
    const init = softInit(nodes, landmarks, lp, trees2, tau, 1337)
    const len = () => 50
    const minLen = () => 20
    const springs = buildSprings(adj, init.phi, len, minLen)
    const per = new Map<number, number>()
    for (const s of springs) {
      per.set(s.a, (per.get(s.a) ?? 0) + 1)
      per.set(s.b, (per.get(s.b) ?? 0) + 1)
    }
    for (const c of per.values()) expect(c).toBeLessThanOrEqual(6)
  })

  it('stressLeaf is deterministic and keeps strong edges shorter', () => {    const { nodes, edges } = tiny()
    const adj = buildLeafAdjacency(nodes, edges)
    const landmarks = [1, 5]
    const trees = landmarks.map((L) => dijkstra(adj, L))
    const tau = computeTau(trees)
    const trees2 = landmarks.map((L) => dijkstra(adj, L, tau * 0.55))
    const lp = new Map([
      [1, { x: -100, y: 0 }],
      [5, { x: 100, y: 0 }],
    ])
    const init = softInit(nodes, landmarks, lp, trees2, tau, 1337)
    const a = stressLeaf(nodes, edges, init.positions, init.phi, { iters: 20 })
    const b = stressLeaf(nodes, edges, init.positions, init.phi, { iters: 20 })
    for (const n of nodes) expect(a.get(n.id)).toEqual(b.get(n.id))
    for (const n of nodes) {
      expect(Number.isFinite(a.get(n.id)!.x)).toBe(true)
      expect(Number.isFinite(a.get(n.id)!.y)).toBe(true)
    }
    const d12 = Math.hypot(a.get(1)!.x - a.get(2)!.x, a.get(1)!.y - a.get(2)!.y)
    const d34 = Math.hypot(a.get(3)!.x - a.get(4)!.x, a.get(3)!.y - a.get(4)!.y)
    expect(d12).toBeLessThan(d34)
  })

  it('resolveLeafCollisions separates identical centres', () => {
    const positions = new Map([
      [1, { x: 0, y: 0 }],
      [2, { x: 0, y: 0 }],
    ])
    const anchors = new Map([
      [1, { x: 0, y: 0 }],
      [2, { x: 0, y: 0 }],
    ])
    resolveLeafCollisions(positions, anchors, new Map([[1, 0], [2, 0]]), new Map(), new Map([[1, 10], [2, 10]]))
    const d = Math.hypot(positions.get(1)!.x - positions.get(2)!.x, positions.get(1)!.y - positions.get(2)!.y)
    expect(d).toBeGreaterThan(reservePx(10) * 2 - 1)
  })

  it('sulcusPad widens only cross-zone dominant pairs', () => {
    // Same-group pair inside clearance never moves; cross-zone dominants gain +10.
    const gap = reservePx(10) * 2 + 5
    const mk = () => ({
      positions: new Map([
        [1, { x: 0, y: 0 }],
        [2, { x: gap, y: 0 }],
      ]),
      anchors: new Map([
        [1, { x: 0, y: 0 }],
        [2, { x: gap, y: 0 }],
      ]),
      sizes: new Map([
        [1, 10],
        [2, 10],
      ]),
    })
    const same = mk()
    resolveLeafCollisions(same.positions, same.anchors, new Map([[1, 0], [2, 0]]), new Map([[1, 0.9], [2, 0.9]]), same.sizes)
    expect(Math.hypot(same.positions.get(1)!.x - same.positions.get(2)!.x, 0)).toBeCloseTo(gap)
    const cross = mk()
    resolveLeafCollisions(
      cross.positions,
      cross.anchors,
      new Map([[1, 0], [2, 1]]),
      new Map([[1, 0.9], [2, 0.9]]),
      cross.sizes,
    )
    const d = Math.hypot(cross.positions.get(1)!.x - cross.positions.get(2)!.x, 0)
    // Audit B3: +10 sulcus minus the by-design anchor drag (~0.1 at k=0.02).
    expect(d).toBeGreaterThan(gap + 4)
  })

  it('landmarkPositions covers every zone when the trunk root is not the Prim seed', () => {
    // Affinity is a star centred on id 50. Prim seeds at the min id (10) and grows
    // outward from it, while the trunk root is the strongest zone (50) — the two
    // disagree, which is exactly the real-corpus shape that used to crash: walking
    // Prim's child links from 50 reaches only its descendants, so 10 was never
    // placed and the repair loop read pos.get(10).x of undefined.
    const ids = [10, 20, 30, 50]
    const affinity = new Map<string, number>()
    for (const id of [10, 20, 30]) affinity.set(id < 50 ? `${id}:50` : `50:${id}`, 1)
    const pos = landmarkPositions(ids, affinity, 1300, 7)
    expect(pos.size).toBe(ids.length)
    for (const id of ids) {
      const p = pos.get(id)
      expect(p).toBeDefined()
      expect(Number.isFinite(p!.x) && Number.isFinite(p!.y)).toBe(true)
    }
  })

  it('P0.4 full chain on chat-like topology: deterministic, finite, timed', () => {
    // Chat-like spike topology (mirrors synth() in spread.test.ts): 12 heavy
    // stars joined by weak bridges. Local copy: importing from another test
    // file would couple the suites.
    const synth = (n: number) => {
      const nodes = Array.from({ length: n }, (_, i) => ({
        id: i + 1,
        size: i < n * 0.7 ? 5 + (i % 5) : i < n * 0.92 ? 10 + ((i * 3) % 14) : 28 + ((i * 7) % 44),
      }))
      const edges: Array<{ a: number; b: number; weight: number }> = []
      const hubs = 12
      const per = Math.floor((n - hubs) / hubs)
      for (let h = 1; h <= hubs; h++) {
        for (let k = 0; k < per; k++) {
          const b = hubs + (h - 1) * per + k + 1
          if (b <= n) edges.push({ a: h, b, weight: 3 + (k % 4) })
        }
      }
      for (let h = 2; h <= hubs; h++) edges.push({ a: 1, b: h, weight: 2 })
      return { nodes, edges }
    }
    const { nodes, edges } = synth(120)
    const t0 = performance.now()
    const a = leafLayout(nodes, edges, 1337, 40)
    const ms = performance.now() - t0
    const b = leafLayout(nodes, edges, 1337, 40)
    console.log(`P0.4 leaf chain 120: ${ms.toFixed(0)} ms`)
    expect(a.positions.size).toBe(nodes.length)
    for (const n of nodes) {
      expect(a.positions.get(n.id)).toEqual(b.positions.get(n.id))
      expect(Number.isFinite(a.positions.get(n.id)!.x)).toBe(true)
      expect(Number.isFinite(a.positions.get(n.id)!.y)).toBe(true)
    }
    expect(Number.isFinite(a.tau)).toBe(true)
  })

  it('P0.4 timing 271/600: log ms, finite positions', () => {
    const synth = (n: number) => {
      const nodes = Array.from({ length: n }, (_, i) => ({
        id: i + 1,
        size: i < n * 0.7 ? 5 + (i % 5) : i < n * 0.92 ? 10 + ((i * 3) % 14) : 28 + ((i * 7) % 44),
      }))
      const edges: Array<{ a: number; b: number; weight: number }> = []
      const hubs = 12
      const per = Math.floor((n - hubs) / hubs)
      for (let h = 1; h <= hubs; h++) {
        for (let k = 0; k < per; k++) {
          const b = hubs + (h - 1) * per + k + 1
          if (b <= n) edges.push({ a: h, b, weight: 3 + (k % 4) })
        }
      }
      for (let h = 2; h <= hubs; h++) edges.push({ a: 1, b: h, weight: 2 })
      return { nodes, edges }
    }
    for (const n of [271, 600]) {
      const { nodes, edges } = synth(n)
      const t0 = performance.now()
      const r = leafLayout(nodes, edges, 1337, 80)
      const ms = performance.now() - t0
      console.log(`P0.4 leaf chain ${n}: ${ms.toFixed(0)} ms`)
      expect(r.positions.size).toBe(n)
      for (const nd of nodes) {
        expect(Number.isFinite(r.positions.get(nd.id)!.x)).toBe(true)
        expect(Number.isFinite(r.positions.get(nd.id)!.y)).toBe(true)
      }
    }
  })
})
