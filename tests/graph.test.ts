import { describe, expect, it } from 'vitest'
import { collisionIterationsForCount, getLruCache, layout, resolveCollisions, setLruCache } from '../src/core/graph'

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
})
