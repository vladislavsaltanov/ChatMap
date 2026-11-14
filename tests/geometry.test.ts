import { describe, expect, it } from 'vitest'
import {
  armsFromIndex,
  buildArmsIndex,
  bundleEdges,
  coreFrac,
  edgeAlpha,
  edgeColor,
  edgeWidth,
  egoNodeScale,
  fanCoreFrac,
  fisheyePoint,
  focusYield,
  footprintScale,
  footprintSize,
  GATEWAY_CELLS,
  haloPx,
  labelZoomRatio,
  lengthFade,
  LOD_GONE_PX,
  LOD_PRESENT_PX,
  lodPresence,
  nodeFitSize,
  phaseFor,
  quadOf,
  renderedNodeSize,
  smallness,
  visualCoreRadius,
  weakEdgeCeiling,
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

describe('bundleEdges (corridors through the figure)', () => {
  // Two topics on a line, plus one far topic: every cross-topic link shares the
  // same corridor, which is the property the mercury look rests on.
  const points = [
    { id: 1, x: -100, y: 0 },
    { id: 2, x: -90, y: 10 },
    { id: 3, x: 100, y: 0 },
    { id: 4, x: 110, y: -10 },
    { id: 5, x: 0, y: 200 },
  ]
  const ports = new Map([
    [10, { x: -60, y: 0 }],
    [20, { x: 60, y: 0 }],
    [30, { x: 0, y: 220 }],
  ])
  const groupOf = new Map([
    [1, 10],
    [2, 10],
    [3, 20],
    [4, 20],
    [5, 30],
  ])
  const routes = { ports, groupOf }
  const edges = [
    { a: 1, b: 3, weight: 9 },
    { a: 2, b: 4, weight: 5 },
    { a: 1, b: 4, weight: 3 },
  ]
  const straight: [number, number, number, number] = [1 / 3, 0, 2 / 3, 0]

  // Fascicle trunk fixture: one soma port at the origin, stem 161 along +x (two
  // words) and stem 162 along +y. Only `stemOf` makes these a trunk.
  const trunkHub = { x: 0, y: 0 }
  const trunkPoints = [
    { id: 0, x: 0, y: 0 },
    { id: 1, x: 100, y: 0 },
    { id: 2, x: 90, y: 20 },
    { id: 3, x: 0, y: 90 },
  ]
  const trunkPorts = new Map([[10, trunkHub]])
  const trunkGroupOf = new Map([
    [0, 10],
    [1, 10],
    [2, 10],
    [3, 10],
  ])
  const trunkStems = new Map([
    [0, 160],
    [1, 161],
    [2, 161],
    [3, 162],
  ])
  const trunkRoutes = { ports: trunkPorts, groupOf: trunkGroupOf, stemOf: trunkStems }

  // Contract trunk of one fascicle: direction = radius-weighted mean arm, maxR = the
  // farthest word of the stem. Mirrors §2.1/§Step 6 so the numbers are pinned.
  const spineOf = (nodes: Array<{ x: number; y: number }>, hub: { x: number; y: number }) => {
    let sx = 0
    let sy = 0
    let maxR = 0
    for (const p of nodes) {
      const dx = p.x - hub.x
      const dy = p.y - hub.y
      const r = Math.hypot(dx, dy)
      const w = Math.pow(r, 0.2)
      sx += dx * w
      sy += dy * w
      maxR = Math.max(maxR, r)
    }
    const len = Math.hypot(sx, sy)
    return { dx: sx / len, dy: sy / len, maxR }
  }

  // Absolute control points from the dimensionless tract coefficients, using the
  // same (delta, perp) basis as the shader.
  const controls = (
    tract: number[],
    a: { x: number; y: number },
    b: { x: number; y: number },
  ) => {
    const dx = b.x - a.x
    const dy = b.y - a.y
    return {
      c1: { x: a.x + dx * tract[0] - dy * tract[1], y: a.y + dy * tract[0] + dx * tract[1] },
      c2: { x: a.x + dx * tract[2] - dy * tract[3], y: a.y + dy * tract[2] + dx * tract[3] },
    }
  }

  it('is deterministic and ranks edges by weight', () => {
    const a = bundleEdges(points, edges, 9, routes)
    expect(a).toEqual(bundleEdges(points, edges, 9, routes))
    expect(a.map((info) => info.rank)).toEqual([0, 1, 2])
    expect(a[0].tract).toHaveLength(4)
  })

  it('puts every word of one topic pair on the same corridor', () => {
    const info = bundleEdges(points, edges, 9, routes)
    const first = controls(info[0].tract, points[0], points[2]).c1
    const second = controls(info[2].tract, points[0], points[3]).c1
    // The corridor fan is the only difference: at most 2 * CORRIDOR_FAN world units.
    expect(Math.hypot(first.x - second.x, first.y - second.y)).toBeLessThanOrEqual(12)
    expect(info[0].bundle).toBeGreaterThan(0)
    expect(info[0].tractRank).toBe(0)
  })

  it('routes a cross-topic fibre through both gateway controls', () => {
    const info = bundleEdges(points, edges, 9, routes)[0]
    const { c1, c2 } = controls(info.tract, points[0], points[2])
    // Controls snap to a grid of GATEWAY_CELLS across the figure: ports inside one
    // cell share a control, which is what turns neighbouring corridors into one trunk.
    const extent = 210 // x: -100..110, y: -10..200 in the fixture
    const cell = extent / GATEWAY_CELLS
    const snap = (p: { x: number; y: number }) => ({
      x: (Math.floor(p.x / cell) + 0.5) * cell,
      y: (Math.floor(p.y / cell) + 0.5) * cell,
    })
    const g1 = snap({ x: -60, y: 0 })
    const g2 = snap({ x: 60, y: 0 })
    expect(Math.hypot(c1.x - g1.x, c1.y - g1.y)).toBeLessThanOrEqual(2.5)
    expect(Math.hypot(c2.x - g2.x, c2.y - g2.y)).toBeLessThanOrEqual(2.5)
  })

  it('merges neighbouring nuclei into one trunk control', () => {
    // A second topic mashed 2 units from topic A's soma: same gateway cell, so the
    // first control of its links must be byte-identical to topic A's links.
    const near = { ports: new Map([...ports, [40, { x: -59, y: 2 }]]), groupOf: new Map([...groupOf, [6, 40]]) }
    const withNear = [...points, { id: 6, x: -30, y: 40 }]
    const a = bundleEdges(withNear, [{ a: 1, b: 3, weight: 9 }], 9, near)[0]
    const b = bundleEdges(withNear, [{ a: 6, b: 3, weight: 9 }], 9, near)[0]
    const first = controls(a.tract, withNear[0], withNear[2]).c1
    const second = controls(b.tract, withNear[5], withNear[2]).c1
    expect(first).toEqual(second)
  })

  it('bows a same-topic link through its own soma', () => {
    const info = bundleEdges(points, [{ a: 1, b: 2, weight: 4 }], 4, routes)[0]
    const { c1, c2 } = controls(info.tract, points[0], points[1])
    const soma = { x: -60, y: 0 }
    const a = points[0]
    const b = points[1]
    // The near control sits 75% of the way to the soma (audit #7: ports are
    // loose landmarks now, a full pull overshoots into loops on short edges),
    // the far one 25% of the way from the word — a dendrite, not a chord.
    const aToSoma = Math.hypot(a.x - soma.x, a.y - soma.y)
    expect(Math.abs(Math.hypot(c1.x - soma.x, c1.y - soma.y) - 0.25 * aToSoma)).toBeLessThanOrEqual(2.5)
    const toSoma = Math.hypot(c2.x - soma.x, c2.y - soma.y)
    const bToSoma = Math.hypot(b.x - soma.x, b.y - soma.y)
    expect(toSoma).toBeLessThan(bToSoma)
    expect(toSoma).toBeGreaterThan(bToSoma * 0.5)
  })

  it('falls back to a straight tract without routes', () => {
    expect(bundleEdges(points, [{ a: 1, b: 2 }])[0].tract).toEqual(straight)
  })

  it('is safe on missing positions and degenerate edges', () => {
    expect(bundleEdges([], [{ a: 1, b: 2 }], 0, routes)[0].tract).toEqual(straight)
    expect(bundleEdges(points, [{ a: 1, b: 1 }], 0, routes)[0].tract).toEqual(straight)
  })

  it('fuses every fibre of one fascicle onto one shared trunk control', () => {
    // Separate calls so each corridor has a single fibre (fan 0): the recovered
    // controls then differ only if the trunk itself differs.
    const one = bundleEdges(trunkPoints, [{ a: 0, b: 1, weight: 9 }], 9, trunkRoutes)[0]
    const two = bundleEdges(trunkPoints, [{ a: 0, b: 2, weight: 9 }], 9, trunkRoutes)[0]
    const first = controls(one.tract, trunkPoints[0], trunkPoints[1]).c1
    const second = controls(two.tract, trunkPoints[0], trunkPoints[2]).c1
    // One control for the whole fascicle: that shared point is the bundle.
    expect(Math.hypot(first.x - second.x, first.y - second.y)).toBeLessThan(1e-6)
    const spine = spineOf([trunkPoints[1], trunkPoints[2]], trunkHub)
    expect(first.x).toBeCloseTo(trunkHub.x + spine.dx * 0.3 * spine.maxR, 6)
    expect(first.y).toBeCloseTo(trunkHub.y + spine.dy * 0.3 * spine.maxR, 6)
  })

  it('splits the trunk near the terminal, not at the hub', () => {
    const info = bundleEdges(trunkPoints, [{ a: 0, b: 1, weight: 9 }], 9, trunkRoutes)[0]
    const b = trunkPoints[1]
    const { c2 } = controls(info.tract, trunkPoints[0], b)
    const spine = spineOf([trunkPoints[1], trunkPoints[2]], trunkHub)
    const reach = (b.x - trunkHub.x) * spine.dx + (b.y - trunkHub.y) * spine.dy
    const proj = Math.min(reach, spine.maxR * 1.15)
    const onArm = { x: trunkHub.x + spine.dx * proj, y: trunkHub.y + spine.dy * proj }
    // 86% trunk / 14% terminal: the fibre stays fused almost to the word.
    expect(Math.hypot(c2.x - onArm.x, c2.y - onArm.y)).toBeCloseTo(0.14 * Math.hypot(b.x - onArm.x, b.y - onArm.y), 6)
  })

  it('keeps today\'s routing where there is no spine to ride', () => {
    const plain = { ports: trunkPorts, groupOf: trunkGroupOf }
    const edge = [{ a: 0, b: 1, weight: 5 }]
    // All words within 2 units of the soma: no arm, no bundling.
    const tight = [{ id: 0, x: 0, y: 0 }, { id: 1, x: 1, y: 1 }, { id: 2, x: 1, y: -1 }]
    const tightRoutes = { ports: trunkPorts, groupOf: trunkGroupOf, stemOf: new Map([[0, 160], [1, 161], [2, 161]]) }
    expect(bundleEdges(tight, edge, 5, tightRoutes)[0].tract).toEqual(bundleEdges(tight, edge, 5, plain)[0].tract)
    // Terminal behind the soma: the arm does not reach it, so the intra path wins.
    const behind = [...trunkPoints, { id: 4, x: -40, y: 10 }]
    const behindRoutes = {
      ports: trunkPorts,
      groupOf: new Map([...trunkGroupOf, [4, 10]]),
      stemOf: new Map([...trunkStems, [4, 161]]),
    }
    const backEdge = [{ a: 0, b: 4, weight: 5 }]
    expect(bundleEdges(behind, backEdge, 5, behindRoutes)[0].tract).toEqual(
      bundleEdges(behind, backEdge, 5, { ports: trunkPorts, groupOf: behindRoutes.groupOf })[0].tract,
    )
    // Two different fascicles of one hub are not a trunk.
    const crossEdge = [{ a: 1, b: 3, weight: 5 }]
    expect(bundleEdges(trunkPoints, crossEdge, 5, trunkRoutes)[0].tract).toEqual(
      bundleEdges(trunkPoints, crossEdge, 5, plain)[0].tract,
    )
  })
})

describe('geometry', () => {
  it('computes edgeWidth according to (w / wmax)^0.6', () => {
    expect(edgeWidth(0, 10)).toBe(0)
    expect(edgeWidth(10, 10)).toBe(1)
    expect(edgeWidth(5, 10)).toBeCloseTo(Math.pow(0.5, 0.6))
    expect(edgeWidth(5, 0)).toBe(0)
  })

  it('computes nodeFitSize: power law keeps a wide, strictly monotonic size hierarchy', () => {
    const max = 3000
    const hub = nodeFitSize('договорились', max, max, 1)
    const mid = nodeFitSize('договорились', 100, max, 1)
    const rare = nodeFitSize('договорились', 1, max, 1)

    // Landmark word tops the law and encloses its own text
    expect(hub).toBeCloseTo(68, 1)
    expect(hub * 2).toBeGreaterThanOrEqual(12 * 7 + 8)
    // Rarest word stays a dot, and the contrast is at least an order of magnitude
    expect(rare).toBeLessThan(8)
    expect(hub / rare).toBeGreaterThanOrEqual(10)
    // A word used 100x more often than the rarest is visibly, not marginally, bigger
    expect(mid).toBeGreaterThan(rare * 2)

    // Monotonic in frequency and independent of argument order (min/max normalised)
    expect(nodeFitSize('слово', 50, max, 1)).toBeLessThan(nodeFitSize('слово', 500, max, 1))
    expect(nodeFitSize('слово', 50, 1, max)).toBe(nodeFitSize('слово', 50, max, 1))

    // Guard: missing counts or a uniform distribution fall back to text fit
    expect(nodeFitSize('слово', 0, 10, 1)).toBeGreaterThanOrEqual(26)
    expect(nodeFitSize('слово', 5, 5, 5)).toBeGreaterThanOrEqual(26)
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

  it('footprintScale: shrinks the whole distribution uniformly when the map overshoots the budget', () => {
    // Empty, degenerate and small maps keep the designed radii untouched
    expect(footprintScale([])).toBe(1)
    expect(footprintScale([0, 0])).toBe(1)
    expect(footprintScale([4, 6, 10])).toBe(1)

    const crowded = footprintScale(Array.from({ length: 1000 }, () => 15))
    expect(crowded).toBeGreaterThan(0.28)
    expect(crowded).toBeLessThan(1)
    // Uniform scale keeps the hierarchy: a 3x hub stays 3x the dot
    expect((30 * crowded) / (10 * crowded)).toBeCloseTo(3)
    // The result lands on the budget (within rounding of the square root)
    const squares = crowded * crowded * 1000 * 15 * 15 * Math.PI
    expect(squares).toBeCloseTo(170_000, -2)
  })

  it('footprintSize: scales only the increment, so dust never falls below the LOD floor', () => {
    // Reserved floor (SIZE_MIN = 2.8) is untouched even at the weakest scale
    expect(footprintSize(2.8, 0.28)).toBe(2.8)
    expect(footprintSize(1.2, 0.28)).toBe(1.2)
    // Multiplying the radius would put the dot below the dissolve floor
    expect(2.8 * 0.28).toBeLessThan(LOD_GONE_PX)
    expect(footprintSize(2.8, 0.28)).toBeGreaterThan(LOD_GONE_PX)
    // Above the floor the distribution still compresses uniformly
    expect(footprintSize(68, 0.28)).toBeCloseTo(2.8 + (68 - 2.8) * 0.28)
    expect(footprintSize(30, 1)).toBe(30)
  })

  it('visualCoreRadius: small dots preserved, hubs compressed mildly, always monotonic', () => {    expect(visualCoreRadius(5)).toBe(5)
    expect(visualCoreRadius(9)).toBe(9)
    expect(visualCoreRadius(0)).toBe(0)
    // Hubs keep their hierarchy: 76 layout px must still draw as a landmark
    expect(visualCoreRadius(76)).toBeCloseTo(57.2, 1)
    expect(visualCoreRadius(72)).toBeGreaterThan(45)
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

  it('armsFromIndex: angles to heaviest neighbors by weight, -1 for missing slots', () => {
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
    const index = buildArmsIndex(nodes, edges)
    const arms = armsFromIndex(index, 1)
    expect(arms).toHaveLength(5)
    expect(arms[0]).toBeCloseTo(0)
    expect(arms[1]).toBeCloseTo(0.5)
    expect(arms[2]).toBeCloseTo(0.25)
    expect(arms[3]).toBe(-1)
    expect(arms[4]).toBe(-1)
    expect(armsFromIndex(index, 99)).toEqual([-1, -1, -1, -1, -1])
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

describe('smallness (how far a body is from a landmark)', () => {
  it('is 0 for landmarks and 1 for dust', () => {
    expect(smallness(40)).toBe(0)
    expect(smallness(18)).toBe(0)
    expect(smallness(5)).toBe(1)
    expect(smallness(0)).toBe(1)
  })

  it('decreases monotonically with the core radius', () => {
    let prev = 2
    for (let core = 0; core <= 24; core += 1) {
      const v = smallness(core)
      expect(v).toBeLessThanOrEqual(prev)
      prev = v
    }
  })
})

describe('lodPresence (dust must dissolve, not linger)', () => {
  it('is fully gone at or below the floor and fully present above the ceiling', () => {
    expect(lodPresence(0)).toBe(0)
    expect(lodPresence(LOD_GONE_PX)).toBe(0)
    expect(lodPresence(LOD_PRESENT_PX)).toBe(1)
    expect(lodPresence(80)).toBe(1)
  })

  it('rises monotonically between the bounds while zooming in', () => {
    // A body being approached must BRIGHTEN; a dip here is a visible pop.
    let prev = -1
    for (let px = LOD_GONE_PX; px <= LOD_PRESENT_PX + 1e-6; px += 0.05) {
      const v = lodPresence(px)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('never escapes [0, 1], even for hostile input', () => {
    expect(lodPresence(-5)).toBe(0)
    expect(lodPresence(Number.NaN)).toBe(0)
    expect(lodPresence(Number.POSITIVE_INFINITY)).toBe(1)
  })
})

describe('weakEdgeCeiling (a link to a rare word stays weak)', () => {
  it('leaves corridors between large words untouched', () => {
    expect(weakEdgeCeiling(30)).toBe(1)
    expect(weakEdgeCeiling(18)).toBe(1)
  })

  it('holds links whose weak end is dust far below a corridor', () => {
    // Re-derived in round 27 (neurone refs, explicit user directive): dust fibres
    // must READ as fibres (cap 0.38), still far below a hub corridor (1.0).
    expect(weakEdgeCeiling(3)).toBeLessThanOrEqual(0.4)
    expect(weakEdgeCeiling(5)).toBeLessThan(weakEdgeCeiling(12))
  })

  it('never returns 0 or a value above 1: the ceiling only dims', () => {
    expect(weakEdgeCeiling(0)).toBeGreaterThan(0)
    expect(weakEdgeCeiling(60)).toBe(1)
  })
})

describe('egoNodeScale (the focused body grows, it does not pop)', () => {
  it('is the resting size before any boost arrives', () => {
    expect(egoNodeScale(0, 0)).toBe(1)
  })

  it('hover tops out at +12% and pin adds its 30% lift on top of that', () => {
    expect(egoNodeScale(1, 0)).toBeCloseTo(1.12, 6)
    expect(egoNodeScale(1, 1)).toBeCloseTo(1.12 * 1.3, 6)
  })

  it('keeps the pin lift while the hover ramp is still travelling', () => {
    expect(egoNodeScale(0, 1)).toBeCloseTo(1.3, 6)
    expect(egoNodeScale(0.5, 1)).toBeGreaterThan(egoNodeScale(0.5, 0))
  })

  it('rises monotonically with the ramp and clamps out-of-range input', () => {
    expect(egoNodeScale(0.25, 0)).toBeGreaterThan(1)
    expect(egoNodeScale(0.25, 0)).toBeLessThan(egoNodeScale(0.75, 0))
    expect(egoNodeScale(-1, 0)).toBe(1)
    expect(egoNodeScale(2, 2)).toBeCloseTo(1.12 * 1.3, 6)
  })
})

describe('fanCoreFrac (the fan body grows inside its own quad)', () => {
  it('draws the resting body while no focus ramp has arrived', () => {
    expect(fanCoreFrac(0.55, 0.6, 0)).toBeCloseTo(0.55, 6)
    expect(fanCoreFrac(0.75, 1, 0)).toBeCloseTo(0.75, 6)
  })

  it('restores the full-size body by dividing out the LOD shrink', () => {
    // Quad is drawn at 75% on the overview, so the same body needs a bigger share.
    expect(fanCoreFrac(0.6, 0.75, 1)).toBeCloseTo(0.8, 6)
  })

  it('never asks the shader to paint outside the quad', () => {
    expect(fanCoreFrac(0.57, 0.5, 1)).toBeCloseTo(0.96, 6)
    expect(fanCoreFrac(0.6, 0, 1)).toBe(0.96)
  })

  it('leaves a body that is already at full share untouched', () => {
    expect(fanCoreFrac(0.75, 1, 1)).toBeCloseTo(0.75, 6)
    expect(fanCoreFrac(0.96, 0.4, 1)).toBeCloseTo(0.96, 6)
  })

  it('rises monotonically with the ramp and clamps bad input', () => {
    expect(fanCoreFrac(0.6, 0.75, 0.5)).toBeGreaterThan(0.6)
    expect(fanCoreFrac(0.6, 0.75, 0.5)).toBeLessThan(fanCoreFrac(0.6, 0.75, 0.9))
    expect(fanCoreFrac(0.6, 0.75, -2)).toBeCloseTo(0.6, 6)
    expect(fanCoreFrac(0.6, 0.75, 5)).toBeCloseTo(0.8, 6)
  })
})

describe('focusYield (the crowd hands the paper to the selected word)', () => {
  it('touches nothing while no focus is active', () => {
    expect(focusYield(0, 10, 5, 0)).toBe(1)
    expect(focusYield(3, 10, 5, 0)).toBe(1)
  })

  it('takes a touching body down to a ghost when the focus is settled', () => {
    expect(focusYield(0, 10, 5, 1)).toBeCloseTo(0.2, 6)
    expect(focusYield(10, 10, 5, 1)).toBeCloseTo(0.2, 6)
  })

  it('releases the body once its own disc no longer reaches the focus', () => {
    expect(focusYield(15, 10, 5, 1)).toBeCloseTo(1, 6)
    expect(focusYield(60, 10, 5, 1)).toBe(1)
  })

  it('follows the dim tween in both directions', () => {
    expect(focusYield(0, 10, 5, 0.5)).toBeCloseTo(0.6, 6)
    expect(focusYield(4, 10, 5, 0.25)).toBeGreaterThan(focusYield(4, 10, 5, 0.75))
  })

  it('falls monotonically with distance and never leaves the floor', () => {
    const far = focusYield(14, 10, 5, 1)
    const near = focusYield(11, 10, 5, 1)
    const inside = focusYield(8, 10, 5, 1)
    expect(far).toBeGreaterThan(near)
    expect(near).toBeGreaterThan(inside)
    expect(inside).toBeGreaterThanOrEqual(0.2)
    expect(focusYield(-5, 10, 5, 1)).toBeCloseTo(0.2, 6)
  })

  it('degenerates to a hard edge when the body has no radius', () => {
    expect(focusYield(9, 10, 0, 1)).toBeCloseTo(0.2, 6)
    expect(focusYield(11, 10, 0, 1)).toBe(1)
  })
})
