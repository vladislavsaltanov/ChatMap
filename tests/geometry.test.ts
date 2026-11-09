import { describe, expect, it } from 'vitest'
import {
  armsFor,
  bundleEdges,
  coreFrac,
  edgeAlpha,
  edgeColor,
  edgeWidth,
  fisheyePoint,
  haloPx,
  labelZoomRatio,
  lengthFade,
  nodeFitSize,
  phaseFor,
  quadOf,
  renderedNodeSize,
  visualCoreRadius,
  zoomSizeRatio,
} from '../src/core/geometry'

describe('fisheyePoint (zoom-in spread)', () => {
  const cfg = { fisheyeX: 0, fisheyeY: 0, fisheyeRadius: 1000, fisheyeStrength: 1 }

  it('is the identity when disabled or missing', () => {
    expect(fisheyePoint(120, -80, {})).toEqual({ x: 120, y: -80 })
    expect(fisheyePoint(120, -80, { ...cfg, fisheyeStrength: 0 })).toEqual({ x: 120, y: -80 })
    expect(fisheyePoint(120, -80, { ...cfg, fisheyeRadius: 0 })).toEqual({ x: 120, y: -80 })
  })

  it('keeps the camera centre fixed and moves points radially outward', () => {
    expect(fisheyePoint(0, 0, cfg)).toEqual({ x: 0, y: 0 })
    const p = fisheyePoint(200, 0, cfg)
    expect(p.x).toBeGreaterThan(200)
    expect(p.y).toBe(0)
    const q = fisheyePoint(-150, 150, cfg)
    expect(q.x).toBeLessThan(-150)
    expect(q.y).toBeGreaterThan(150)
    // Direction is preserved: it is a pure radial magnification.
    expect(q.y / q.x).toBeCloseTo(150 / -150, 6)
  })

  it('spreads nearby neighbours apart but barely touches distant nodes', () => {
    const a = fisheyePoint(100, 0, cfg)
    const b = fisheyePoint(140, 0, cfg)
    expect(b.x - a.x).toBeGreaterThan(40 * 1.1)
    const far = fisheyePoint(4000, 0, cfg)
    expect(far.x - 4000).toBeLessThan(0.01)
    const mid = fisheyePoint(1000, 0, cfg)
    expect(mid.x - 1000).toBeGreaterThan(0)
    expect(mid.x - 1000).toBeLessThan(b.x - 100)
  })

  it('scales with strength', () => {
    const weak = fisheyePoint(200, 0, { ...cfg, fisheyeStrength: 0.25 })
    const strong = fisheyePoint(200, 0, cfg)
    expect(weak.x).toBeLessThan(strong.x)
    expect(weak.x).toBeGreaterThan(200)
  })
})

describe('bundleEdges (neural tracts)', () => {
  // A tight fan: five edges leave the hub in nearly the same direction.
  const points = [
    { id: 1, x: 0, y: 0 },
    { id: 2, x: 100, y: -4 },
    { id: 3, x: 100, y: -2 },
    { id: 4, x: 100, y: 0 },
    { id: 5, x: 100, y: 2 },
    { id: 6, x: 100, y: 4 },
  ]
  const edges = points.slice(1).map((p) => ({ a: 1, b: p.id, weight: 10 }))

  // Rebuild the cubic Bezier point at t=1/3 from dimensionless coefficients.
  const thirdPoint = (tract: number[], a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const c1 = { x: a.x + dx * tract[0] - dy * tract[1], y: a.y + dy * tract[0] + dx * tract[1] }
    const c2 = { x: a.x + dx * tract[2] - dy * tract[3], y: a.y + dy * tract[2] + dx * tract[3] }
    return {
      x: (8 * a.x + 12 * c1.x + 6 * c2.x + b.x) / 27,
      y: (8 * a.y + 12 * c1.y + 6 * c2.y + b.y) / 27,
    }
  }
  const dist = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y)

  it('is deterministic, clamps coefficients and marks tract density', () => {
    const a = bundleEdges(points, edges, 10)
    expect(a).toEqual(bundleEdges(points, edges, 10))
    expect(a).toHaveLength(5)
    for (const info of a) {
      expect(info.tract).toHaveLength(4)
      expect(info.tract[0]).toBeGreaterThanOrEqual(-0.1)
      expect(info.tract[0]).toBeLessThanOrEqual(1.1)
      expect(info.tract[2]).toBeGreaterThanOrEqual(-0.1)
      expect(info.tract[2]).toBeLessThanOrEqual(1.1)
      expect(Math.abs(info.tract[1])).toBeLessThanOrEqual(0.35)
      expect(Math.abs(info.tract[3])).toBeLessThanOrEqual(0.35)
      expect(info.bundle).toBeGreaterThan(0)
      expect(info.bundle).toBeLessThanOrEqual(1)
    }
  })

  it('merges same-direction edges into a shared corridor', () => {
    const info = bundleEdges(points, edges, 10)
    const a = points[0]
    const b = points[1]
    const c = points[5]
    // Straight-line control points at t=1/3 are farther apart than bundled ones.
    const straight = dist(
      { x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 },
      { x: a.x + (c.x - a.x) / 3, y: a.y + (c.y - a.y) / 3 },
    )
    const bundled = dist(thirdPoint(info[0].tract, a, b), thirdPoint(info[4].tract, a, c))
    expect(bundled).toBeLessThan(straight)
  })

  it('leaves a lone edge straight and density-free', () => {
    expect(bundleEdges(points, [{ a: 2, b: 3 }], 10)[0]).toEqual({
      tract: [1 / 3, 0, 2 / 3, 0],
      bundle: 0,
      rank: 0,
      tractRank: 0,
    })
    // A near-vertical cross edge is not in the horizontal tract.
    const cross = bundleEdges(
      [...points, { id: 7, x: 4, y: 140 }],
      [...edges, { a: 1, b: 7, weight: 10 }],
      10,
    )
    expect(cross[5].bundle).toBe(0)
    expect(cross[5].tract).toEqual([1 / 3, 0, 2 / 3, 0])
  })

  it('missing positions and degenerate edges are safe', () => {
    const straight = {
      tract: [1 / 3, 0, 2 / 3, 0] as [number, number, number, number],
      bundle: 0, rank: 0, tractRank: 0,
    }
    expect(bundleEdges([], [{ a: 1, b: 2 }])[0]).toEqual(straight)
    expect(bundleEdges(points, [{ a: 1, b: 1 }])[0]).toEqual(straight)
  })

  it('density grows with the size of the tract', () => {
    const pair = bundleEdges(points, edges.slice(0, 2), 10)
    const full = bundleEdges(points, edges, 10)
    expect(Math.max(...full.map((i) => i.bundle))).toBeGreaterThan(Math.max(...pair.map((i) => i.bundle)))
  })

  it('ranks tract fibres by weight: the spine is the heaviest link', () => {
    const weighted = [
      { a: 1, b: 2, weight: 1 },
      { a: 1, b: 3, weight: 9 },
      { a: 1, b: 4, weight: 5 },
      { a: 1, b: 5, weight: 3 },
      { a: 1, b: 6, weight: 7 },
    ]
    const info = bundleEdges(points, weighted, 10)
    expect(info.map((i) => i.rank)).toEqual([4, 0, 2, 3, 1])
    expect(info.map((i) => i.rank).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4])
    expect(info[1].rank).toBe(0)
    expect(info).toEqual(bundleEdges(points, weighted, 10))
    // A lone edge is always its own spine.
    expect(bundleEdges(points, [{ a: 2, b: 3, weight: 4 }], 10)[0].rank).toBe(0)
  })

  it('glues nearby passing lines into one corridor regardless of LOD', () => {
    // Two hubs, four near-parallel fibres. Geometry is computed once in the
    // worker, so the merge cannot be undone by any camera ratio.
    const pts = [
      { id: 1, x: 0, y: 0 },
      { id: 2, x: 0, y: 8 },
      { id: 3, x: 200, y: 0 },
      { id: 4, x: 200, y: 8 },
      { id: 5, x: 200, y: 4 },
      { id: 6, x: 200, y: 12 },
    ]
    const es = [
      { a: 1, b: 3, weight: 10 },
      { a: 2, b: 4, weight: 10 },
      { a: 1, b: 5, weight: 8 },
      { a: 2, b: 6, weight: 8 },
    ]
    const info = bundleEdges(pts, es, 10)
    expect(info).toEqual(bundleEdges(pts, es, 10))
    expect(info.every((i) => i.bundle > 0)).toBe(true)
    // Shared dimensionless control coefficients = one visible line mid-path.
    for (const item of info) {
      for (let k = 0; k < 4; k++) {
        expect(Math.abs(item.tract[k] - info[0].tract[k])).toBeLessThan(0.04)
      }
    }
  })

  it('snap stays bounded on mixed-length corridors (no cusps, deterministic)', () => {
    const pts = [
      { id: 1, x: 0, y: 0 },
      { id: 2, x: 0, y: 6 },
      { id: 3, x: 160, y: 0 },
      { id: 4, x: 160, y: 6 },
      { id: 5, x: 320, y: 3 },
      { id: 6, x: 320, y: 9 },
    ]
    const es = [
      { a: 1, b: 3, weight: 9 },
      { a: 2, b: 4, weight: 7 },
      { a: 1, b: 5, weight: 5 },
      { a: 2, b: 6, weight: 3 },
    ]
    const info = bundleEdges(pts, es, 9)
    expect(info).toEqual(bundleEdges(pts, es, 9))
    for (const item of info) {
      for (const v of item.tract) expect(Number.isFinite(v)).toBe(true)
      expect(item.tract[0]).toBeGreaterThanOrEqual(-0.1)
      expect(item.tract[0]).toBeLessThanOrEqual(1.1)
      expect(item.tract[2]).toBeGreaterThanOrEqual(-0.1)
      expect(item.tract[2]).toBeLessThanOrEqual(1.1)
      expect(Math.abs(item.tract[1])).toBeLessThanOrEqual(0.3)
      expect(Math.abs(item.tract[3])).toBeLessThanOrEqual(0.3)
    }
  })

  it('ranks whole tracts: the heaviest corridor is the overview skeleton', () => {
    const extra = [
      ...points,
      { id: 7, x: 0, y: 300 },
      { id: 8, x: 100, y: 300 },
      { id: 9, x: 100, y: 304 },
    ]
    const mixed = [
      ...edges,
      { a: 7, b: 8, weight: 2 },
      { a: 7, b: 9, weight: 2 },
    ]
    const info = bundleEdges(extra, mixed, 10)
    expect(info[0].tractRank).toBe(0)
    expect(info[5].tractRank).toBe(1)
    expect(info[6].tractRank).toBe(1)
    expect(new Set(info.map((i) => i.tractRank))).toEqual(new Set([0, 1]))
  })
})

describe('geometry', () => {
  it('computes edgeWidth according to (w / wmax)^0.6', () => {
    expect(edgeWidth(0, 10)).toBe(0)
    expect(edgeWidth(10, 10)).toBe(1)
    expect(edgeWidth(5, 10)).toBeCloseTo(Math.pow(0.5, 0.6))
    expect(edgeWidth(5, 0)).toBe(0)
  })

  it('computes nodeFitSize: large bubbles for landmark words, small dots for rare words', () => {
    // Landmark high-frequency word encloses text and anchors graph
    const highFreqLong = nodeFitSize('договорились', 50, 50, 5)
    expect(highFreqLong).toBeGreaterThanOrEqual(70)
    expect(highFreqLong * 2).toBeGreaterThanOrEqual(12 * 7 + 8)

    // Robust against argument order (minCount / maxCount normalized)
    expect(nodeFitSize('договорились', 50, 5, 50)).toBe(highFreqLong)

    // Rare word is a small compact dot
    const rareSize = nodeFitSize('договорились', 5, 50, 5)
    expect(rareSize).toBeLessThanOrEqual(9)
    expect(rareSize).toBeGreaterThanOrEqual(4)

    // Higher frequency increases size relative to minCount
    expect(highFreqLong).toBeGreaterThan(rareSize)
    // Dynamic contrast ratio between top hub and rare word is at least 10x
    expect(highFreqLong / rareSize).toBeGreaterThanOrEqual(10)
  })

  it('computes edgeColor differentiating weak and strong connections', () => {
    const weakColor = edgeColor(1, 100)
    const strongColor = edgeColor(100, 100)
    expect(weakColor).not.toBe(strongColor)
    // Strong link is bright, weak is faint paper shadow
    expect(strongColor).toBe('#e8e2d6a6')
    expect(weakColor).toBe(weakColor)
    expect(Number.parseInt(weakColor.slice(-2), 16)).toBeLessThan(Number.parseInt('a6', 16))
    expect(edgeColor(0, 100)).toBe('#55524b1a')
  })

  it('edgeAlpha: monotonic in [0.1, 0.6]', () => {
    expect(edgeAlpha(0, 100)).toBe(0.1)
    expect(edgeAlpha(100, 100)).toBeCloseTo(0.6)
    expect(edgeAlpha(25, 100)).toBeCloseTo(0.35)
    expect(edgeAlpha(50, 100)).toBeGreaterThan(edgeAlpha(25, 100))
  })

  it('haloPx/quadOf/coreFrac: tight aura keeps quads close to the visible core', () => {
    expect(quadOf(20)).toBe(20 + haloPx(20))
    expect(coreFrac(20)).toBeCloseTo(20 / quadOf(20))
    expect(haloPx(5)).toBeGreaterThanOrEqual(3)
    expect(haloPx(5)).toBeLessThanOrEqual(10)
    expect(haloPx(60)).toBeLessThanOrEqual(10)
    expect(quadOf(0)).toBe(3)
    // Quad radius must stay near the core: labels and picking use it as the offset.
    expect(quadOf(38) - 38).toBeLessThanOrEqual(10)
  })

  it('visualCoreRadius: small dots preserved, hubs compressed, always monotonic', () => {
    expect(visualCoreRadius(5)).toBe(5)
    expect(visualCoreRadius(9)).toBe(9)
    expect(visualCoreRadius(0)).toBe(0)
    expect(visualCoreRadius(72)).toBeGreaterThan(30)
    expect(visualCoreRadius(72)).toBeLessThan(45)
    expect(visualCoreRadius(72)).toBeLessThan(72)
    let prev = 0
    for (let r = 0; r <= 100; r += 5) {
      const v = visualCoreRadius(r)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('zoomSizeRatio/renderedNodeSize: radii shrink exactly like positions on zoom-out', () => {
    expect(zoomSizeRatio(1)).toBe(1)
    expect(zoomSizeRatio(2)).toBe(2)
    expect(zoomSizeRatio(4)).toBe(4)
    expect(zoomSizeRatio(0.25)).toBeCloseTo(0.5)
    expect(renderedNodeSize(40, 1)).toBe(40)
    expect(renderedNodeSize(40, 2)).toBe(20)
    expect(renderedNodeSize(40, 4)).toBe(10)
    // Both node radius and graph distances scale with 1/ratio -> no relative growth.
    const distAt1 = 200
    const distAt3 = distAt1 / 3
    expect(renderedNodeSize(40, 3) / distAt3).toBeCloseTo(renderedNodeSize(40, 1) / distAt1)
  })

  it('labelZoomRatio: text shrinks far slower than node bodies on zoom-out', () => {
    expect(labelZoomRatio(1)).toBe(1)
    expect(labelZoomRatio(0.25)).toBeCloseTo(0.5)
    expect(labelZoomRatio(2)).toBeLessThan(zoomSizeRatio(2))
    expect(labelZoomRatio(3.4)).toBeLessThanOrEqual(1.7)
    expect(labelZoomRatio(10)).toBe(1.7)
    let prev = 0
    for (const r of [0.1, 0.25, 0.5, 1, 1.5, 2, 3, 5, 10]) {
      const v = labelZoomRatio(r)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('armsFor: angles to heaviest neighbors by weight, -1 for missing slots', () => {
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

  it('phaseFor: deterministic and in [0, 1)', () => {
    expect(phaseFor(7)).toBe(phaseFor(7))
    expect(phaseFor(7)).not.toBe(phaseFor(8))
    expect(phaseFor(0)).toBeGreaterThanOrEqual(0)
    expect(phaseFor(0)).toBeLessThan(1)
    expect(phaseFor(123456)).toBeLessThan(1)
  })
})

describe('lengthFade (long weak links dissolve)', () => {
  it('short edges stay fully visible regardless of strength', () => {
    expect(lengthFade(0.5, 0)).toBe(1)
    expect(lengthFade(1, 0)).toBe(1)
    expect(lengthFade(2, 0)).toBe(1)
  })

  it('long weak edges dissolve, strong corridors only quiet down', () => {
    expect(lengthFade(5, 0)).toBe(0)
    // no full veto: even the strongest corridor is still a line across the map
    expect(lengthFade(5, 1)).toBeCloseTo(0.35)
    const mid = lengthFade(2.75, 0)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
    // strength scales the dissolve linearly (softens, never vetoes)
    expect(lengthFade(2.75, 0.5)).toBeCloseTo(1 - (1 - mid) * 0.825)
  })

  it('non-positive reach never fades', () => {
    expect(lengthFade(0, 0)).toBe(1)
    expect(lengthFade(-1, 0)).toBe(1)
  })
})
