import { describe, expect, it } from 'vitest'
import { layout } from '../src/core/graph'

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
})
