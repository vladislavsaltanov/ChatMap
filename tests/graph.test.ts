import { describe, expect, it } from 'vitest'
import { bundleEdges } from '../src/core/geometry'
import {
  collisionIterationsForCount,
  dustTight,
  getLruCache,
  layout,
  resolveCollisions,
  setLruCache,
} from '../src/core/graph'

describe('LRU cache helpers', () => {
  it('evicts the least recently set key once maxEntries is exceeded', () => {
    const m = new Map<string, number>()
    setLruCache(m, 'a', 1, 2)
    setLruCache(m, 'b', 2, 2)
    setLruCache(m, 'c', 3, 2)
    expect(m.has('a')).toBe(false)
    expect(m.get('c')).toBe(3)
  })

  it('keeps keys that were read or re-set recently', () => {
    const m = new Map<string, number>()
    setLruCache(m, 'a', 1, 2)
    setLruCache(m, 'b', 2, 2)
    expect(getLruCache(m, 'a')).toBe(1)
    setLruCache(m, 'c', 3, 2)
    expect(m.has('b')).toBe(false)
    expect(m.has('a')).toBe(true)
  })

  it('getLruCache returns undefined for a missing key without inserting', () => {
    const m = new Map<string, number>()
    expect(getLruCache(m, 'x')).toBeUndefined()
    expect(m.size).toBe(0)
  })

  it('caps at 2000 entries by default', () => {
    const m = new Map<number, number>()
    for (let i = 0; i < 2100; i++) setLruCache(m, i, i)
    expect(m.size).toBe(2000)
    expect(m.has(0)).toBe(false)
  })

  it('treats a non-positive maxEntries as an empty cache', () => {
    const m = new Map<string, number>()
    setLruCache(m, 'a', 1, 0)
    expect(m.size).toBe(0)
  })
})

describe('collision clearance law', () => {
  it('packs dust tighter than hubs', () => {
    // Smaller multiplier = tighter air, which is what makes nuclei read as knots.
    expect(dustTight(6)).toBeLessThan(dustTight(30))
  })

  it('uses a smaller pass budget above 400 nodes', () => {
    expect(collisionIterationsForCount(400)).toBeGreaterThan(collisionIterationsForCount(401))
  })

  it('separates overlapping bodies so distance >= r1 + r2', () => {
    const nodes = [
      { id: 1, x: 0, y: 0, size: 10 },
      { id: 2, x: 1, y: 0, size: 10 },
      { id: 3, x: 0.5, y: 1, size: 10 },
    ]
    resolveCollisions(nodes, 2, 40, 1)
    // The solver exits when the largest remaining overlap is below 0.2 world units,
    // so the assertion carries that documented tolerance.
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y)
        expect(d).toBeGreaterThanOrEqual(20 + 2 - 0.2)
      }
    }
  })

  it('clamps the scale factor at 10 so a huge px->world ratio cannot explode clearances', () => {
    const a = [{ id: 1, x: 0, y: 0, size: 10 }, { id: 2, x: 1, y: 0, size: 10 }]
    const b = [{ id: 1, x: 0, y: 0, size: 10 }, { id: 2, x: 1, y: 0, size: 10 }]
    resolveCollisions(a, 0, 30, 10)
    resolveCollisions(b, 0, 30, 400)
    expect(a[1].x).toBeCloseTo(b[1].x)
  })

  it('anchor holds hubs still while dust walks (audit B3)', () => {
    const hub = { id: 1, x: 0, y: 0, size: 30 }
    const dust = { id: 2, x: 5, y: 0, size: 6 }
    const nodes = [hub, dust]
    const anchors = new Map([
      [1, { x: 0, y: 0 }],
      [2, { x: 5, y: 0 }],
    ])
    resolveCollisions(nodes, 0, 30, 1, null, { anchors })
    const hubDisp = Math.hypot(hub.x - 0, hub.y - 0)
    const dustDisp = Math.hypot(dust.x - 5, dust.y - 0)
    expect(hubDisp).toBeLessThan(dustDisp)
  })

  it('sulcusPad widens only cross-zone dominant pairs', () => {
    const mk = () => [
      { id: 1, x: 0, y: 0, size: 10 },
      { id: 2, x: 25, y: 0, size: 10 },
    ]
    // Same zone: clearance is exactly ra+rb = 20, gap 25 never moves.
    const same = mk()
    resolveCollisions(same, 0, 30, 1, null, {
      groupOf: new Map([[1, 0], [2, 0]]),
      dominance: new Map([[1, 0.9], [2, 0.9]]),
      sulcusPad: 10,
    })
    expect(Math.hypot(same[1]!.x - same[0]!.x, 0)).toBeCloseTo(25)
    // Cross-zone dominants: minDist 20 + 10 sulcus, one pass lands exactly.
    const cross = mk()
    resolveCollisions(cross, 0, 30, 1, null, {
      groupOf: new Map([[1, 0], [2, 1]]),
      dominance: new Map([[1, 0.9], [2, 0.9]]),
      sulcusPad: 10,
    })
    expect(Math.hypot(cross[1]!.x - cross[0]!.x, 0)).toBeCloseTo(30)
    // Bridge nodes (dom 0.5) get no sulcus even across zones.
    const bridge = mk()
    resolveCollisions(bridge, 0, 30, 1, null, {
      groupOf: new Map([[1, 0], [2, 1]]),
      dominance: new Map([[1, 0.9], [2, 0.5]]),
      sulcusPad: 10,
    })
    expect(Math.hypot(bridge[1]!.x - bridge[0]!.x, 0)).toBeCloseTo(25)
  })

  // Stem contract §2.1: cleft padding needs a stem table plus a pad. Dominance is
  // no longer part of that gate — a stem already means "has a clear owner", and
  // max-phi was unusable as a proxy (see softInit) — it still drives the sulcus.
  const stemOpts = (stems: Array<[number, number]>, doms: Array<[number, number]>, cleftPad = 8) => ({
    stemOf: new Map(stems),
    dominance: new Map(doms),
    cleftPad,
  })
  const pair = (gap: number) => [{ id: 1, x: 0, y: 0, size: 10 }, { id: 2, x: gap, y: 0, size: 10 }]
  const spreadOf = (nodes: Array<{ x: number; y: number }>) => Math.hypot(nodes[1]!.x - nodes[0]!.x, nodes[1]!.y - nodes[0]!.y)

  it('packs one fascicle to 88% of its reserved radii', () => {
    const same = pair(10)
    resolveCollisions(same, 0, 30, 1, null, stemOpts([[1, 161], [2, 161]], [[1, 0.9], [2, 0.9]]))
    // Reserved radii sum to 20; one fascicle interlocks to 17.6 so the strand reads
    // as one nerve instead of two beads.
    expect(spreadOf(same)).toBeCloseTo(17.6, 6)
  })

  it('keeps a cleft between two clean fascicles', () => {
    const cross = pair(25)
    resolveCollisions(cross, 0, 30, 1, null, stemOpts([[1, 161], [2, 162]], [[1, 0.9], [2, 0.9]]))
    expect(spreadOf(cross)).toBeCloseTo(28, 6)
    // A bridge carries no fascicle (-1): a stem implies a clear owner, so stitched
    // tissue is encoded as "no stem" and keeps the plain body clearance.
    const bridge = pair(25)
    resolveCollisions(bridge, 0, 30, 1, null, stemOpts([[1, -1], [2, 162]], [[1, 0.9], [2, 0.5]]))
    expect(spreadOf(bridge)).toBeCloseTo(25, 6)
    // An isolate has no fascicle: never merged, never padded.
    const isolate = pair(25)
    resolveCollisions(isolate, 0, 30, 1, null, stemOpts([[1, -1], [2, 162]], [[1, 0.9], [2, 0.9]]))
    expect(spreadOf(isolate)).toBeCloseTo(25, 6)
  })

  it('leaves the clearance law untouched without cleftPad', () => {
    // Same stem, same dominance — only the pad is off, so the gate must hold and
    // the pair keeps the plain body clearance.
    const gated = pair(10)
    resolveCollisions(gated, 0, 30, 1, null, stemOpts([[1, 161], [2, 161]], [[1, 0.9], [2, 0.9]], 0))
    expect(spreadOf(gated)).toBeCloseTo(20, 6)
    // S7/S8: no stem data at all is the same plain clearance, bit for bit.
    const plain = pair(10)
    resolveCollisions(plain, 0, 30, 1)
    expect(gated).toEqual(plain)
  })
})

describe('layout adapter', () => {
  it('a zero-iteration probe reports the cached frame verbatim', () => {
    const nodes = [
      { id: 1, prevXY: { x: 123.45, y: -67.89 } },
      { id: 2, prevXY: { x: 42, y: 84 } },
    ]
    const res = layout(nodes, [{ a: 1, b: 2, weight: 1 }], { seed: 1, fullRun: false, iterations: 0 })
    expect(res.positions.get(1)).toEqual({ x: 123.45, y: -67.89 })
    expect(res.positions.get(2)).toEqual({ x: 42, y: 84 })
    expect(res.iterationsDone).toBe(0)
  })

  it('reports the collision stage once on a full run', () => {
    const stages: number[] = []
    layout(
      [{ id: 1, size: 10 }, { id: 2, size: 10 }, { id: 3, size: 10 }],
      [{ a: 1, b: 2, weight: 2 }, { a: 2, b: 3, weight: 1 }],
      { seed: 3, fullRun: true, onStage: (done) => stages.push(done) },
    )
    expect(stages).toEqual([92])
  })
})

describe('reuse frame keeps edge routing (filter switch)', () => {
  // Two topic clusters joined by weak bridges. Dropping 2 of 16 words keeps
  // cachedShare 0.875 >= 0.65, so the filter path reuses the frame.
  const cluster = (base: number): Array<{ a: number; b: number; weight: number }> => {
    const edges: Array<{ a: number; b: number; weight: number }> = []
    for (let i = 0; i < 7; i++) edges.push({ a: base + i, b: base + i + 1, weight: 10 - i })
    edges.push({ a: base, b: base + 7, weight: 6 })
    return edges
  }
  const edges = [...cluster(1), ...cluster(9), { a: 8, b: 9, weight: 1 }, { a: 4, b: 12, weight: 1 }]
  const nodes = Array.from({ length: 16 }, (_, i) => ({ id: i + 1, size: 12 }))

  // Full run first: the reference frame with complete routing tables.
  const full = layout(nodes, edges, { seed: 7, fullRun: true })
  expect(full.ports!.size).toBeGreaterThan(0)

  // Filter switch: drop words 15-16, keep the rest on cached coordinates.
  const kept = nodes.filter((n) => n.id <= 14)
  const nodes2 = kept.map((n) => ({ ...n, prevXY: full.positions.get(n.id)! }))
  const edges2 = edges.filter((e) => e.a <= 14 && e.b <= 14)
  const reused = layout(nodes2, edges2, { seed: 7, fullRun: false })

  it('returns routing tables for the reused frame', () => {
    expect(reused.iterationsDone).toBe(0)
    expect(reused.ports!.size).toBeGreaterThan(0)
    expect(reused.groupOf!.size).toBe(nodes2.length)
    for (const [, g] of reused.groupOf!) expect(reused.ports!.has(g)).toBe(true)
    // Frame is reused verbatim: cached bodies do not move.
    for (const n of nodes2) expect(reused.positions.get(n.id)).toEqual(n.prevXY)
  })

  it('routes no edge as a straight fallback', () => {
    const posList = nodes2.map((n) => ({ id: n.id, ...reused.positions.get(n.id)! }))
    const maxW = Math.max(...edges2.map((e) => e.weight))
    const bundles = bundleEdges(posList, edges2, maxW, {
      ports: reused.ports!,
      groupOf: reused.groupOf!,
    })
    const straight = bundles.filter(
      (b) => b.tract[0] === 1 / 3 && b.tract[1] === 0 && b.tract[2] === 2 / 3 && b.tract[3] === 0,
    )
    expect(straight.length).toBe(0)
  })
})

describe('layout applies blob warp', () => {
  // Chat-like topology: 12 heavy stars joined by weak bridges (mirrors spread.test.ts synth).
  const synth = (
    n: number,
  ): {
    nodes: Array<{ id: number; size: number }>
    edges: Array<{ a: number; b: number; weight: number }>
  } => {
    const nodes = Array.from({ length: n }, (_, i) => {
      const t = i / n
      const size = t < 0.7 ? 5 + (i % 5) : t < 0.92 ? 10 + ((i * 3) % 14) : 28 + ((i * 7) % 44)
      return { id: i + 1, size }
    })
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
  // P10..P90 mass span per axis: same quantile helper as the S1 gate.
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
  // Spread of the silhouette edge: variance of radii past the median radius.
  // (Seed-sensitivity guard only: passes with or without the warp, since the
  // upstream pipeline is already seed-chaotic.)
  const edgeDispersion = (pts: Array<{ x: number; y: number }>): number => {
    const cx = pts.reduce((sum, p) => sum + p.x, 0) / pts.length
    const cy = pts.reduce((sum, p) => sum + p.y, 0) / pts.length
    const radii = pts.map((p) => Math.hypot(p.x - cx, p.y - cy)).sort((a, b) => a - b)
    const med = radii[Math.floor(radii.length / 2)]!
    const edge = radii.filter((r) => r >= med)
    const mean = edge.reduce((sum, r) => sum + r, 0) / edge.length
    return edge.reduce((sum, r) => sum + (r - mean) * (r - mean), 0) / edge.length
  }
  const aspectOf = (pts: Array<{ x: number; y: number }>): number =>
    qspan(pts.map((p) => p.x)) / Math.max(1e-9, qspan(pts.map((p) => p.y)))
  // FNV-1a over rounded coordinates: the wiring proof. Any change to the
  // spread/solve/warp/hold chain (including deleting the warp) flips it.
  // Regenerate deliberately, never by copying a red run blindly.
  const layoutHash = (pts: Array<{ x: number; y: number }>): string => {
    let h = 0x811c9dc5
    const s = pts.map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`).join(';')
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    return (h >>> 0).toString(16).padStart(8, '0')
  }
  const ring24 = (): {
    nodes: Array<{ id: number; size: number }>
    edges: Array<{ a: number; b: number; weight: number }>
  } => ({
    nodes: Array.from({ length: 24 }, (_, i) => ({ id: i + 1, size: 10 })),
    edges: Array.from({ length: 24 }, (_, i) => ({
      a: i + 1,
      b: ((i + 1) % 24) + 1,
      weight: 1,
    })),
  })

  it('warps the finished figure: warp is wired into the layout output', () => {
    // Golden hash of a 24-node ring (seed 7): proves the warp code path runs.
    // Deleting the warp (or reordering spread/solve/warp/hold) flips the hash.
    // Measured 2026-11-15, EDGE_AMP 0.38 / FREQ 3.0; regenerate deliberately.
    const { nodes, edges } = ring24()
    const inputs = nodes.map((n) => ({ id: n.id, size: n.size }))
    const res = layout(inputs, edges, { seed: 7, fullRun: true })
    const pts = nodes.map((n) => res.positions.get(n.id)!)
    expect(layoutHash(pts)).toBe('efc5ad66')
    // Aspect gate holds with the warp on (S1 shape, relaxed bounds for tiny maps).
    expect(aspectOf(pts)).toBeGreaterThanOrEqual(1.0)
  })

  it('warps the finished figure: two seeds give different silhouettes at the same aspect', () => {
    const { nodes, edges } = synth(271)
    const inputs = nodes.map((n) => ({ id: n.id, size: n.size }))
    const layouts = [7, 8, 42].map((seed) => layout(inputs, edges, { seed, fullRun: true }))
    const clouds = layouts.map((l) => nodes.map((n) => l.positions.get(n.id)!).filter(Boolean))
    // Seed-sensitivity guard (passes with or without the warp: upstream is
    // already seed-chaotic, so this alone proves nothing about the wiring —
    // the golden hash above is the warp-specific assertion).
    expect(Math.abs(edgeDispersion(clouds[0]!) - edgeDispersion(clouds[1]!))).toBeGreaterThan(1e-6)
    for (const pts of clouds) {
      expect(aspectOf(pts)).toBeGreaterThanOrEqual(1.6)
      expect(aspectOf(pts)).toBeLessThanOrEqual(2.1)
    }
    // S7 lives: the same seed gives byte-identical coordinates.
    const again = layout(inputs, edges, { seed: 7, fullRun: true })
    const pa = clouds[0]!
    for (let i = 0; i < nodes.length; i++) {
      expect(again.positions.get(nodes[i]!.id)).toEqual(pa[i])
    }
  })

  it('reuses the warped frame verbatim on a filter switch', () => {
    const { nodes, edges } = synth(271)
    const full = layout(
      nodes.map((n) => ({ id: n.id, size: n.size })),
      edges,
      { seed: 7, fullRun: true },
    )
    // Drop ~10%: cachedShare 0.9 >= 0.65, so the filter path reuses the frame.
    const kept = nodes.filter((n) => n.id <= 244)
    const ids = new Set(kept.map((n) => n.id))
    const nodes2 = kept.map((n) => ({ id: n.id, size: n.size, prevXY: full.positions.get(n.id)! }))
    const edges2 = edges.filter((e) => ids.has(e.a) && ids.has(e.b))
    const reused = layout(nodes2, edges2, { seed: 7, fullRun: false })
    expect(reused.iterationsDone).toBe(0)
    for (const n of nodes2) expect(reused.positions.get(n.id)).toEqual(n.prevXY)
  })
})
