import { describe, expect, it } from 'vitest'
import { blobOffset, CARVE_AMP, DOMAIN_AMP, EDGE_AMP, warpDamp } from '../src/core/blob'

const HALF_SPANS = [100, 1300, 8000]
// Hard clamp from the implementation: radial + domain + carve, per axis.
const warpBound = (halfSpan: number): number => (EDGE_AMP + DOMAIN_AMP + CARVE_AMP) * halfSpan

// Sample a 11x11 grid covering the figure and a margin beyond the silhouette.
const grid = (halfSpan: number): Array<{ x: number; y: number }> => {
  const pts: Array<{ x: number; y: number }> = []
  for (let iy = 0; iy < 11; iy++) {
    for (let ix = 0; ix < 11; ix++) {
      pts.push({
        x: ((ix / 10) * 2 - 1) * halfSpan * 1.2,
        y: ((iy / 10) * 2 - 1) * halfSpan * 1.2,
      })
    }
  }
  return pts
}

describe('blobOffset', () => {
  it('is deterministic: the same inputs give byte-identical offsets', () => {
    const a = blobOffset(123.4, -56.7, 10, 20, 1300, 7)
    const b = blobOffset(123.4, -56.7, 10, 20, 1300, 7)
    expect(Object.is(a.dx, b.dx)).toBe(true)
    expect(Object.is(a.dy, b.dy)).toBe(true)
    expect(a).toEqual(b)
  })

  it('damps only the radial term by body size', () => {
    // Size law: dust rides full spikes, a 50px hub keeps ~15%.
    expect(warpDamp(0)).toBe(1)
    expect(warpDamp(5)).toBeGreaterThan(0.95)
    expect(warpDamp(50)).toBeLessThanOrEqual(0.2)
    const out = [50, 30, 15, 5].map((s) => warpDamp(s))
    for (let i = 0; i < out.length - 1; i++) expect(out[i]!).toBeLessThan(out[i + 1]!)
    // Default call equals damp=1 exactly (backward compatible).
    const p = blobOffset(900, 300, 0, 0, 1300, 7)
    expect(blobOffset(900, 300, 0, 0, 1300, 7, 1)).toEqual(p)
    // Zero damp kills the rim excursion but keeps domain/carve texture:
    // a damped hub moves strictly less than the full field at the same spot.
    const d0 = blobOffset(900, 300, 0, 0, 1300, 7, 0)
    expect(Math.hypot(d0.dx, d0.dy)).toBeLessThan(Math.hypot(p.dx, p.dy))
  })

  for (const halfSpan of HALF_SPANS) {
    it(`stays inside MAX_WARP over the grid (halfSpan ${halfSpan})`, () => {
      const bound = warpBound(halfSpan)
      for (const p of grid(halfSpan)) {
        const { dx, dy } = blobOffset(p.x, p.y, 0, 0, halfSpan, 7)
        expect(Number.isFinite(dx)).toBe(true)
        expect(Number.isFinite(dy)).toBe(true)
        expect(Math.abs(dx)).toBeLessThanOrEqual(bound)
        expect(Math.abs(dy)).toBeLessThanOrEqual(bound)
      }
    })
  }

  it('gives different silhouettes for different seeds', () => {
    const halfSpan = 1300
    const pts = grid(halfSpan)
    const a = pts.map((p) => blobOffset(p.x, p.y, 0, 0, halfSpan, 7))
    const b = pts.map((p) => blobOffset(p.x, p.y, 0, 0, halfSpan, 8))
    let sum = 0
    for (let i = 0; i < pts.length; i++) {
      sum += Math.hypot(a[i].dx - b[i].dx, a[i].dy - b[i].dy)
    }
    expect(sum / pts.length).toBeGreaterThan(1e-3 * halfSpan)
  })

  it('pins the centroid', () => {
    for (const halfSpan of HALF_SPANS) {
      const { dx, dy } = blobOffset(42, -17, 42, -17, halfSpan, 7)
      expect(Math.abs(dx)).toBeLessThanOrEqual(1e-9)
      expect(Math.abs(dy)).toBeLessThanOrEqual(1e-9)
    }
  })

  it('stays finite and bounded on extreme inputs', () => {
    const halfSpan = 8000
    const bound = warpBound(halfSpan)
    const cases: Array<[number, number]> = [
      [0, 0],
      [1e12, -1e12],
      [-1e12, 1e12],
      [-1e-9, 1e-9],
      [1e12, 0],
    ]
    for (const [x, y] of cases) {
      const { dx, dy } = blobOffset(x, y, 0, 0, halfSpan, 7)
      expect(Number.isFinite(dx)).toBe(true)
      expect(Number.isFinite(dy)).toBe(true)
      expect(Math.abs(dx)).toBeLessThanOrEqual(bound)
      expect(Math.abs(dy)).toBeLessThanOrEqual(bound)
    }
    // Non-finite inputs are clamped at the door, never propagated.
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(blobOffset(bad, 0, 0, 0, halfSpan, 7)).toEqual({ dx: 0, dy: 0 })
      expect(blobOffset(0, bad, 0, 0, halfSpan, 7)).toEqual({ dx: 0, dy: 0 })
      expect(blobOffset(0, 0, bad, 0, halfSpan, 7)).toEqual({ dx: 0, dy: 0 })
      expect(blobOffset(0, 0, 0, 0, bad, 7)).toEqual({ dx: 0, dy: 0 })
    }
  })

  // Interior burn: the downhill flow evacuates fBm maxima, so a warped
  // uniform grid ends up clumpier than the flat one (higher per-bin variance:
  // filaments where flow converges, holes where it diverges).
  for (const seed of [7, 42, 1337]) {
    it(`carves density variance out of a uniform grid (seed ${seed})`, () => {
      const halfSpan = 1000
      const n = 25
      const lo = -1.2 * halfSpan
      const hi = 1.2 * halfSpan
      const NB = 16
      const cell = (hi - lo) / NB
      const at = (p: { x: number; y: number }): number => {
        const c = (v: number): number => Math.max(0, Math.min(NB - 1, Math.floor((v - lo) / cell)))
        return c(p.y) * NB + c(p.x)
      }
      const variance = (pts: Array<{ x: number; y: number }>): number => {
        const counts = new Array(NB * NB).fill(0)
        for (const p of pts) counts[at(p)]++
        const mean = pts.length / (NB * NB)
        return counts.reduce((s: number, c: number) => s + (c - mean) * (c - mean), 0) / (NB * NB)
      }
      const flat: Array<{ x: number; y: number }> = []
      for (let iy = 0; iy < n; iy++) {
        for (let ix = 0; ix < n; ix++) {
          flat.push({ x: lo + ((ix + 0.5) / n) * (hi - lo), y: lo + ((iy + 0.5) / n) * (hi - lo) })
        }
      }
      const warped = flat.map((p) => {
        const o = blobOffset(p.x, p.y, 0, 0, halfSpan, seed)
        return { x: p.x + o.dx, y: p.y + o.dy }
      })
      // Measured 2026-11-15: flat 1.262, warped 2.53/1.74/1.66 (seeds 7/42/1337).
      // Threshold sits at ~90% of the weakest seed; re-measure, don't re-think.
      expect(variance(warped)).toBeGreaterThan(variance(flat) * 1.2)
    })
  }

  // Angular raggedness: the edge radius must vary WITH ANGLE (coastline),
  // not just spread out (a bigger smooth ellipse also raises raw variance).
  // containTail compresses tails but keeps angles, so this survives it.
  const angularRaggedness = (pts: Array<{ x: number; y: number }>): number => {
    const bins: number[][] = Array.from({ length: 24 }, () => [])
    for (const p of pts) {
      const r = Math.hypot(p.x, p.y)
      let b = Math.floor(((Math.atan2(p.y, p.x) + Math.PI) / (2 * Math.PI)) * 24)
      if (b >= 24) b = 23
      bins[b]!.push(r)
    }
    const means = bins.map((bin) => bin.reduce((s, r) => s + r, 0) / Math.max(1, bin.length))
    const mean = means.reduce((s, m) => s + m, 0) / means.length
    const variance = means.reduce((s, m) => s + (m - mean) * (m - mean), 0) / means.length
    return Math.sqrt(variance) / Math.max(1e-9, mean)
  }
  const ring = (n: number, radius: number): Array<{ x: number; y: number }> =>
    Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2
      return { x: Math.cos(a) * radius, y: Math.sin(a) * radius }
    })
  for (const seed of [7, 8, 42]) {
    it(`warps a perfect ring into an angularly ragged edge (seed ${seed})`, () => {
      const pts = ring(72, 1000)
      const flat = angularRaggedness(pts)
      const warped = pts.map((p) => {
        const o = blobOffset(p.x, p.y, 0, 0, 1000, seed)
        return { x: p.x + o.dx, y: p.y + o.dy }
      })
      const ragged = angularRaggedness(warped)
      expect(flat).toBeLessThan(1e-12)
      expect(ragged).toBeGreaterThan(0.05)
    })
  }
})
