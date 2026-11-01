import { describe, expect, it } from 'vitest'
import { select } from '../src/core/select'
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
})
