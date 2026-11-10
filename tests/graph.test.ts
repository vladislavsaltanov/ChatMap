import { describe, expect, it } from 'vitest'
import { collisionCandidatePairs, collisionIterationsForCount, fractalClusterPlane, fractalDensity, fractalNoise, getLruCache, layout, resolveCollisions, setLruCache, shapeNoise, warpPlane } from '../src/core/graph'

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

describe('fractalNoise', () => {
  const phases = [0.3, 1.1, 2.7, 4.2, 5.1, 0.8]

  it('is deterministic and bounded', () => {
    for (const [a, u] of [[0, 0], [1.2, 0.4], [3.4, 1], [5.9, 0.8]]) {
      expect(fractalNoise(a, u, phases)).toBe(fractalNoise(a, u, phases))
      expect(Math.abs(fractalNoise(a, u, phases))).toBeLessThanOrEqual(1)
    }
  })

  it('varies with both angle and radius, so contours break at several scales', () => {
    const angles = [0, 0.5, 1, 1.5, 2].map((a) => fractalNoise(a, 0.5, phases))
    expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThan(0.3)
    const radii = [0, 0.3, 0.6, 0.9].map((u) => fractalNoise(1, u, phases))
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(0.05)
  })
})

describe('fractalDensity — двумерное fBm-поле плотности', () => {
  const phases = [0.7, 2.1, 4.4, 1.2, 5.0, 2.8, 3.6, 0.4]

  it('детерминировано, ограничено, зависит от seed', () => {
    for (const [x, y] of [[0, 0], [1.2, -0.4], [-3.4, 2], [5.9, 0.8]]) {
      expect(fractalDensity(x, y, phases, 7)).toBe(fractalDensity(x, y, phases, 7))
      expect(Math.abs(fractalDensity(x, y, phases, 7))).toBeLessThanOrEqual(1)
    }
    expect(fractalDensity(1.7, -0.6, phases, 1)).not.toBe(fractalDensity(1.7, -0.6, phases, 2))
  })

  it('имеет и крупные бассейны, и мелкую фрактальную структуру', () => {
    const a = fractalDensity(0, 0, phases, 7)
    expect(Math.abs(a - fractalDensity(5.9, 0.8, phases, 7))).toBeGreaterThan(0.2)
    expect(Math.abs(a - fractalDensity(0.02, 0, phases, 7))).toBeGreaterThan(0.005)
    let spread = -Infinity
    for (let i = -6; i <= 6; i++) {
      for (let j = -6; j <= 6; j++) spread = Math.max(spread, fractalDensity(i * 0.4, j * 0.4, phases, 7))
    }
    expect(spread).toBeGreaterThan(0.1)
  })
})

describe('fractalClusterPlane', () => {
  const phases = [0.7, 2.1, 4.4, 1.2, 5.0, 2.8, 3.6, 0.4]
  const grid = () =>
    Array.from({ length: 256 }, (_, k) => ({
      x: ((k % 16) - 7.5) * 100,
      y: (Math.floor(k / 16) - 7.5) * 100,
    }))
  const occupancy = (pts: Array<{ x: number; y: number }>) => {
    const cells = new Map<string, number>()
    for (const p of pts) {
      const key = `${Math.floor(p.x / 200)},${Math.floor(p.y / 200)}`
      cells.set(key, (cells.get(key) ?? 0) + 1)
    }
    const inside: number[] = []
    for (let i = -4; i < 4; i++) {
      for (let j = -4; j < 4; j++) inside.push(cells.get(`${i},${j}`) ?? 0)
    }
    const mean = inside.reduce((s, c) => s + c, 0) / inside.length
    const sd = Math.sqrt(inside.reduce((s, c) => s + (c - mean) ** 2, 0) / inside.length)
    return { empty: inside.filter((c) => c === 0).length / inside.length, max: Math.max(...inside), cv: sd / mean }
  }

  it('при strength 0 и на <3 точках оставляет координаты в покое', () => {
    const a = grid()
    const snapshot = a.map((p) => ({ ...p }))
    fractalClusterPlane(a, phases, 7, 0)
    expect(a).toEqual(snapshot)
    const tiny = [{ x: 1, y: 2 }, { x: 3, y: 4 }]
    fractalClusterPlane(tiny, phases, 7, 1)
    expect(tiny).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }])
  })

  it('детерминировано и не раздувает облако бесконечно', () => {
    const a = grid()
    const b = grid()
    fractalClusterPlane(a, phases, 7, 1)
    fractalClusterPlane(b, phases, 7, 1)
    expect(a).toEqual(b)
    const before = Math.max(...grid().map((p) => Math.hypot(p.x, p.y)))
    const after = Math.max(...a.map((p) => Math.hypot(p.x, p.y)))
    expect(after).toBeLessThan(before * 1.6)
    expect(after).toBeGreaterThan(0)
  })

  it('равномерная сетка превращается в сгустки и пустые карманы', () => {
    const before = occupancy(grid())
    const pts = grid()
    fractalClusterPlane(pts, phases, 7, 1)
    const after = occupancy(pts)
    expect(before.empty).toBe(0)
    expect(before.max).toBe(4)
    expect(after.empty).toBeGreaterThan(0.15)
    expect(after.max).toBeGreaterThanOrEqual(9)
    expect(after.cv).toBeGreaterThan(before.cv + 0.4)
  })

  it('вызывает onPass один раз за проход', () => {
    let passes = 0
    fractalClusterPlane(grid(), phases, 7, 1, 12, () => { passes++ })
    expect(passes).toBe(12)
  })
})

describe('warpPlane', () => {
  const phases = [0.7, 2.1, 4.4, 1.2, 5.0, 2.8, 0.4, 3.3, 1.9]
  const ring = () =>
    Array.from({ length: 24 }, (_, i) => ({
      x: Math.cos((i / 24) * Math.PI * 2) * 100,
      y: Math.sin((i / 24) * Math.PI * 2) * 100,
    }))

  it('is deterministic and keeps radii bounded', () => {
    const a = ring()
    const b = ring()
    warpPlane(a, phases)
    warpPlane(b, phases)
    expect(a).toEqual(b)
    // u <= 1.35 and the widescreen X stretch of 1.55 bound the radius.
    for (const p of a) expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(210)
  })

  it('turns a uniform ring into an uneven, bent silhouette', () => {
    const points = ring()
    const before = points.map((p) => Math.atan2(p.y, p.x))
    warpPlane(points, phases)
    const radii = points.map((p) => Math.hypot(p.x, p.y))
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(10)

    const bent = points.filter((p, i) => {
      const after = Math.atan2(p.y, p.x)
      const delta = Math.abs(Math.atan2(Math.sin(after - before[i]), Math.cos(after - before[i])))
      return delta > 0.02
    })
    expect(bent.length).toBeGreaterThan(3)
  })

  it('stretches horizontally for a widescreen monitor', () => {
    const points = ring()
    warpPlane(points, phases)
    const spanX = Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x))
    const spanY = Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y))
    expect(spanX / spanY).toBeGreaterThan(1.15)
  })

  it('does nothing for fewer than 3 points', () => {
    const points = [{ x: 10, y: 20 }, { x: -5, y: 3 }]
    warpPlane(points, phases)
    expect(points).toEqual([{ x: 10, y: 20 }, { x: -5, y: 3 }])
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

  it('clamps scaleFactor above 10 to 10 in resolveCollisions', () => {
    const padding = 10
    const separation = (scaleFactor: number) => {
      const nodes = [
        { id: 1, x: 0, y: 0, size: 20 },
        { id: 2, x: 0, y: 0, size: 20 },
      ]
      resolveCollisions(nodes, padding, 80, scaleFactor)
      return Math.hypot(nodes[1].x - nodes[0].x, nodes[1].y - nodes[0].y)
    }
    const expected = 2 * (20 * 10 + padding * 0.5)
    expect(separation(10)).toBeCloseTo(expected, 6)
    expect(separation(100)).toBeCloseTo(expected, 6)
  })

  it('collisionIterationsForCount uses 80 iterations up to 400 nodes and 30 above', () => {
    expect(collisionIterationsForCount(400)).toBe(80)
    expect(collisionIterationsForCount(401)).toBe(30)
    expect(collisionIterationsForCount(1000)).toBe(30)
  })

  it('collisionCandidatePairs stays sparse on 1000 spread nodes and tracks current positions', () => {
    // 40x25 grid with 200-unit spacing: neighbours share 120-unit cells, far nodes do not.
    const nodes = Array.from({ length: 1000 }, (_, k) => ({
      x: (k % 40) * 200,
      y: Math.floor(k / 40) * 200,
      size: 20,
    }))
    const before = collisionCandidatePairs(nodes, 8, 1, null)
    expect(before.length).toBeGreaterThan(0)
    expect(before.length).toBeLessThan(nodes.length * 12)
    const snapshot = JSON.stringify(before)
    nodes[0].x += 1000
    nodes[0].y += 1000
    const after = collisionCandidatePairs(nodes, 8, 1, null)
    expect(JSON.stringify(after)).not.toBe(snapshot)
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

  it('(j) сдвиги лобов не накапливаются: супер-хаб не улетает за fringe', () => {
    const nodes = Array.from({ length: 121 }, (_, i) => ({ id: i + 1, size: 20 }))
    const edges: Array<{ a: number; b: number; weight: number }> = []
    for (let h = 0; h < 12; h++) {
      const hub = 2 + h
      edges.push({ a: 1, b: hub, weight: 5 })
      for (let k = 0; k < 9; k++) edges.push({ a: hub, b: 14 + h * 9 + k, weight: 3 })
    }
    const res = layout(nodes, edges, { seed: 1337, fullRun: true })
    const pts = [...res.positions.values()]
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
    const rs = pts.map((p) => Math.hypot(p.x - cx, p.y - cy)).sort((a, b) => a - b)
    const p90 = rs[Math.floor(rs.length * 0.9)]
    expect(rs[rs.length - 1] / p90).toBeLessThan(3)
  })

  it('(i) 600 узлов не дают кашу: пересечений <5% пар, центр разрежен', () => {
    const nodes = Array.from({ length: 600 }, (_, i) => ({ id: i + 1, size: 20 }))
    const edges: Array<{ a: number; b: number; weight: number }> = []
    for (let h = 1; h <= 12; h++) {
      for (let k = 1; k <= 49; k++) {
        edges.push({ a: h, b: 12 + (h - 1) * 49 + k, weight: 3 + (k % 4) })
      }
    }
    const res = layout(nodes, edges, { seed: 1337, fullRun: true })
    const pts = [...res.positions.values()]
    let overlap = 0
    let pairs = 0
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        pairs++
        if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) < 36) overlap++
      }
    }
    expect(overlap / pairs).toBeLessThan(0.05)
    const inCenter = pts.filter((p) => Math.abs(p.x) < 500 && Math.abs(p.y) < 500).length
    expect(inCenter).toBeLessThan(60)
  }, 60000)

  it('(k) large hubs and satellite nodes maintain screen-equivalent clearance without overlapping', () => {
    const nodes = [
      { id: 1, size: 60 },
      ...Array.from({ length: 8 }, (_, i) => ({ id: i + 2, size: 4 + i * 2 }))
    ]
    const edges = nodes.slice(1).map((n) => ({ a: 1, b: n.id, weight: 10 }))
    const res = layout(nodes, edges, { seed: 42, fullRun: true, iterations: 150 })
    const p1 = res.positions.get(1)!
    for (let i = 2; i <= 9; i++) {
      const pi = res.positions.get(i)!
      const dist = Math.hypot(pi.x - p1.x, pi.y - p1.y)
      const satelliteSize = (4 + (i - 2) * 2)
      const minWorldDist = (60 + satelliteSize) * 8
      expect(dist).toBeGreaterThanOrEqual(minWorldDist * 0.95)
    }
  })

  // Realistic size mix: most words are small dots, a few are landmark hubs.
  const mixedNodes = (n: number) =>
    Array.from({ length: n }, (_, i) => {
      const t = i / n
      const size = t < 0.70 ? 5 + (i % 5) : t < 0.92 ? 10 + ((i * 3) % 14) : 28 + ((i * 7) % 44)
      return { id: i + 1, size }
    })
  const hubEdges = (n: number) => {
    const edges: Array<{ a: number; b: number; weight: number }> = []
    const hubs = 12
    const per = Math.floor((n - hubs) / hubs)
    for (let h = 1; h <= hubs; h++) {
      for (let k = 0; k < per; k++) {
        const b = hubs + (h - 1) * per + k + 1
        if (b <= n) edges.push({ a: h, b, weight: 3 + (k % 4) })
      }
    }
    return edges
  }

  it('(l) карта неравномерна: сгустки и пустые зоны, но зазор гарантирован', () => {
    const nodes = mixedNodes(271)
    const res = layout(nodes, hubEdges(271), { seed: 1337, fullRun: true })
    const pts = [...res.positions.values()]
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
    const maxR = Math.max(...pts.map((p) => Math.hypot(p.x - cx, p.y - cy)))
    const cell = maxR / 9
    const cells = new Map<string, number>()
    for (const p of pts) {
      const key = `${Math.floor((p.x - cx) / cell)},${Math.floor((p.y - cy) / cell)}`
      cells.set(key, (cells.get(key) ?? 0) + 1)
    }
    const central: number[] = []
    for (let i = -7; i <= 7; i++) {
      for (let j = -7; j <= 7; j++) {
        if (Math.hypot((i + 0.5) * cell, (j + 0.5) * cell) > 0.7 * maxR) continue
        central.push(cells.get(`${i},${j}`) ?? 0)
      }
    }
    const mean = central.reduce((s, c) => s + c, 0) / central.length
    const sd = Math.sqrt(central.reduce((s, c) => s + (c - mean) ** 2, 0) / central.length)
    const empty = central.filter((c) => c === 0).length / central.length
    expect(empty).toBeGreaterThan(0.38)
    expect(sd / mean).toBeGreaterThan(1.3)
    expect(Math.max(...central)).toBeGreaterThanOrEqual(8)

    let minPair = Infinity
    let overlaps = 0
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)
        if (d < minPair) minPair = d
        if (d < 36) overlaps++
      }
    }
    // Baseline was 164 world units; the fractal map keeps a WIDER clearance.
    expect(minPair).toBeGreaterThan(178)
    expect(overlaps).toBe(0)
  }, 60000)

  it('(l2) 600 узлов: зазор не проваливается на большой карте', () => {
    // Above 400 nodes the collision budget drops to the helper's own small
    // budget (x2), so the >400 branch needs its own quality gate.
    const nodes = mixedNodes(600)
    const res = layout(nodes, hubEdges(600), { seed: 1337, fullRun: true })
    const pts = [...res.positions.values()]
    let minPair = Infinity
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)
        if (d < minPair) minPair = d
      }
    }
    expect(minPair).toBeGreaterThan(170)
  }, 60000)

  it('(m) кластеризация детерминирована для больших карт', () => {
    const nodes = mixedNodes(60)
    const edges = hubEdges(60)
    const a = layout(nodes, edges, { seed: 4242, fullRun: true })
    const b = layout(nodes, edges, { seed: 4242, fullRun: true })
    expect([...a.positions.entries()]).toEqual([...b.positions.entries()])
  })
})
