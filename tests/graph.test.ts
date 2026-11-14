import { describe, expect, it } from 'vitest'
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
