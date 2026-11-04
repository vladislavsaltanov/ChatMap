import { describe, expect, it } from 'vitest'
import { armsFor, coreFrac, edgeAlpha, edgeColor, edgeWidth, haloPx, nodeFitSize, phaseFor, quadOf } from '../src/core/geometry'

describe('geometry', () => {
  it('computes edgeWidth according to (w / wmax)^0.6', () => {
    expect(edgeWidth(0, 10)).toBe(0)
    expect(edgeWidth(10, 10)).toBe(1)
    expect(edgeWidth(5, 10)).toBeCloseTo(Math.pow(0.5, 0.6))
    expect(edgeWidth(5, 0)).toBe(0)
  })

  it('computes nodeFitSize: large bubbles for landmark words, small dots for rare words', () => {
    // Landmark high-frequency word encloses text
    const highFreqLong = nodeFitSize('договорились', 50, 50, 5)
    expect(highFreqLong * 2).toBeGreaterThanOrEqual(12 * 7 + 8)

    // Rare word is a small compact dot
    const rareSize = nodeFitSize('договорились', 5, 50, 5)
    expect(rareSize).toBeLessThanOrEqual(9)
    expect(rareSize).toBeGreaterThanOrEqual(4)

    // Higher frequency increases size relative to minCount
    expect(highFreqLong).toBeGreaterThan(rareSize)
  })

  it('computes edgeColor differentiating weak and strong connections', () => {
    const weakColor = edgeColor(1, 100)
    const strongColor = edgeColor(100, 100)
    expect(weakColor).not.toBe(strongColor)
    // Сильная связь ярче, слабая — призрачно-тихая (иерархия артерий)
    expect(strongColor).toBe('#e8e2d6a6')
    expect(weakColor).toBe(weakColor)
    expect(Number.parseInt(weakColor.slice(-2), 16)).toBeLessThan(Number.parseInt('a6', 16))
    expect(edgeColor(0, 100)).toBe('#55524b1a')
  })

  it('edgeAlpha: монотонна и в [0.1,0.6]', () => {
    expect(edgeAlpha(0, 100)).toBe(0.1)
    expect(edgeAlpha(100, 100)).toBeCloseTo(0.6)
    expect(edgeAlpha(25, 100)).toBeCloseTo(0.35)
    expect(edgeAlpha(50, 100)).toBeGreaterThan(edgeAlpha(25, 100))
  })

  it('haloPx/quadOf/coreFrac: квад = ядро+гало, границы', () => {
    expect(quadOf(20)).toBe(20 + haloPx(20))
    expect(coreFrac(20)).toBeCloseTo(20 / quadOf(20))
    expect(haloPx(5)).toBeGreaterThanOrEqual(12)
    expect(haloPx(60)).toBeLessThanOrEqual(44)
    expect(quadOf(0)).toBe(12)
  })

  it('armsFor: углы к сильнейшим соседям по весу, -1 для пустот', () => {
    const nodes = [
      { id: 1, x: 0, y: 0 },
      { id: 2, x: 10, y: 0 },
      { id: 4, x: -10, y: 0 },
      { id: 3, x: 0, y: 10 },
    ]
    const edges = [
      { a: 1, b: 2, weight: 5 },
      { a: 1, b: 4, weight: 5 },
      { a: 1, b: 3, weight: 1 },
    ]
    const arms = armsFor(nodes, edges, 1)
    expect(arms).toHaveLength(5)
    expect(arms[0]).toBeCloseTo(0)
    expect(arms[1]).toBeCloseTo(0.5)
    expect(arms[2]).toBeCloseTo(0.25)
    expect(arms[3]).toBe(-1)
    expect(arms[4]).toBe(-1)
    expect(armsFor(nodes, edges, 99)).toEqual([-1, -1, -1, -1, -1])
  })

  it('phaseFor: детерминирован и в [0,1)', () => {
    expect(phaseFor(7)).toBe(phaseFor(7))
    expect(phaseFor(7)).not.toBe(phaseFor(8))
    expect(phaseFor(0)).toBeGreaterThanOrEqual(0)
    expect(phaseFor(0)).toBeLessThan(1)
    expect(phaseFor(123456)).toBeLessThan(1)
  })
})
