// Property tests for src/core/style-math.ts: laws, not snapshots.
// Deterministic PRNG (mulberry32); no Math.random, no layout, no renderer.
import { describe, expect, it } from 'vitest'
import {
  bodyAlpha,
  deepPhase,
  densityOf,
  edgeFrequencyTier,
  edgeOpacity,
  type EdgeOpacityInput,
  edgeReveal,
  enterProgress,
  fadePhase,
  fanCoreFrac,
  labelAlphaFor,
  labelMinCore,
  lodDust,
  lodTier,
  plateAlpha,
  scalePhase,
  weakEdgeCeiling,
} from '../src/core/style-math'

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = mulberry32(1337)
const inRange = (lo: number, hi: number): number => lo + rand() * (hi - lo)

// Seam probe: zoom-in and zoom-out branches must meet at ratio 1 with no jump.
// EPS is far below any quantization step (0.02..0.05) on purpose: it catches O(1)
// branch mismatches while documented rounding steps can only straddle with ~1e-9 odds.
const EPS = 1e-9
const SEAM_TOL = 1e-3

describe('style-math — continuity through the overview (ratio 1)', () => {
  it('labelMinCore joins both branches at exactly minCore', () => {
    for (const minCore of [3.5, 6, 9, 14]) {
      expect(labelMinCore(1, minCore)).toBe(Math.max(3.5, minCore))
      expect(Math.abs(labelMinCore(1 - 1e-9, minCore) - labelMinCore(1 + 1e-9, minCore))).toBeLessThan(1e-9)
    }
  })

  it('unquantized stage kernels have no seam at ratio 1', () => {
    for (let i = 0; i < 200; i++) {
      const d = inRange(0, 1)
      const s = inRange(0, 1.5)
      expect(Math.abs(scalePhase(1 - EPS, d) - scalePhase(1 + EPS, d)), `scalePhase ${i}`).toBeLessThan(SEAM_TOL)
      expect(Math.abs(fadePhase(1 - EPS, d) - fadePhase(1 + EPS, d)), `fadePhase ${i}`).toBeLessThan(SEAM_TOL)
      expect(Math.abs(deepPhase(1 - EPS) - deepPhase(1 + EPS)), `deepPhase ${i}`).toBeLessThan(SEAM_TOL)
      expect(Math.abs(edgeReveal(1 - EPS) - edgeReveal(1 + EPS)), `edgeReveal ${i}`).toBeLessThan(SEAM_TOL)
      expect(Math.abs(densityOf(1 - EPS) - densityOf(1 + EPS)), `densityOf ${i}`).toBeLessThan(SEAM_TOL)
      expect(Math.abs(edgeFrequencyTier(s, 1 - EPS) - edgeFrequencyTier(s, 1 + EPS)), `freqTier ${i}`).toBeLessThan(
        SEAM_TOL,
      )
    }
  })

  it('quantized alpha kernels have no seam at ratio 1', () => {
    for (let i = 0; i < 200; i++) {
      const core = inRange(1, 75)
      const minCore = inRange(4, 14)
      const strength = inRange(0, 1.5)
      const d = inRange(0, 1)
      expect(Math.abs(bodyAlpha(core, 1 - EPS, 1 - EPS) - bodyAlpha(core, 1 + EPS, 1 + EPS)), `body ${i}`).toBeLessThan(
        SEAM_TOL,
      )
      expect(Math.abs(lodTier(core, 1 - EPS) - lodTier(core, 1 + EPS)), `tier ${i}`).toBeLessThan(SEAM_TOL)
      expect(Math.abs(lodDust(core, 1 - EPS) - lodDust(core, 1 + EPS)), `dust ${i}`).toBeLessThan(SEAM_TOL)
      expect(
        Math.abs(labelAlphaFor(core, 1 - EPS, minCore) - labelAlphaFor(core, 1 + EPS, minCore)),
        `label ${i}`,
      ).toBeLessThan(SEAM_TOL)
      expect(Math.abs(labelMinCore(1 - EPS, minCore) - labelMinCore(1 + EPS, minCore)), `bar ${i}`).toBeLessThan(
        SEAM_TOL,
      )
      const reach = inRange(0.2, 4)
      const rank = inRange(0, 100)
      const tractRank = inRange(0, 80)
      const bundle = inRange(0, 1)
      const at = (r: number): number =>
        edgeOpacity({
          strength,
          core,
          reach,
          rank,
          tractRank,
          bundle,
          cameraRatio: r,
          lodRatio: r,
          mapDensity: d,
          enterAlpha: 1,
        })
      expect(Math.abs(at(1 - EPS) - at(1 + EPS)), `edge ${i}`).toBeLessThan(SEAM_TOL)
    }
  })
})

describe('style-math — golden overview (edgeOpacity at r >= 1 is untouched)', () => {
  const base: EdgeOpacityInput = {
    strength: 1,
    core: 40,
    reach: 0.5,
    rank: 0,
    tractRank: 0,
    bundle: 0.9,
    cameraRatio: 1,
    lodRatio: 1,
    mapDensity: 0.8,
    enterAlpha: 1,
  }
  it.each([
    ['hub link', base, 0.28218697157886086],
    ['dust fibre', { ...base, strength: 0.05, core: 4, reach: 1.2, rank: 30, tractRank: 50, bundle: 0, cameraRatio: 1.4, lodRatio: 1.6, mapDensity: 0.9 }, 0],
    ['deep zoom-out', { ...base, strength: 0.5, core: 12, reach: 2.5, rank: 3, tractRank: 5, bundle: 0.4, cameraRatio: 2.2, lodRatio: 2.2, mapDensity: 1 }, 0.0053487000000000014],
    ['weak cap', { ...base, strength: 0.1, core: 5, reach: 1, bundle: 0, mapDensity: 0.5 }, 0.015190000000000002],
    ['entrance', { ...base, enterAlpha: 0.4 }, 0.11287478863154435],
    ['zero strength', { ...base, strength: 0, core: 10, reach: 1, rank: 5, tractRank: 20, bundle: 0, cameraRatio: 1.2, lodRatio: 1.2, mapDensity: 0.7 }, 0.066370370370370385],
  ])('%s pins its overview alpha', (_name, input, expected) => {
    expect(edgeOpacity(input)).toBeCloseTo(expected, 12)
  })
})

describe('style-math — plate fades with its caption', () => {
  it('plateAlpha never covers the caption it backs', () => {
    for (let i = 0; i < 500; i++) {
      const textAlpha = inRange(0, 1)
      const enterP = inRange(0, 1)
      const dim = inRange(0, 1)
      // Quiet map: the plate is a fraction of the caption alpha.
      expect(plateAlpha(false, textAlpha, enterP, dim), `flat ${i}`).toBeLessThanOrEqual(textAlpha)
      // Ego state: the plate reads the same entrance number the caption uses.
      expect(plateAlpha(true, textAlpha, enterP, dim), `ego ${i}`).toBe(enterP)
    }
  })
})

describe('style-math — fan growth keeps the size order', () => {
  it('fanCoreFrac is monotone in base and in grow, max/min ratio ordered', () => {
    for (let i = 0; i < 50; i++) {
      const scale = inRange(0.3, 1)
      const grow = inRange(0, 1)
      const bases: number[] = []
      for (let b = 0; b < 20; b++) bases.push(0.05 + (b / 19) * 0.85)
      const fs = bases.map((b) => fanCoreFrac(b, scale, grow))
      for (let b = 1; b < fs.length; b++) {
        expect(fs[b], `base order ${i}/${b}`).toBeGreaterThanOrEqual(fs[b - 1]!)
      }
      // The normalized max/min ratio can only grow with the base: the smallest
      // word stays the smallest, so the fan never flips its hierarchy.
      const b0 = fs[0]!
      for (let b = 1; b < fs.length; b++) {
        expect(fs[b]! / b0, `max/min ratio ${i}/${b}`).toBeGreaterThanOrEqual(fs[b - 1]! / b0)
      }
      const base = inRange(0.05, 0.9)
      let prev = -Infinity
      for (let g = 0; g <= 10; g++) {
        const f = fanCoreFrac(base, scale, g / 10)
        expect(f, `grow order ${i}/${g}`).toBeGreaterThanOrEqual(prev)
        prev = f
      }
      for (const f of fs) {
        expect(f).toBeGreaterThanOrEqual(0)
        expect(f).toBeLessThanOrEqual(0.96)
      }
    }
  })

  it('weakEdgeCeiling stays inside [0.16, 1] and opens with the core', () => {
    let prev = -Infinity
    for (let c = 0; c <= 40; c++) {
      const core = (c / 40) * 80
      const w = weakEdgeCeiling(core)
      expect(w).toBeGreaterThanOrEqual(0.16)
      expect(w).toBeLessThanOrEqual(1)
      expect(w, `ceiling order ${c}`).toBeGreaterThanOrEqual(prev)
      prev = w
    }
  })
})

describe('style-math — extreme inputs stay finite inside [0, 1]', () => {
  it('no NaN, no escape on boundary values', () => {
    const ratios = [0.05, 0.1, 0.45, 1, 1.6, 2.2, 3.4, 5, 8, Infinity]
    const cores = [-10, 0, 1, 3.5, 5, 12, 18, 22, 40, 68, 200]
    const densities = [-1, 0, 0.5, 1, 2]
    const strengths = [-3, 0, 0.05, 0.5, 1, 10]
    const finite01 = (v: number, label: string): void => {
      expect(Number.isFinite(v), `${label} finite`).toBe(true)
      expect(v, `${label} in [0,1]`).toBeGreaterThanOrEqual(0)
      expect(v, `${label} in [0,1]`).toBeLessThanOrEqual(1)
    }
    for (const r of ratios) {
      for (const core of cores) {
        finite01(bodyAlpha(core, r, r), `bodyAlpha(${core},${r})`)
        finite01(labelAlphaFor(core, r, 6), `labelAlphaFor(${core},${r})`)
        finite01(lodTier(core, r), `lodTier(${core},${r})`)
        finite01(lodDust(core, r), `lodDust(${core},${r})`)
        for (const s of strengths) {
          finite01(edgeFrequencyTier(s, r), `freqTier(${s},${r})`)
          for (const reach of [-5, 0, 1, 2.8, 50, Infinity]) {
            for (const rank of [-5, 0, 6, 82, 500]) {
              finite01(
                edgeOpacity({ strength: s, core, reach, rank, tractRank: 20, bundle: 0.3, cameraRatio: r, lodRatio: r, mapDensity: 0.8, enterAlpha: 1 }),
                `edgeOpacity(${s},${core},${r},${reach},${rank})`,
              )
            }
          }
          finite01(
            edgeOpacity({ strength: s, core, reach: 1, rank: 0, tractRank: -5, bundle: -1, cameraRatio: r, lodRatio: 0, mapDensity: -1, enterAlpha: -1 }),
            `edgeOpacityLo(${s},${core},${r})`,
          )
          finite01(
            edgeOpacity({ strength: s, core, reach: 1, rank: 0, tractRank: 500, bundle: 2, cameraRatio: r, lodRatio: r, mapDensity: 2, enterAlpha: 2 }),
            `edgeOpacityHi(${s},${core},${r})`,
          )
        }
      }
      for (const d of densities) {
        finite01(scalePhase(r, d), `scalePhase(${r},${d})`)
        finite01(fadePhase(r, d), `fadePhase(${r},${d})`)
        finite01(deepPhase(r), `deepPhase(${r})`)
        finite01(edgeReveal(r), `edgeReveal(${r})`)
        finite01(densityOf(d), `densityOf(${d})`)
      }
      const bar = labelMinCore(r, 6)
      expect(Number.isFinite(bar), `labelMinCore(${r}) finite`).toBe(true)
      expect(bar).toBeGreaterThanOrEqual(3.5)
    }
    for (const e of [-1, 0, 0.4, 1, 2]) {
      for (const p of [-1, 0, 0.5, 1, 2]) finite01(enterProgress(p, e), `enterProgress(${p},${e})`)
      for (const t of [-2, 0, 0.5, 1, 2]) {
        for (const d of [0, 0.55, 1]) finite01(plateAlpha(false, t, e, d), `plate(${t},${e},${d})`)
        finite01(plateAlpha(true, t, e, 0.5), `plateEgo(${t},${e})`)
      }
    }
    for (const s of [0.05, 0.3, 0.5, 1]) {
      for (const g of [-1, 0, 0.5, 1, 2]) {
        // base is a drawn-core share (coreFrac): the contract domain is [0, 1].
        for (const b of [0, 0.05, 0.2, 0.48, 0.87, 0.96, 1]) {
          const f = fanCoreFrac(b, s, g)
          expect(Number.isFinite(f), `fan(${b},${s},${g}) finite`).toBe(true)
          expect(f).toBeGreaterThanOrEqual(0)
          expect(f).toBeLessThanOrEqual(1)
        }
      }
    }
  })
})

describe('style-math — zoom-in floor and hub screen-radius law (R2 pins)', () => {
  // The rank floor must hold a heavily suppressed fibre above zero on zoom-in:
  // deleting the floor (or the isolated/quiet gates) zeroes this link.
  const zoomed = (rank: number): number =>
    edgeOpacity({
      strength: 0.1,
      core: 5,
      reach: 1,
      rank,
      tractRank: 0,
      bundle: 0,
      cameraRatio: 0.4,
      lodRatio: 0.4,
      mapDensity: 0.8,
      enterAlpha: 1,
    })
  it('suppressed fibre stays visible via the rank floor, rank order kept', () => {
    const suppressed = zoomed(100)
    const plain = zoomed(0)
    expect(suppressed).toBeGreaterThan(0.05)
    expect(plain).toBeGreaterThan(suppressed)
  })
  // Hub captions answer to screen body radius, never to the zoom ratio: a small
  // hub keeps its caption deep inside, a huge disc loses it. Ratio gate removed.
  it('hub caption follows screen radius, not ratio', () => {
    expect(labelAlphaFor(23, 0.25, 6)).toBe(1)
    expect(labelAlphaFor(30, 0.6, 6)).toBe(1)
    expect(labelAlphaFor(68, 0.25, 6)).toBe(0)
  })
})
