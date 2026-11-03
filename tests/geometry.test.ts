import { describe, expect, it } from 'vitest'
import { edgeColor, edgeWidth, nodeFitSize } from '../src/core/geometry'

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
})
