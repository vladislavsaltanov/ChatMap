import { describe, expect, it } from 'vitest'
import { collisionIterationsForCount, getLruCache, layout, resolveCollisions, setLruCache, shapeNoise } from '../src/core/graph'

describe('LRU cache helpers', () => {
  it('evicts the least recently set key once maxEntries is exceeded', () => {
    const map = new Map<string, number>()
    setLruCache(map, 'a', 1, 2)
    setLruCache(map, 'b', 2, 2)
    setLruCache(map, 'c', 3, 2)
    expect([...map.keys()]).toEqual(['b', 'c'])
  })

  it('keeps keys that were read or re-set recently', () => {
    const map = new Map<string, number>()
    setLruCache(map, 'a', 1, 2)
    setLruCache(map, 'b', 2, 2)
    expect(getLruCache(map, 'a')).toBe(1)
    setLruCache(map, 'c', 3, 2)
    expect([...map.keys()]).toEqual(['a', 'c'])
    setLruCache(map, 'a', 10, 2)
    setLruCache(map, 'd', 4, 2)
    expect([...map.entries()]).toEqual([['a', 10], ['d', 4]])
  })

  it('getLruCache returns undefined for a missing key without inserting it', () => {
    const map = new Map<string, number>([['a', 1]])
    expect(getLruCache(map, 'missing')).toBeUndefined()
    expect([...map.keys()]).toEqual(['a'])
  })

  it('caps at 2000 entries by default', () => {
    const map = new Map<number, number>()
    for (let i = 0; i < 2001; i++) setLruCache(map, i, i)
    expect(map.size).toBe(2000)
    expect(map.has(0)).toBe(false)
    expect(map.has(2000)).toBe(true)
  })

  it('treats a non-positive maxEntries as an empty cache', () => {
    const map = new Map<number, number>()
    setLruCache(map, -1, -1, 0)
    expect(map.size).toBe(0)
    setLruCache(map, 5, 5, -1)
    expect(map.size).toBe(0)
  })
})

describe('layout', () => {
  it('(a) reuses prevXY coordinates when fullRun is false', () => {
    const nodes = [
      { id: 1, prevXY: { x: 123.45, y: -67.89 } },
      { id: 2, prevXY: { x: 42, y: 84 } },
    ]
    const edges = [{ a: 1, b: 2, weight: 1 }]
    // With 0 iterations, coordinates must match prevXY exactly
    const res = layout(nodes, edges, { seed: 1, fullRun: false, iterations: 0 })
    expect(res.positions.get(1)?.x).toBeCloseTo(123.45)
    expect(res.positions.get(1)?.y).toBeCloseTo(-67.89)
    expect(res.positions.get(2)?.x).toBeCloseTo(42)
    expect(res.positions.get(2)?.y).toBeCloseTo(84)
  })

  it('(b) produces identical deterministic layout given the same seed and input', () => {
    const nodes = [
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]
    const edges = [
      { a: 1, b: 2, weight: 2 },
      { a: 2, b: 3, weight: 1 },
    ]
    const run1 = layout(nodes, edges, { seed: 42, fullRun: true, iterations: 50 })
    const run2 = layout(nodes, edges, { seed: 42, fullRun: true, iterations: 50 })

    for (const n of nodes) {
      const p1 = run1.positions.get(n.id)!
      const p2 = run2.positions.get(n.id)!
      expect(p1.x).toBe(p2.x)
      expect(p1.y).toBe(p2.y)
    }
  })

  it('(c) runs configurable iterations in range 10..20 when fullRun is false', () => {
    const nodes = [{ id: 1 }, { id: 2 }]
    const edges = [{ a: 1, b: 2, weight: 1 }]
    const resDefault = layout(nodes, edges, { seed: 1, fullRun: false })
    expect(resDefault.iterationsDone).toBeGreaterThanOrEqual(10)
    expect(resDefault.iterationsDone).toBeLessThanOrEqual(20)

    const resConfigured = layout(nodes, edges, { seed: 1, fullRun: false, iterations: 17 })
    expect(resConfigured.iterationsDone).toBe(17)
  })

  it('(d) resolveCollisions separates overlapping nodes so distance >= r1 + r2 + padding', () => {
    // 5 nodes placed closely in a 10x10 square
    const nodes = [
      { id: 1, x: 0, y: 0, size: 20 },
      { id: 2, x: 5, y: 0, size: 20 },
      { id: 3, x: 0, y: 5, size: 20 },
      { id: 4, x: 5, y: 5, size: 20 },
      { id: 5, x: 2, y: 2, size: 25 },
    ]

    resolveCollisions(nodes, 8, 80)

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]
        const b = nodes[j]
        const dist = Math.hypot(b.x - a.x, b.y - a.y)
        const requiredDist = (a.size || 20) + (b.size || 20) + 7.5 // within floating-point tolerance
        expect(dist).toBeGreaterThanOrEqual(requiredDist)
      }
    }
  })

  it('(e) places strongly connected nodes closer together than weakly connected nodes', () => {
    const nodes = [
      { id: 1, size: 20 },
      { id: 2, size: 20 },
      { id: 3, size: 20 },
    ]
    // 1-2 has strong weight (20), 1-3 has weak weight (1)
    const edges = [
      { a: 1, b: 2, weight: 20 },
      { a: 1, b: 3, weight: 1 },
    ]
    const res = layout(nodes, edges, { seed: 42, fullRun: true, iterations: 150 })
    const p1 = res.positions.get(1)!
    const p2 = res.positions.get(2)!
    const p3 = res.positions.get(3)!

    const distStrong = Math.hypot(p2.x - p1.x, p2.y - p1.y)
    const distWeak = Math.hypot(p3.x - p1.x, p3.y - p1.y)

    expect(distStrong).toBeLessThan(distWeak)
  })

  it('clamps scaleFactor above 8 to 8 in resolveCollisions', () => {
    const padding = 10
    const separation = (scaleFactor: number) => {
      const nodes = [
        { id: 1, x: 0, y: 0, size: 20 },
        { id: 2, x: 0, y: 0, size: 20 },
      ]
      resolveCollisions(nodes, padding, 80, scaleFactor)
      return Math.hypot(nodes[1].x - nodes[0].x, nodes[1].y - nodes[0].y)
    }
    const expected = 2 * (20 * 8 + padding * 0.5)
    expect(separation(8)).toBeCloseTo(expected, 6)
    expect(separation(100)).toBeCloseTo(expected, 6)
  })

  it('collisionIterationsForCount uses 80 iterations up to 400 nodes and 30 above', () => {
    expect(collisionIterationsForCount(400)).toBe(80)
    expect(collisionIterationsForCount(401)).toBe(30)
    expect(collisionIterationsForCount(1000)).toBe(30)
  })

  it('calls onStage(92, stage) when iterations > 0', () => {
    const calls: Array<[number, string]> = []
    layout(
      [{ id: 1 }, { id: 2 }],
      [{ a: 1, b: 2, weight: 1 }],
      { seed: 1, fullRun: false, iterations: 10, onStage: (done, stage) => calls.push([done, stage]) }
    )
    expect(calls).toContainEqual([92, 'Разведение пересечений...'])
  })

  it('(f) shapeNoise is deterministic, bounded and varies with angle', () => {
    const phases = [0.7, 2.1, 4.4, 1.2, 5.0, 2.8]
    for (const angle of [0, 0.5, 1.1, 2.3, 3.4, 4.9, 5.8]) {
      expect(shapeNoise(angle, phases)).toBe(shapeNoise(angle, phases))
      expect(Math.abs(shapeNoise(angle, phases))).toBeLessThanOrEqual(1)
    }
    const values = [0, 0.9, 1.8, 2.7].map((a) => shapeNoise(a, phases))
    const spread = Math.max(...values) - Math.min(...values)
    expect(spread).toBeGreaterThan(0.3)
  })

  it('(g) fringe silhouette is noise-wobbled, not a smooth ring', () => {
    // Звезда: хаб плюс 24 листа; после FA2 и radialize листья лежат у края —
    // без шума их прицельный радиус задавался бы только рангом степени.
    const nodes = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }))
    const edges = nodes.slice(1).map((n) => ({ a: 1, b: n.id, weight: 5 }))
    const res = layout(nodes, edges, { seed: 1337, fullRun: true, iterations: 200 })
    const [, cx, cy] = [...res.positions.values()].reduce(
      (acc, p, idx) => {
        let x = acc[1] + (p.x - acc[1]) / (idx + 1)
        let y = acc[2] + (p.y - acc[2]) / (idx + 1)
        return [0, x, y]
      },
      [0, 0, 0] as [number, number, number]
    )
    const radii = [...res.positions.values()].map((p) => Math.hypot(p.x - cx, p.y - cy))
    const maxR = Math.max(...radii)
    // 24 листа на разных фазах шума угла (радиусы модулированы ±0.35·blend 0.3)
    expect(maxR).toBeGreaterThan(0)
    const fringe = radii.filter((r) => r > maxR * 0.55)
    const spread = Math.max(...fringe) - Math.min(...fringe)
    expect(spread / maxR).toBeGreaterThan(0.04)
  })

  it('(h) пятно разорвано: хабы на fringe-лобах, void>0.05', () => {
    const nodes = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, size: 20 }))
    const edges: Array<{ a: number; b: number; weight: number }> = []
    for (let h = 1; h <= 12; h++) {
      for (let k = 1; k <= 9; k++) {
        edges.push({ a: h, b: 12 + (h - 1) * 9 + k, weight: 3 + (k % 4) })
      }
    }
    const res = layout(nodes, edges, { seed: 1337, fullRun: true })
    const pts = [...res.positions.values()]
    const centroid = pts.reduce((a, p) => ({ x: a.x + p.x / pts.length, y: a.y + p.y / pts.length }), { x: 0, y: 0 })
    const radii = pts.map((p) => Math.hypot(p.x - centroid.x, p.y - centroid.y)).sort((a, b) => a - b)
    const median = radii[Math.floor(radii.length / 2)]
    for (let h = 1; h <= 12; h++) {
      const hp = res.positions.get(h)!
      expect(Math.hypot(hp.x - centroid.x, hp.y - centroid.y)).toBeGreaterThan(median)
    }
    const cell = 100
    const seen = new Set<string>()
    for (const p of pts) seen.add(`${Math.floor((p.x + 5000) / cell)},${Math.floor((p.y + 5000) / cell)}`)
    const minX = Math.floor((Math.min(...pts.map((p) => p.x)) + 5000) / cell)
    const maxX = Math.floor((Math.max(...pts.map((p) => p.x)) + 5000) / cell)
    const minY = Math.floor((Math.min(...pts.map((p) => p.y)) + 5000) / cell)
    const maxY = Math.floor((Math.max(...pts.map((p) => p.y)) + 5000) / cell)
    const total = (maxX - minX + 1) * (maxY - minY + 1)
    expect(1 - seen.size / total).toBeGreaterThan(0.05)
  })
})
