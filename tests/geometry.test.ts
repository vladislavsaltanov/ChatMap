import { describe, expect, it } from 'vitest'
import { edgeColor, edgeWidth, nodeFitSize, nodeSize } from '../src/core/geometry'

describe('geometry', () => {
  it('computes nodeSize according to 4 + 22 * sqrt(count / maxCount)', () => {
    expect(nodeSize(0, 100)).toBe(4)
    expect(nodeSize(100, 100)).toBe(26)
    expect(nodeSize(25, 100)).toBe(4 + 22 * 0.5) // 15
    expect(nodeSize(10, 0)).toBe(4)
  })

  it('computes relative nodeSize with minCount across visible spectrum', () => {
    expect(nodeSize(10, 100, 10)).toBe(5)
    expect(nodeSize(100, 100, 10)).toBe(26)
    const mid = nodeSize(30, 100, 10)
    expect(mid).toBeGreaterThan(5)
    expect(mid).toBeLessThan(26)
  })

  it('computes edgeWidth according to (w / wmax)^0.6', () => {
    expect(edgeWidth(0, 10)).toBe(0)
    expect(edgeWidth(10, 10)).toBe(1)
    expect(edgeWidth(5, 10)).toBeCloseTo(Math.pow(0.5, 0.6))
    expect(edgeWidth(5, 0)).toBe(0)
  })

  it('computes nodeFitSize ensuring cell diameter comfortably encloses word text', () => {
    // Short word
    const shortSize = nodeFitSize('да', 5, 50, 5)
    expect(shortSize * 2).toBeGreaterThanOrEqual(2 * 7 + 8)

    // Long word
    const longSize = nodeFitSize('договорились', 5, 50, 5)
    expect(longSize * 2).toBeGreaterThanOrEqual(12 * 7 + 8)

    // Longer word is larger than shorter word at same frequency
    expect(longSize).toBeGreaterThan(shortSize)

    // Higher frequency increases size relative to minCount
    const highFreqSize = nodeFitSize('договорились', 50, 50, 5)
    expect(highFreqSize).toBeGreaterThan(longSize)
  })

  it('computes edgeColor differentiating weak and strong connections', () => {
    const weakColor = edgeColor(1, 100)
    const strongColor = edgeColor(100, 100)
    expect(weakColor).not.toBe(strongColor)
    expect(strongColor).toBe('#b4cdfff2')
    expect(edgeColor(0, 100)).toBe('#23253030')
  })
})
