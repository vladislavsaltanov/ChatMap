import { describe, expect, it } from 'vitest'
import { pruneBackbone, select, type SelectionEdge } from '../src/core/select'
import { edgeKey, type TallyResult } from '../src/core/tally'

describe('select', () => {
  it('(a) computes weights and counts for together, author X, and cross modes', () => {
    // Mini graph with 2 nodes (1 and 2)
    // counts: node 1 (X0: 3, X1: 2), node 2 (X0: 3, X1: 2)
    // edge: nX[0]=3, nX[1]=2, nCross=4
    const key = edgeKey(1, 2)
    const tallyData: TallyResult = {
      counts: new Map([
        [1, new Map([[100, 3], [101, 2]])],
        [2, new Map([[100, 3], [101, 2]])],
      ]),
      pairs: new Map([
        [key, { nX: new Map([[100, 3], [101, 2]]), nCross: 4 }],
      ]),
    }

    // Together mode
    const selTogether = select(tallyData, { mode: { kind: 'together' }, topN: 10, minWeight: 0 })
    expect(selTogether.nodes[0].count).toBe(5)
    expect(selTogether.edges[0].weight).toBe(9) // 3 + 2 + 4

    // Author X0 mode
    const selAuthor = select(tallyData, { mode: { kind: 'author', author: 100 }, topN: 10, minWeight: 0 })
    expect(selAuthor.nodes[0].count).toBe(3)
    expect(selAuthor.edges[0].weight).toBe(3)

    // Cross mode
    const selCross = select(tallyData, { mode: { kind: 'cross' }, topN: 10, minWeight: 0 })
    expect(selCross.nodes[0].count).toBe(5) // sum of nX
    expect(selCross.edges[0].weight).toBe(4) // nCross
  })

  it('(b) drops edges below minWeight threshold', () => {
    const key = edgeKey(1, 2)
    const tallyData: TallyResult = {
      counts: new Map([
        [1, new Map([[100, 10]])],
        [2, new Map([[100, 10]])],
      ]),
      pairs: new Map([
        [key, { nX: new Map([[100, 3]]), nCross: 0 }],
      ]),
    }
    const sel = select(tallyData, { mode: { kind: 'together' }, topN: 10, minWeight: 5 })
    expect(sel.edges.length).toBe(0)
  })

  it('(c) selects top-N nodes by count desc, breaking ties by id asc', () => {
    const tallyData: TallyResult = {
      counts: new Map([
        [3, new Map([[100, 10]])],
        [1, new Map([[100, 10]])],
        [2, new Map([[100, 20]])],
      ]),
      pairs: new Map(),
    }
    const sel = select(tallyData, { mode: { kind: 'together' }, topN: 2, minWeight: 0 })
    expect(sel.nodes).toEqual([
      { id: 2, count: 20 },
      { id: 1, count: 10 },
    ])
  })

  it('(d) caps visible edges at 10 000 max', () => {
    const counts = new Map<number, Map<number, number>>()
    // Create 10 050 nodes and edges in a chain
    const pairs = new Map()
    for (let i = 1; i <= 10051; i++) {
      counts.set(i, new Map([[100, 1]]))
      if (i > 1) {
        const k = edgeKey(i - 1, i)
        pairs.set(k, { nX: new Map([[100, 1]]), nCross: 0 })
      }
    }
    const tallyData: TallyResult = { counts, pairs }
    const sel = select(tallyData, { mode: { kind: 'together' }, topN: 20000, minWeight: 0 })
    expect(sel.edges.length).toBe(10000)
  })

  it('(e) drops edges pointing to unselected nodes', () => {
    const tallyData: TallyResult = {
      counts: new Map([
        [1, new Map([[100, 50]])],
        [2, new Map([[100, 40]])],
        [3, new Map([[100, 10]])],
      ]),
      pairs: new Map([
        [edgeKey(1, 2), { nX: new Map([[100, 5]]), nCross: 0 }],
        [edgeKey(2, 3), { nX: new Map([[100, 5]]), nCross: 0 }],
      ]),
    }
    // topN = 2 selects nodes 1 and 2; node 3 is omitted, so edge (2, 3) must be dropped
    const sel = select(tallyData, { mode: { kind: 'together' }, topN: 2, minWeight: 0 })
    expect(sel.edges.length).toBe(1)
    expect(sel.edges[0]).toEqual({ a: 1, b: 2, weight: 5 })
  })

  it('(f) computes maxCount and maxWeight from visible selected elements after thresholding', () => {
    const tallyData: TallyResult = {
      counts: new Map([
        [1, new Map([[100, 50]])],
        [2, new Map([[100, 20]])],
      ]),
      pairs: new Map([
        [edgeKey(1, 2), { nX: new Map([[100, 8]]), nCross: 0 }],
      ]),
    }
    const sel = select(tallyData, { mode: { kind: 'together' }, topN: 10, minWeight: 5 })
    expect(sel.maxCount).toBe(50)
    expect(sel.maxWeight).toBe(8)

    // With minWeight > 8, maxWeight should be 0
    const selHigh = select(tallyData, { mode: { kind: 'together' }, topN: 10, minWeight: 10 })
    expect(selHigh.edges.length).toBe(0)
    expect(selHigh.maxWeight).toBe(0)
  })

  it('(g) edges (1, 3006) and (2, 5) stay distinct, not merged by key collision', () => {
    const tallyData: TallyResult = {
      counts: new Map([
        [1, new Map([[100, 1]])],
        [2, new Map([[100, 1]])],
        [5, new Map([[100, 1]])],
        [3006, new Map([[100, 1]])],
      ]),
      pairs: new Map([
        [edgeKey(1, 3006), { nX: new Map([[100, 4]]), nCross: 0 }],
        [edgeKey(2, 5), { nX: new Map([[100, 7]]), nCross: 0 }],
      ]),
    }
    const sel = select(tallyData, { mode: { kind: 'together' }, topN: 10, minWeight: 0 })
    expect(sel.edges).toEqual([
      { a: 2, b: 5, weight: 7 },
      { a: 1, b: 3006, weight: 4 },
    ])
  })

  it('(h) smartMerge remap folds pairs onto root keys, sums stats, drops self-loops', () => {
    const tallyData: TallyResult = {
      counts: new Map([
        [1, new Map([[100, 1]])],
        [5, new Map([[100, 1]])],
        [3006, new Map([[100, 1]])],
      ]),
      pairs: new Map([
        [edgeKey(1, 3006), { nX: new Map([[100, 4]]), nCross: 1 }],
        [edgeKey(1, 5), { nX: new Map([[100, 2]]), nCross: 0 }],
        [edgeKey(5, 3006), { nX: new Map([[100, 9]]), nCross: 3 }],
      ]),
    }
    // 3006 merges into 5: (1,3006) and (1,5) fold into (1,5); (5,3006) becomes a self-loop and is dropped
    const sel = select(tallyData, { mode: { kind: 'together' }, topN: 10, minWeight: 0 }, new Map([[3006, 5]]))
    expect(sel.nodes).toEqual([
      { id: 5, count: 2 },
      { id: 1, count: 1 },
    ])
    expect(sel.edges).toEqual([{ a: 1, b: 5, weight: 7 }]) // nX 4+2 + nCross 1
  })
})

describe('pruneBackbone', () => {
  it('returns [] for empty input', () => {
    expect(pruneBackbone([], 0)).toEqual([])
  })

  it('hub: drops weak edges that are neither top-2 at an endpoint nor disparity-significant', () => {
    // Hub 0 (k=10): two strong edges (w=20) and eight weak ones (w=1).
    // Each weak target has two stronger edges elsewhere (w=50), so the weak edge ranks 3rd+ at both ends.
    const edges: SelectionEdge[] = [
      { a: 0, b: 1, weight: 20 },
      { a: 0, b: 2, weight: 20 },
    ]
    for (let j = 3; j <= 10; j++) {
      edges.push({ a: 0, b: j, weight: 1 }, { a: j, b: 11, weight: 50 }, { a: j, b: 12, weight: 50 })
    }
    const out = pruneBackbone(edges, 13)
    expect(out.filter((e) => e.a === 0)).toEqual([
      { a: 0, b: 1, weight: 20 },
      { a: 0, b: 2, weight: 20 },
    ])
  })

  it('hub: keeps a disparity-significant edge that is 3rd strongest at both endpoints', () => {
    // Hub 0 (k=10, s=66): edge (0,3) has p=19/66 and (1-p)^9 ≈ 0.047 < 0.05. Node 3 has two stronger edges (w=50).
    const edges: SelectionEdge[] = [
      { a: 0, b: 1, weight: 20 },
      { a: 0, b: 2, weight: 20 },
      { a: 0, b: 3, weight: 19 },
      { a: 3, b: 11, weight: 50 },
      { a: 3, b: 12, weight: 50 },
    ]
    for (let j = 4; j <= 10; j++) edges.push({ a: 0, b: j, weight: 1 })
    expect(pruneBackbone(edges, 13)).toContainEqual({ a: 0, b: 3, weight: 19 })
  })

  it('hub: significance counts when the hub is the larger-id endpoint', () => {
    // Same hub as above, relabelled to node 20 so the disparity test runs on the b endpoint
    const edges: SelectionEdge[] = [
      { a: 1, b: 20, weight: 20 },
      { a: 2, b: 20, weight: 20 },
      { a: 3, b: 20, weight: 19 },
      { a: 3, b: 11, weight: 50 },
      { a: 3, b: 12, weight: 50 },
    ]
    for (let j = 4; j <= 10; j++) edges.push({ a: j, b: 20, weight: 1 })
    expect(pruneBackbone(edges, 13)).toContainEqual({ a: 3, b: 20, weight: 19 })
  })

  it('triangle of equal weights survives intact via the top-2 rule', () => {
    // k=2, p=0.5: (1-p)^1 = 0.5 is not significant, so only the top-2 rule keeps these edges
    const edges: SelectionEdge[] = [
      { a: 0, b: 1, weight: 2 },
      { a: 0, b: 2, weight: 2 },
      { a: 1, b: 2, weight: 2 },
    ]
    expect(pruneBackbone(edges, 3)).toEqual(edges)
  })

  it('leaf (k=1) keeps its single weak edge', () => {
    // Node 3 is a leaf. At hub 0 the edge ranks 3rd with (1-1/41)^2 ≈ 0.95, so only the leaf top-2 rule keeps it
    const edges: SelectionEdge[] = [
      { a: 0, b: 1, weight: 20 },
      { a: 0, b: 2, weight: 20 },
      { a: 0, b: 3, weight: 1 },
    ]
    expect(pruneBackbone(edges, 4)).toEqual(edges)
  })

  // Ring of `ring` nodes, each with 4 heavy (w=100) and 11 light (w=1) neighbours per side, plus weak leaves
  function ringWithLeaves(ring: number, leaves: number): SelectionEdge[] {
    const edges: SelectionEdge[] = []
    for (let i = 0; i < ring; i++) {
      for (let d = 1; d <= 15; d++) {
        const j = (i + d) % ring
        edges.push({ a: Math.min(i, j), b: Math.max(i, j), weight: d <= 4 ? 100 : 1 })
      }
    }
    for (let l = 0; l < leaves; l++) edges.push({ a: l * 10, b: ring + l, weight: 1 })
    return edges
  }

  it('budget: 100-node ring caps at round(nodeCount * 3.5) and keeps every leaf edge', () => {
    // 400 heavy edges exceed the cap of 385; leaf edges are top-2 and must survive the trim
    const out = pruneBackbone(ringWithLeaves(100, 10), 110)
    expect(out.length).toBe(385) // round(110 * 3.5)
    expect(out.filter((e) => e.b >= 100)).toHaveLength(10)
  })

  it('budget: small graphs still get the 300-edge floor', () => {
    // 304 heavy edges exceed the floor; round(81 * 3.5) = 284 would trim too much
    const out = pruneBackbone(ringWithLeaves(76, 5), 81)
    expect(out.length).toBe(300)
    expect(out.filter((e) => e.b >= 76)).toHaveLength(5)
  })
})
