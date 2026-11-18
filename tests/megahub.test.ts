import { beforeAll, describe, expect, it } from 'vitest'
import { canon } from '../src/core/canon'
import { bundleEdges, footprintScale, footprintSize, nodeFitSize } from '../src/core/geometry'
import { layout, type LayoutNodeInput, type LayoutResult } from '../src/core/graph'
import { Intern } from '../src/core/intern'
import { parse } from '../src/core/parse'
import { pruneSortedBackbone, select, type Selection, type SelectionEdge } from '../src/core/select'
import { buildUnits, dropFor, tally, type TallyResult } from '../src/core/tally'
import { buildMegaHubChat, HUB_WORDS, MEGA_DEFAULTS } from './fixtures/megahub-chat.mjs'

// Stand for the failure shape the synthetic chats never produced: one word in
// most messages, so ~85% of the words hang off it (specs/2026-11-14-audit-
// open-questions.md Q8). The graph is built by the REAL pipeline
// (parse -> tokenize -> tally -> select -> backbone), never by hand.
//
// Two deliverables live here:
//   1) the generator's own contract: hub reach >= 80% and degree >= 300 at p=0.85,
//      plus a monotone p sweep {0.3, 0.6, 0.85};
//   2) the measured MAX_GROUP_SHARE -> hashAt -> trunkControls chain, printed as
//      JSON. It documents the current behaviour; the constants are NOT fixed here.

const FILTERS = {
  mat: false,
  laugh: false,
  tech: false,
  digits: false,
  stopwords: false,
  customMat: [],
  customLaugh: [],
  smartMerge: false,
}

const TALLY_FILTERS = dropFor(FILTERS)

type MegaGraph = {
  ia: Intern
  tallyResult: TallyResult
  selection: Selection
  backbone: SelectionEdge[]
  // Node with the largest degree in the SELECTION (the mega-hub).
  hub: number
  degrees: Map<number, number>
  backboneDegrees: Map<number, number>
}

const canonOf = (ia: Intern, id: number): string => ia.getCanon(id) ?? String(id)

const degreeMap = (edges: Array<{ a: number; b: number }>): Map<number, number> => {
  const out = new Map<number, number>()
  for (const e of edges) {
    out.set(e.a, (out.get(e.a) ?? 0) + 1)
    out.set(e.b, (out.get(e.b) ?? 0) + 1)
  }
  return out
}

const selectAt = (ia: Intern, tallyResult: TallyResult, topN: number): MegaGraph => {
  const selection = select(tallyResult, { mode: { kind: 'together' }, topN, minWeight: 0 })
  const backbone = pruneSortedBackbone(selection.edges, selection.nodes.length)
  const degrees = degreeMap(selection.edges)
  const backboneDegrees = degreeMap(backbone)
  const hub = [...degrees.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0]
  return { ia, tallyResult, selection, backbone, hub, degrees, backboneDegrees }
}

const buildMegaGraph = (
  hubShare: number,
  opts: { topN: number; messages?: number; vocab?: number },
): MegaGraph => {
  const chat = parse(
    JSON.stringify(
      buildMegaHubChat({
        hubShare,
        messages: opts.messages ?? MEGA_DEFAULTS.messages,
        vocab: opts.vocab ?? MEGA_DEFAULTS.vocab,
      }),
    ),
  )
  const ia = new Intern()
  const tallyResult = tally(buildUnits(chat, ia, TALLY_FILTERS))
  return selectAt(ia, tallyResult, opts.topN)
}

// Mirrors worker.buildLayoutInput's size law so the stand measures the shipped
// spacing, not a hand-made one.
const layoutInputs = (ia: Intern, selection: Selection): LayoutNodeInput[] => {
  let minCount = Infinity
  for (const n of selection.nodes) minCount = Math.min(minCount, n.count)
  const inputs = selection.nodes.map((n) => ({
    id: n.id,
    size: nodeFitSize(canonOf(ia, n.id), n.count, selection.maxCount, minCount),
  }))
  const scale = footprintScale(inputs.map((i) => i.size))
  if (scale < 1) {
    for (const input of inputs) input.size = Math.round(footprintSize(input.size, scale) * 10) / 10
  }
  return inputs
}

const runLayout = (graph: MegaGraph): { result: LayoutResult; inputs: LayoutNodeInput[]; ms: number } => {
  const inputs = layoutInputs(graph.ia, graph.selection)
  const t0 = performance.now()
  const result = layout(inputs, graph.backbone, { seed: 1337, fullRun: true })
  const ms = performance.now() - t0
  return { result, inputs, ms }
}

// hubReach = share of the map's words the top word is linked to, the reader's
// version of "85% слов на одном слове" (NOT the share of all edges: a message
// also links its own words, so E is much larger than the hub's degree).
const hubStats = (graph: MegaGraph) => {
  const hubDegree = graph.degrees.get(graph.hub) ?? 0
  return {
    hub: canonOf(graph.ia, graph.hub),
    hubDegree,
    hubReach: +(hubDegree / Math.max(1, graph.selection.nodes.length - 1)).toFixed(3),
    hubEdgeShare: +(hubDegree / Math.max(1, 2 * graph.selection.edges.length)).toFixed(3),
    backboneDegree: graph.backboneDegrees.get(graph.hub) ?? 0,
    nodes: graph.selection.nodes.length,
    edges: graph.selection.edges.length,
    backboneEdges: graph.backbone.length,
  }
}

// The chain in src/core: spread.detectGroups caps a label bucket at
// MAX_GROUP_SHARE and partitions it, but mergeToTarget then merges the pieces
// back; leaf.softInit grants a stem only to nodes whose nearest landmark is
// clearly closer than the second one (STEM_MARGIN), and its hashAt spillover
// (leaf.ts:259) only ever runs for OWNED nodes; geometry's trunkControls
// (geometry.ts:343) needs a stem on both ends. This probe reports each link of
// that chain separately, so the report can say where bundling dies.
type ChainReport = {
  nodes: number
  backboneEdges: number
  hub: string
  hubDegree: number
  hubReach: number
  groups: number
  // Mass share of the largest port: MAX_GROUP_SHARE is 0.3, so anything above
  // it means the cap did not survive mergeToTarget.
  groupMassShare: number
  stemCover: number
  hubLeavesWithoutStem: number
  hubLeavesOtherOwner: number
  hubLeavesSameOwner: number
  trunkEligible: number
  // Hub edges whose leaf sits in the hub's own group: they take the intra-nucleus
  // dendrite branch (one pull toward the hub port per edge).
  hubEdgesIntraGroup: number
  // One distinct cubic <near|far> control pair per hub edge = one curve per leaf.
  distinctRoutes: number
  ms: number
}

const chainReport = (graph: MegaGraph, run: { result: LayoutResult; inputs: LayoutNodeInput[]; ms: number }): ChainReport => {
  const { result, inputs, ms } = run
  const stemOf = result.stemOf ?? new Map<number, number>()
  const groupOf = result.groupOf ?? new Map<number, number>()
  const ports =
    result.ports ?? new Map<number, { x: number; y: number; mass: number; members: number }>()
  const hub = graph.hub
  const hubEdges = graph.backbone.filter((e) => e.a === hub || e.b === hub)
  const leafOf = (e: SelectionEdge): number => (e.a === hub ? e.b : e.a)
  const ownerOfStem = (id: number): number => {
    const stem = stemOf.get(id)
    // A node without a stem has no fascicle at all (spread maps it to -1).
    return stem === undefined || stem < 0 ? -1 : Math.floor(stem / 16)
  }
  const slotOfStem = (id: number): number => {
    const stem = stemOf.get(id)
    return stem === undefined || stem < 0 ? -1 : stem % 16
  }
  let withoutStem = 0
  let otherOwner = 0
  let sameOwner = 0
  let trunkEligible = 0
  const hubOwner = ownerOfStem(hub)
  const hubSlot = slotOfStem(hub)
  for (const e of hubEdges) {
    const leafStem = stemOf.get(leafOf(e))
    if (leafStem === undefined || leafStem < 0) {
      withoutStem++
      continue
    }
    if (ownerOfStem(leafOf(e)) !== hubOwner) {
      otherOwner++
      continue
    }
    sameOwner++
    const leafSlot = slotOfStem(leafOf(e))
    // trunkControls §2.1: same owner and (same slot OR one end is the soma).
    if (hubSlot === 0 || leafSlot === 0 || leafSlot === hubSlot) trunkEligible++
  }

  const points = inputs.map((n) => ({ id: n.id, ...result.positions.get(n.id)! }))
  const byId = new Map(points.map((p) => [p.id, p]))
  const bundles = bundleEdges(points, graph.backbone, graph.selection.maxWeight, {
    ports,
    groupOf,
    stemOf,
  })
  const hubIndexes = graph.backbone
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.a === hub || e.b === hub)
  // Cubic control points in world coordinates, same (delta, perp) basis the
  // renderer uses: c1 is the near control (where a bundle would fuse), c2 the
  // terminal-side split.
  const controlsOf = (tract: number[], a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = b.x - a.x
    const dy = b.y - a.y
    return {
      x: a.x + dx * tract[0]! - dy * tract[1]!,
      y: a.y + dy * tract[0]! + dx * tract[1]!,
      rx: a.x + dx * tract[2]! - dy * tract[3]!,
      ry: a.y + dy * tract[2]! + dx * tract[3]!,
    }
  }
  const routes = new Set<string>()
  let intraGroup = 0
  const hubGroup = groupOf.get(hub)
  for (const { e, i } of hubIndexes) {
    if (groupOf.get(leafOf(e)) === hubGroup) intraGroup++
    const a = byId.get(e.a)!
    const b = byId.get(e.b)!
    const c = controlsOf(bundles[i]!.tract, a, b)
    routes.add(`${c.x.toFixed(1)}:${c.y.toFixed(1)}|${c.rx.toFixed(1)}:${c.ry.toFixed(1)}`)
  }
  const masses = [...ports.values()].map((p) => p.mass).sort((a, b) => b - a)
  const totalMass = masses.reduce((a, b) => a + b, 0)
  return {
    nodes: inputs.length,
    backboneEdges: graph.backbone.length,
    hub: canonOf(graph.ia, hub),
    hubDegree: hubEdges.length,
    hubReach: +(hubEdges.length / Math.max(1, inputs.length - 1)).toFixed(3),
    groups: masses.length,
    groupMassShare: masses.length > 0 ? +(masses[0]! / Math.max(1, totalMass)).toFixed(3) : 0,
    stemCover: +([...inputs].filter((n) => (stemOf.get(n.id) ?? -1) >= 0).length / Math.max(1, inputs.length)).toFixed(3),
    hubLeavesWithoutStem: withoutStem,
    hubLeavesOtherOwner: otherOwner,
    hubLeavesSameOwner: sameOwner,
    trunkEligible,
    hubEdgesIntraGroup: intraGroup,
    distinctRoutes: routes.size,
    ms: +ms.toFixed(0),
  }
}

describe('megahub stand', () => {
  it('generator: p=0.85 puts >=80% of the words on the top-1 word (degree >= 300)', () => {
    const graph = buildMegaGraph(MEGA_DEFAULTS.hubShare, { topN: MEGA_DEFAULTS.vocab })
    const stats = hubStats(graph)
    console.log(`megahub p=0.85 ${JSON.stringify(stats)}`)
    expect(stats.hub).toBe(canon(HUB_WORDS[0]!, 'plain'))
    expect(stats.hubReach).toBeGreaterThanOrEqual(0.8)
    expect(stats.hubDegree).toBeGreaterThanOrEqual(300)
  }, 120_000)

  it('generator: p sweep 0.3 / 0.6 / 0.85 moves the hub monotonically', () => {
    const runs = [0.3, 0.6, 0.85].map((p) => ({
      p,
      ...hubStats(buildMegaGraph(p, { topN: MEGA_DEFAULTS.vocab })),
    }))
    for (const run of runs) console.log(`megahub p=${run.p} ${JSON.stringify(run)}`)
    expect(runs[1]!.hubReach).toBeGreaterThan(runs[0]!.hubReach)
    expect(runs[2]!.hubReach).toBeGreaterThan(runs[1]!.hubReach)
    expect(runs[1]!.hubDegree).toBeGreaterThan(runs[0]!.hubDegree)
    expect(runs[2]!.hubDegree).toBeGreaterThan(runs[1]!.hubDegree)
  }, 120_000)

  describe('MAX_GROUP_SHARE -> hashAt -> trunkControls on the real 1000/2000 layouts', () => {
    // One 2600-word chat, two selections: the UI's 1000-node cap and the 2000-node
    // perf case. Same tally, two layouts.
    let graph1000: MegaGraph
    let graph2000: MegaGraph
    let run1000: ReturnType<typeof runLayout>
    let run2000: ReturnType<typeof runLayout>

    beforeAll(() => {
      graph2000 = buildMegaGraph(0.85, { topN: 2000, messages: 9000, vocab: 2600 })
      graph1000 = selectAt(graph2000.ia, graph2000.tallyResult, 1000)
      run1000 = runLayout(graph1000)
      run2000 = runLayout(graph2000)
    }, 300_000)

    it('documents where trunk bundling dies on the mega-hub', () => {
      const report1000 = chainReport(graph1000, run1000)
      const report2000 = chainReport(graph2000, run2000)
      console.log(`chain 1000 ${JSON.stringify(report1000)}`)
      console.log(`chain 2000 ${JSON.stringify(report2000)}`)
      // Structural facts the report stands on: the dominant nucleus is far above
      // the 30% cap, stems exist only on landmarks, and therefore not a single hub
      // edge is trunk-eligible.
      expect(report1000.groups).toBeGreaterThanOrEqual(3)
      expect(report1000.groupMassShare).toBeGreaterThan(0.3)
      expect(report1000.stemCover).toBeLessThan(0.05)
      expect(report1000.hubLeavesWithoutStem).toBeGreaterThan(report1000.hubDegree * 0.95)
      expect(report1000.trunkEligible).toBe(0)
      expect(report2000.trunkEligible).toBe(0)
      // No shared trunk: every hub edge keeps its own cubic route.
      expect(report1000.distinctRoutes).toBe(report1000.hubDegree)
    })

    it('perf: layout of 2000 nodes, with the S9 1000-node context (gate stays at 1000)', () => {
      console.log(`layout ms: 1000=${run1000.ms.toFixed(0)} 2000=${run2000.ms.toFixed(0)}`)
      expect(run1000.result.iterationsDone).toBeGreaterThan(0)
      expect(run2000.result.iterationsDone).toBeGreaterThan(0)
      // select() drops words left linkless (515 true isolates in this synth):
      // the layout covers exactly the connected selection, no pocket sheet.
      expect(graph2000.selection.nodes.length).toBeLessThan(2000)
      expect(run2000.result.positions.size).toBe(graph2000.selection.nodes.length)
      expect(Number.isFinite(run2000.ms)).toBe(true)
    })
  })
})
