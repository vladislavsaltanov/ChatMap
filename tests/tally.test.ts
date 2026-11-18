import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Intern, MAX_TOKEN_ID } from '../src/core/intern'
import { buildUnits, countByBuckets, countsUpTo, dropFor, edgeKey, filterCacheKey, mergeCacheKey, parseEdgeKey, PipelineCache, tally, type PairStat, type RawUnit, type ResolveResult } from '../src/core/tally'
import { tokenize } from '../src/core/tokenize'
import type { ChatExport, FilterCfg, Message } from '../src/core/types'

// pass-through spy so tests can count tokenize() calls
vi.mock('../src/core/tokenize', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/tokenize')>()
  return { ...actual, tokenize: vi.fn(actual.tokenize) }
})

// total edge weight as select.ts sums it: nX over authors + nCross
const total = (s: PairStat | undefined): number =>
  s ? s.nCross + [...s.nX.values()].reduce((a, b) => a + b, 0) : 0

describe('tally', () => {
  it('(f) edgeKey is order-free and numeric; parseEdgeKey inverts it', () => {
    expect(edgeKey(2, 5)).toBe(edgeKey(5, 2))
    expect(typeof edgeKey(2, 5)).toBe('number')
    expect(parseEdgeKey(edgeKey(5, 2))).toEqual([2, 5])
    expect(parseEdgeKey(edgeKey(1, 3006))).toEqual([1, 3006])
  })

  it('throws before pair keys can collide', () => {
    expect(() => edgeKey(1, MAX_TOKEN_ID + 1)).toThrow(RangeError)
    expect(parseEdgeKey(edgeKey(MAX_TOKEN_ID - 1, MAX_TOKEN_ID))).toEqual([MAX_TOKEN_ID - 1, MAX_TOKEN_ID])
  })

  it('(a) 5 tokens in one unit: all 10 pairs, weight 1/d for distance d <= W=4', () => {
    const tokens = new Uint32Array([1, 2, 3, 4, 5])
    const units: RawUnit[] = [
      { authorId: 10, dateMs: 1000, replyTo: null, tokens },
    ]
    const res = tally(units)
    // 5 tokens -> 5*4/2 = 10 pairs, all inside the window (max distance 4)
    expect(res.pairs.size).toBe(10)
    for (const [key, stat] of res.pairs) {
      const [a, b] = parseEdgeKey(key)
      expect(stat.nX.get(10)).toBeCloseTo(1 / (b - a))
      expect(stat.nCross).toBe(0)
    }
    expect(res.pairs.get(edgeKey(1, 2))?.nX.get(10)).toBe(1)
    expect(res.pairs.get(edgeKey(1, 3))?.nX.get(10)).toBe(0.5)
    expect(res.pairs.get(edgeKey(1, 4))?.nX.get(10)).toBeCloseTo(1 / 3)
    expect(res.pairs.get(edgeKey(1, 5))?.nX.get(10)).toBe(0.25)
  })

  it('(b) unit with 20 tokens: only pairs at distance 1..4, weight 1/d', () => {
    const tokens = new Uint32Array(Array.from({ length: 20 }, (_, i) => i + 1))
    const units: RawUnit[] = [
      { authorId: 10, dateMs: 1000, replyTo: null, tokens },
    ]
    const res = tally(units)

    // Verify distance 1..4 with weight 1/d
    for (const [key, stat] of res.pairs) {
      const [a, b] = parseEdgeKey(key)
      expect(b - a).toBeGreaterThanOrEqual(1)
      expect(b - a).toBeLessThanOrEqual(4)
      expect(stat.nX.get(10)).toBeCloseTo(1 / (b - a))
    }
    // distance 5 gets no intra-unit link
    expect(res.pairs.has(edgeKey(1, 6))).toBe(false)
    // Pairs at dist 1: 19; dist 2: 18; dist 3: 17; dist 4: 16 => 70 pairs
    expect(res.pairs.size).toBe(19 + 18 + 17 + 16)
  })

  it('(c0) adjacent links use only the first MAX_LINK_TOKENS of each unit', () => {
    const head = new Uint32Array(Array.from({ length: 200 }, (_, i) => i + 1))
    const tail = new Uint32Array(Array.from({ length: 300 }, (_, i) => i + 201))
    const big = new Uint32Array([...head, ...tail])
    const other = new Uint32Array(Array.from({ length: 500 }, (_, i) => i + 1001))
    const u1: RawUnit = { id: 1, authorId: 10, dateMs: 1000, replyTo: null, tokens: big }
    const u2: RawUnit = { id: 2, authorId: 10, dateMs: 61000, replyTo: null, tokens: other }
    const res = tally([u1, u2])
    // head token links at the adjacent weight
    expect(res.pairs.get(edgeKey(1, 1001))?.nX.get(10)).toBe(0.7)
    // tail tokens (past the cap) build no cross links
    expect(res.pairs.has(edgeKey(201, 1201))).toBe(false)
    expect(res.pairs.has(edgeKey(500, 1500))).toBe(false)
  })

  it('(c) adjacent messages within 10min link at 0.7; beyond that no link', () => {
    // 60s gap -> adjacent link at 0.7
    const u1: RawUnit = { id: 1, authorId: 10, dateMs: 1000, replyTo: null, tokens: new Uint32Array([1, 2]) }
    const u2: RawUnit = { id: 2, authorId: 10, dateMs: 61000, replyTo: null, tokens: new Uint32Array([3, 4]) }
    const resClose = tally([u1, u2])
    expect(resClose.pairs.get(edgeKey(1, 2))?.nX.get(10)).toBe(1) // intra-unit, d=1
    expect(resClose.pairs.get(edgeKey(1, 3))?.nX.get(10)).toBe(0.7) // adjacent, close gap

    // gap of exactly 10min is still close; 10min + 1ms is far
    const edge: RawUnit = { id: 3, authorId: 10, dateMs: 1000, replyTo: null, tokens: new Uint32Array([1, 2]) }
    const atEdge: RawUnit = { id: 4, authorId: 10, dateMs: 1000 + 600_000, replyTo: null, tokens: new Uint32Array([3, 4]) }
    expect(tally([edge, atEdge]).pairs.has(edgeKey(1, 3))).toBe(true)
    const pastEdge: RawUnit = { id: 5, authorId: 10, dateMs: 1000 + 600_001, replyTo: null, tokens: new Uint32Array([3, 4]) }
    const resFar = tally([edge, pastEdge])
    expect(resFar.pairs.has(edgeKey(1, 3))).toBe(false)
    // intra-message pairs survive the far gap
    expect(resFar.pairs.get(edgeKey(1, 2))?.nX.get(10)).toBe(1)
  })

  it('(c2) max-not-sum: pair intra-linked in one message and adjacent across messages counts max', () => {
    // (1,2): adjacent in M1 (1.0) and adjacent M1xM2 (0.7) -> 1.0, not 1.7
    const u1: RawUnit = { id: 1, authorId: 10, dateMs: 1000, replyTo: null, tokens: new Uint32Array([1, 2]) }
    const u2: RawUnit = { id: 2, authorId: 10, dateMs: 61000, replyTo: null, tokens: new Uint32Array([3, 1]) }
    const res = tally([u1, u2])
    expect(res.pairs.get(edgeKey(1, 2))?.nX.get(10)).toBe(1)
    // genuinely new adjacent pairs still appear
    expect(res.pairs.get(edgeKey(2, 3))?.nX.get(10)).toBe(0.7)
  })

  it('adjacent messages count a repeated cross pair once', () => {
    const u1: RawUnit = { id: 1, authorId: 10, dateMs: 1000, replyTo: null, tokens: new Uint32Array([1, 2, 1]) }
    const u2: RawUnit = { id: 2, authorId: 10, dateMs: 2000, replyTo: null, tokens: new Uint32Array([3]) }
    const res = tally([u1, u2])
    expect(res.pairs.get(edgeKey(1, 3))?.nX.get(10)).toBe(0.7)
    expect(res.pairs.get(edgeKey(2, 3))?.nX.get(10)).toBe(0.7)
  })

  it('(k) phrase [10,11,12] in 5 separate messages forms the top triangle', () => {
    const units: RawUnit[] = Array.from({ length: 5 }, (_, k) => ({
      authorId: 10, dateMs: 1000 + k * 200_000, replyTo: null, tokens: new Uint32Array([10, 11, 12]),
    }))
    // one incidental single-occurrence pair from another author
    units.push({ authorId: 20, dateMs: 5000, replyTo: null, tokens: new Uint32Array([30, 31]) })
    const res = tally(units)
    expect(total(res.pairs.get(edgeKey(10, 11)))).toBe(5)
    expect(total(res.pairs.get(edgeKey(11, 12)))).toBe(5)
    expect(total(res.pairs.get(edgeKey(10, 12)))).toBe(2.5)
    expect(total(res.pairs.get(edgeKey(30, 31)))).toBe(1)
    const top3 = [...res.pairs.entries()]
      .sort((x, y) => total(y[1]) - total(x[1]))
      .slice(0, 3)
      .map(([key]) => key)
      .sort()
    expect(top3).toEqual([edgeKey(10, 11), edgeKey(10, 12), edgeKey(11, 12)].sort())
  })

  it('(d) only neighbours link: three close messages form a chain, ends stay unlinked', () => {
    const m1: RawUnit = { id: 1, authorId: 10, dateMs: 1000, replyTo: null, tokens: new Uint32Array([1]) }
    const m2: RawUnit = { id: 2, authorId: 10, dateMs: 2000, replyTo: null, tokens: new Uint32Array([2]) }
    const m3: RawUnit = { id: 3, authorId: 10, dateMs: 3000, replyTo: null, tokens: new Uint32Array([3]) }
    const res = tally([m1, m2, m3])
    expect(res.pairs.get(edgeKey(1, 2))?.nX.get(10)).toBe(0.7)
    expect(res.pairs.get(edgeKey(2, 3))?.nX.get(10)).toBe(0.7)
    expect(res.pairs.has(edgeKey(1, 3))).toBe(false)
  })

  it('(d2) multi-unit message links all its units against the neighbour message', () => {
    const a1: RawUnit = { id: 1, authorId: 10, dateMs: 1000, replyTo: null, tokens: new Uint32Array([1]) }
    const a2: RawUnit = { id: 1, authorId: 10, dateMs: 1000, replyTo: null, tokens: new Uint32Array([2]) }
    const b: RawUnit = { id: 2, authorId: 10, dateMs: 2000, replyTo: null, tokens: new Uint32Array([3]) }
    const res = tally([a1, a2, b])
    expect(res.pairs.get(edgeKey(1, 3))?.nX.get(10)).toBe(0.7)
    expect(res.pairs.get(edgeKey(2, 3))?.nX.get(10)).toBe(0.7)
  })

  it('(e) reply links at 1.0 regardless of gap: cross-author to nCross, self-reply to nX', () => {
    const target: RawUnit = { id: 100, authorId: 10, dateMs: 1000, replyTo: null, tokens: new Uint32Array([1]) }
    const replyOther: RawUnit = { id: 101, authorId: 20, dateMs: 2000, replyTo: 100, tokens: new Uint32Array([2]) }
    const resOther = tally([target, replyOther])
    const key = edgeKey(1, 2)
    // reply (1.0) and close adjacency (0.7) are independent evidence: they add up
    expect(resOther.pairs.get(key)?.nCross).toBe(1.7)
    expect(resOther.pairs.get(key)?.nX.get(20) || 0).toBe(0)

    const replySelf: RawUnit = { id: 102, authorId: 10, dateMs: 150000, replyTo: 100, tokens: new Uint32Array([3]) }
    const resSelf = tally([target, replySelf])
    const keySelf = edgeKey(1, 3)
    expect(resSelf.pairs.get(keySelf)?.nCross).toBe(0)
    // self-reply (1.0) plus close adjacency (0.7): independent evidence adds up
    expect(resSelf.pairs.get(keySelf)?.nX.get(10)).toBe(1.7)
  })

  it('(e2) reply bridges a far gap that adjacency alone would not', () => {
    const target: RawUnit = { id: 100, authorId: 10, dateMs: 1000, replyTo: null, tokens: new Uint32Array([1]) }
    // 1h later: far beyond the 10min adjacency window, but an explicit reply still links
    const reply: RawUnit = { id: 101, authorId: 20, dateMs: 3601000, replyTo: 100, tokens: new Uint32Array([2]) }
    const res = tally([target, reply])
    expect(res.pairs.get(edgeKey(1, 2))?.nCross).toBe(1.0)
  })

  it('(g) adjacent messages of different authors link at 0.7 into nCross', () => {
    const u1: RawUnit = { id: 1, authorId: 10, dateMs: 1000, replyTo: null, tokens: new Uint32Array([1, 2]) }
    const u2: RawUnit = { id: 2, authorId: 20, dateMs: 2000, replyTo: null, tokens: new Uint32Array([3, 4]) }
    const res = tally([u1, u2])
    expect(res.pairs.get(edgeKey(1, 3))?.nCross).toBe(0.7)
    expect(res.pairs.get(edgeKey(1, 3))?.nX.size).toBe(0)
    // intra-message pairs keep their own author
    expect(res.pairs.get(edgeKey(1, 2))?.nX.get(10)).toBe(1)
    expect(res.pairs.get(edgeKey(3, 4))?.nX.get(20)).toBe(1)
  })

  it('(h) pairs (1, 3006) and (2, 5) are two distinct edges, not a key collision', () => {
    const u1: RawUnit = { id: 1, authorId: 10, dateMs: 1000, replyTo: null, tokens: new Uint32Array([1, 3006]) }
    const u2: RawUnit = { id: 2, authorId: 20, dateMs: 2000000, replyTo: null, tokens: new Uint32Array([2, 5]) }
    const res = tally([u1, u2])
    expect(edgeKey(1, 3006)).not.toBe(edgeKey(2, 5))
    expect(res.pairs.size).toBe(2)
    expect(res.pairs.get(edgeKey(1, 3006))?.nX).toEqual(new Map([[10, 1]]))
    expect(res.pairs.get(edgeKey(2, 5))?.nX).toEqual(new Map([[20, 1]]))
  })

  it('(i) unknown dates (dateMs 0) count as close: never punished for missing data', () => {
    const u1: RawUnit = { id: 1, authorId: 10, dateMs: 0, replyTo: null, tokens: new Uint32Array([1, 2]) }
    const u2: RawUnit = { id: 2, authorId: 10, dateMs: 0, replyTo: null, tokens: new Uint32Array([3, 4]) }
    const u3: RawUnit = { id: 3, authorId: 10, dateMs: 1000, replyTo: null, tokens: new Uint32Array([5, 6]) }
    const res = tally([u1, u2])
    expect(res.pairs.has(edgeKey(1, 2))).toBe(true)
    expect(res.pairs.has(edgeKey(3, 4))).toBe(true)
    expect(res.pairs.get(edgeKey(1, 3))?.nX.get(10)).toBe(0.7)
    // a dated message right after an undated one links too
    expect(tally([u1, u3]).pairs.get(edgeKey(1, 5))?.nX.get(10)).toBe(0.7)
  })

  it('(j) out-of-order timestamps (second dateMs < first) never link as adjacent', () => {
    const u1: RawUnit = { id: 1, authorId: 10, dateMs: 61000, replyTo: null, tokens: new Uint32Array([1, 2]) }
    const u2: RawUnit = { id: 2, authorId: 10, dateMs: 1000, replyTo: null, tokens: new Uint32Array([3, 4]) }
    const res = tally([u1, u2])
    expect(res.pairs.has(edgeKey(1, 2))).toBe(true)
    expect(res.pairs.has(edgeKey(3, 4))).toBe(true)
    expect(res.pairs.has(edgeKey(1, 3))).toBe(false)
  })

  it('buildUnits converts chat messages using intern and drops filtered tokens', () => {
    const ia = new Intern()
    const chat: ChatExport = {
      name: 'test',
      chatType: 'personal_chat',
      messages: [
        {
          id: 1,
          kind: 'message',
          authorId: 111,
          dateMs: 1000,
          parts: [{ text: 'Привет! Как дела?', entity: 'plain' }],
          replyTo: null,
        },
        {
          id: 2,
          kind: 'service',
          authorId: 111,
          dateMs: 2000,
          parts: [],
          replyTo: null,
        },
      ],
    }
    // Drop token 'как'
    const units = buildUnits(chat, ia, (t) => t.word === 'как')
    expect(units.length).toBe(2) // 2 units from 'Привет!' and 'Как дела?'
    expect(units[0].authorId).toBe(111)
    expect(units[0].tokens.length).toBe(1) // 'привет'
    expect(units[1].tokens.length).toBe(1) // 'дела' ('как' dropped)
  })
})

const textMsg = (id: number, authorId: number, text: string, dateMs = id * 1000): Message => ({
  id,
  kind: 'message',
  authorId,
  dateMs,
  parts: [{ text, entity: 'plain' }],
  replyTo: null,
})

const CFG: FilterCfg = {
  mat: false,
  laugh: false,
  tech: false,
  digits: false,
  stopwords: false,
  customMat: [],
  customLaugh: [],
  smartMerge: false,
}

// uncached oracle: buildUnits + tally with the production drop rules
const oracle = (chat: ChatExport, cfg: FilterCfg) => {
  const ia = new Intern()
  return { ia, tallyResult: tally(buildUnits(chat, ia, dropFor(cfg))) }
}

// pass-1 whole-history counts: what the open path uses instead of tally().counts
const fullCounts = (res: ResolveResult): Map<number, Map<number, number>> =>
  countsUpTo(res.bucketCounts, res.meta.count - 1)

describe('buildUnits progress', () => {
  it('calls onProgress(doneMsgs, totalMsgs) at every 5000th message index', () => {
    const chatOf = (n: number): ChatExport => ({
      name: 'big',
      chatType: 'personal_chat',
      messages: Array.from({ length: n }, (_, i) => textMsg(i + 1, 1, 'слово', 1000 + i)),
    })
    const onProgress = vi.fn()
    const units = buildUnits(chatOf(5005), new Intern(), () => false, onProgress)
    expect(units.length).toBe(5005)
    expect(onProgress.mock.calls).toEqual([[5000, 5005]])

    const onProgress2 = vi.fn()
    buildUnits(chatOf(10_005), new Intern(), () => false, onProgress2)
    expect(onProgress2.mock.calls).toEqual([[5000, 10005], [10000, 10005]])
  })
})

describe('cache keys', () => {
  it('filterCacheKey covers stopwords and custom lists, ignores smartMerge', () => {
    const key = filterCacheKey(CFG)
    expect(filterCacheKey({ ...CFG, smartMerge: true })).toBe(key)
    expect(filterCacheKey({ ...CFG, mat: true })).not.toBe(key)
    expect(filterCacheKey({ ...CFG, customMat: ['a', 'b'] })).not.toBe(filterCacheKey({ ...CFG, customMat: ['a,b'] }))
  })

  it('mergeCacheKey is the filter key plus smartMerge', () => {
    expect(mergeCacheKey({ ...CFG, smartMerge: true, stopwords: true })).not.toBe(mergeCacheKey({ ...CFG, smartMerge: true }))
    expect(mergeCacheKey({ ...CFG, smartMerge: true })).not.toBe(mergeCacheKey(CFG))
    expect(mergeCacheKey({ ...CFG, mat: true })).not.toBe(mergeCacheKey(CFG))
  })
})

describe('PipelineCache', () => {
  const tokenizeSpy = vi.mocked(tokenize)
  // block body: mockClear() returns the spy, and vitest would call a returned function as teardown
  beforeEach(() => {
    tokenizeSpy.mockClear()
  })

  // 3 text messages; the service message is skipped and never tokenized
  const chat: ChatExport = {
    name: 'pipe',
    chatType: 'personal_chat',
    messages: [
      textMsg(1, 1, 'блять ну лол разговоры про котиков'),
      textMsg(2, 2, 'разговоры продолжаются котики 2024 ок'),
      { id: 3, kind: 'service', authorId: 1, dateMs: 3000, parts: [], replyTo: null },
      textMsg(4, 1, 'лол разговор'),
    ],
  }

  it('toggling stopwords recomputes counts and merge without re-tokenizing', () => {
    const cache = new PipelineCache()
    const cfg = { ...CFG, smartMerge: true }
    const before = cache.resolve(chat, cfg)

    const onTokenize = vi.fn()
    const onCount = vi.fn()
    const onMerge = vi.fn()
    const after = cache.resolve(chat, { ...cfg, stopwords: true }, {
      onTokenizeStart: onTokenize,
      onCountStart: onCount,
      onMergeStart: onMerge,
    })
    expect(onTokenize).not.toHaveBeenCalled()
    expect(tokenizeSpy).toHaveBeenCalledTimes(3)
    expect(onCount).toHaveBeenCalledTimes(1)
    expect(onMerge).toHaveBeenCalledTimes(1)
    expect(after.countsCached).toBe(false)
    // 'ну' and 'про' are stopwords: kept now, so the counts must change
    expect(fullCounts(after)).not.toEqual(fullCounts(before))
    expect(fullCounts(after)).toEqual(oracle(chat, { ...cfg, stopwords: true }).tallyResult.counts)
  })

  it('toggling smartMerge recomputes only the merge', () => {
    const cache = new PipelineCache()
    const off = cache.resolve(chat, CFG)
    expect(off.merged).toBeUndefined()

    const onCount = vi.fn()
    const onMerge = vi.fn()
    const on = cache.resolve(chat, { ...CFG, smartMerge: true }, { onCountStart: onCount, onMergeStart: onMerge })
    expect(onCount).not.toHaveBeenCalled()
    expect(onMerge).toHaveBeenCalledTimes(1)
    expect(on.countsCached).toBe(true)
    expect(on.units).toBe(off.units)
    expect(on.ia).toBe(off.ia)
    expect(on.merged).toBeInstanceOf(Map)

    // switching off keeps the counts slot; switching back on reuses the stored merge
    const offAgain = cache.resolve(chat, CFG)
    expect(offAgain.merged).toBeUndefined()
    expect(offAgain.countsCached).toBe(true)
    const onAgain = cache.resolve(chat, { ...CFG, smartMerge: true })
    expect(onAgain.countsCached).toBe(true)
    expect(onAgain.merged).toBe(on.merged)
  })

  it('toggling a filter recomputes counts and merge without re-tokenizing', () => {
    const cache = new PipelineCache()
    const cfg = { ...CFG, smartMerge: true }
    const before = cache.resolve(chat, cfg)

    const onTokenize = vi.fn()
    const onCount = vi.fn()
    const onMerge = vi.fn()
    const after = cache.resolve(chat, { ...cfg, mat: true }, {
      onTokenizeStart: onTokenize,
      onCountStart: onCount,
      onMergeStart: onMerge,
    })
    expect(onTokenize).not.toHaveBeenCalled()
    expect(tokenizeSpy).toHaveBeenCalledTimes(3)
    expect(onCount).toHaveBeenCalledTimes(1)
    expect(onMerge).toHaveBeenCalledTimes(1)
    expect(after.countsCached).toBe(false)
    // 'блять' is kept now, so the counts must actually change
    expect(fullCounts(after)).not.toEqual(fullCounts(before))
    expect(fullCounts(after)).toEqual(oracle(chat, { ...cfg, mat: true }).tallyResult.counts)
  })

  it('a different ChatExport object tokenizes again', () => {
    const cache = new PipelineCache()
    cache.resolve(chat, CFG)
    const onTokenize = vi.fn()
    cache.resolve({ ...chat }, CFG, { onTokenizeStart: onTokenize })
    expect(onTokenize).toHaveBeenCalledTimes(1)
  })

  it('reports tokenize progress every 5000 messages', () => {
    const big: ChatExport = {
      name: 'big',
      chatType: 'personal_chat',
      messages: Array.from({ length: 5005 }, (_, i) => textMsg(i + 1, 1, 'слово', 1000 + i)),
    }
    const onTokenizeProgress = vi.fn()
    new PipelineCache().resolve(big, CFG, { onTokenizeProgress })
    expect(onTokenizeProgress.mock.calls).toEqual([[5000, 5005]])
  })

  it('keeps a second filter slot so an A->B->A toggle recomputes once', () => {
    const cache = new PipelineCache()
    const cfgA = { ...CFG, smartMerge: true }
    const cfgB = { ...cfgA, mat: true }
    cache.resolve(chat, cfgA)

    const onCount = vi.fn()
    const onMerge = vi.fn()
    cache.resolve(chat, cfgB, { onCountStart: onCount, onMergeStart: onMerge })
    expect(onCount).toHaveBeenCalledTimes(1)
    expect(onMerge).toHaveBeenCalledTimes(1)

    // Coming back must reuse the first slot instead of paying for pass 1 again.
    const back = cache.resolve(chat, cfgA, { onCountStart: onCount, onMergeStart: onMerge })
    expect(onCount).toHaveBeenCalledTimes(1)
    expect(onMerge).toHaveBeenCalledTimes(1)
    expect(back.countsCached).toBe(true)
    expect(fullCounts(back)).toEqual(oracle(chat, cfgA).tallyResult.counts)
  })

  it('reports countsCached as false on a miss and true on an A->B->A reuse', () => {
    const cache = new PipelineCache()
    const cfgA = { ...CFG, smartMerge: true }
    const cfgB = { ...cfgA, mat: true }
    const firstA = cache.resolve(chat, cfgA)
    const b = cache.resolve(chat, cfgB)
    const secondA = cache.resolve(chat, cfgA)
    expect(firstA.countsCached).toBe(false)
    expect(b.countsCached).toBe(false)
    expect(secondA.countsCached).toBe(true)
    // the reused slot hands back the very same pass-1 store
    expect(secondA.units).toBe(firstA.units)
    expect(secondA.bucketCounts).toBe(firstA.bucketCounts)
    expect(b.units).not.toBe(firstA.units)
  })

  it('evicts the least recently used filter slot beyond the cap', () => {
    const cache = new PipelineCache()
    const cfgB = { ...CFG, mat: true }
    const cfgC = { ...CFG, laugh: true }
    cache.resolve(chat, CFG)
    cache.resolve(chat, cfgB)
    // The third distinct filter key drops the least recently used one (CFG).
    cache.resolve(chat, cfgC)

    const onCount = vi.fn()
    cache.resolve(chat, cfgB, { onCountStart: onCount })
    expect(onCount).not.toHaveBeenCalled()

    cache.resolve(chat, CFG, { onCountStart: onCount })
    expect(onCount).toHaveBeenCalledTimes(1)
  })

  it('matches the uncached buildUnits + tally result across a sequence of filter changes', () => {
    const cache = new PipelineCache()
    const cfgs: FilterCfg[] = [
      CFG,
      { ...CFG, mat: true },
      { ...CFG, laugh: true, customMat: ['разговор'] },
      { ...CFG, mat: true, laugh: true, tech: true, digits: true, customLaugh: ['ок'] },
      CFG,
    ]
    for (const cfg of cfgs) {
      const got = cache.resolve(chat, cfg)
      const want = oracle(chat, cfg)
      expect(fullCounts(got)).toEqual(want.tallyResult.counts)
      expect(got.ia.idToCanon).toEqual(want.ia.idToCanon)
    }
  })

  it('не вливает редкую форму в частотное самостоятельное слово корпуса', () => {
    // The corpus is the dictionary: 30 standalone «меня» must not swallow the two
    // rare verb forms that stem to the same four letters (see canon.ts).
    const chat: ChatExport = {
      name: 'stem',
      chatType: 'personal_chat',
      messages: [
        ...Array.from({ length: 30 }, (_, i) => textMsg(i + 1, 1, 'меня тут')),
        textMsg(31, 2, 'менять план'),
        textMsg(32, 2, 'меняет вид'),
      ],
    }
    const { ia } = new PipelineCache().resolve(chat, CFG)
    const idOf = (form: string): number | undefined => {
      for (const [id, forms] of ia.forms) if (forms.has(form)) return id
      return undefined
    }
    const pronoun = idOf('меня')
    expect(pronoun).toBeDefined()
    expect(idOf('менять')).not.toBe(pronoun)
    expect(idOf('меняет')).not.toBe(pronoun)
  })
})

// Seven consecutive months (март..сентябрь 2024) => the month regime, seven buckets.
const monthChat: ChatExport = {
  name: 'months',
  chatType: 'personal_chat',
  messages: [
    textMsg(1, 1, 'март слово', new Date(2024, 2, 10).getTime()),
    textMsg(2, 1, 'апрель слово', new Date(2024, 3, 10).getTime()),
    textMsg(3, 2, 'май слово', new Date(2024, 4, 10).getTime()),
    textMsg(4, 2, 'июнь слово', new Date(2024, 5, 10).getTime()),
    textMsg(5, 1, 'июль слово', new Date(2024, 6, 10).getTime()),
    textMsg(6, 1, 'август слово', new Date(2024, 7, 10).getTime()),
    textMsg(7, 1, 'сентябрь слово', new Date(2024, 8, 10).getTime()),
  ],
}

// brute-force prefix over the unit list: the oracle for countsUpTo
const prefixOracle = (units: RawUnit[], t: number): Map<number, Map<number, number>> => {
  const out = new Map<number, Map<number, number>>()
  for (const unit of units) {
    // same guard as countByBuckets: an unstamped unit belongs to bucket 0
    if ((unit.bucket ?? 0) > t) continue
    for (const tokId of unit.tokens) {
      let byAuthor = out.get(tokId)
      if (!byAuthor) {
        byAuthor = new Map()
        out.set(tokId, byAuthor)
      }
      byAuthor.set(unit.authorId, (byAuthor.get(unit.authorId) ?? 0) + 1)
    }
  }
  return out
}

const totalCounts = (counts: Map<number, Map<number, number>>): number => {
  let sum = 0
  for (const byAuthor of counts.values()) for (const cnt of byAuthor.values()) sum += cnt
  return sum
}

// token id of a surface form, by scanning the intern table (ids are not stable a priori)
const idOfForm = (ia: Intern, form: string): number => {
  for (const [id, forms] of ia.forms) if (forms.has(form)) return id
  return -1
}

describe('pass-1 buckets', () => {
  it('stamps unit.bucket from BucketMeta and leaves it undefined without one', () => {
    // buildUnits keeps its old signature: no meta, no stamps.
    const unstamped = buildUnits(monthChat, new Intern(), dropFor(CFG))
    expect(unstamped.length).toBe(7)
    expect(unstamped.every((unit) => unit.bucket === undefined)).toBe(true)

    const res = new PipelineCache().resolve(monthChat, CFG)
    expect(res.meta.eligible).toBe(true)
    expect(res.meta.count).toBe(7) // март..сентябрь
    expect(res.units.length).toBe(unstamped.length)
    for (const unit of res.units) expect(unit.bucket).toBe(res.meta.bucketOf(unit.dateMs))
    // one message per month, exported in order: the stamps are 0..6
    expect(res.units.map((unit) => unit.bucket)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('countsUpTo sums buckets up to and including t, per author', () => {
    const res = new PipelineCache().resolve(monthChat, CFG)
    const full = fullCounts(res)
    for (let t = 0; t < res.meta.count; t++) {
      expect(countsUpTo(res.bucketCounts, t)).toEqual(prefixOracle(res.units, t))
    }
    // inclusive: t=0 is the first month alone (2 tokens), t=2 adds two more months
    expect(totalCounts(countsUpTo(res.bucketCounts, 0))).toBe(2)
    expect(totalCounts(countsUpTo(res.bucketCounts, 2))).toBe(6)
    expect(totalCounts(full)).toBe(14)
    // the cursor's last bucket is count-1; asking past it clamps to full history
    expect(countsUpTo(res.bucketCounts, res.meta.count)).toEqual(full)
  })

  it('ignores the buckets above t, per author', () => {
    const res = new PipelineCache().resolve(monthChat, CFG)
    // 'май' (author 2) appears only in bucket 2; 'март' (author 1) only in bucket 0
    const mayId = idOfForm(res.ia, 'май')
    const marchId = idOfForm(res.ia, 'март')
    expect(countsUpTo(res.bucketCounts, 1).has(mayId)).toBe(false)
    expect(countsUpTo(res.bucketCounts, 2).get(mayId)).toEqual(new Map([[2, 1]]))
    expect(countsUpTo(res.bucketCounts, 0).get(marchId)).toEqual(new Map([[1, 1]]))
    expect(countsUpTo(res.bucketCounts, 1).get(marchId)).toEqual(new Map([[1, 1]]))
  })

  it('keeps a unit without a bucket in bucket 0, so no slice drops it', () => {
    const units: RawUnit[] = [
      { authorId: 1, dateMs: 0, replyTo: null, tokens: new Uint32Array([5]) },
      { authorId: 1, dateMs: 0, replyTo: null, tokens: new Uint32Array([5]), bucket: 0 },
      { authorId: 2, dateMs: 0, replyTo: null, tokens: new Uint32Array([5]), bucket: 3 },
    ]
    const bc = countByBuckets(units, 4)
    // the unstamped unit counts exactly like an explicit bucket-0 one
    expect(countsUpTo(bc, 0).get(5)).toEqual(new Map([[1, 2]]))
    expect(countsUpTo(bc, 2).get(5)).toEqual(new Map([[1, 2]]))
    expect(countsUpTo(bc, 3).get(5)).toEqual(
      new Map([
        [1, 2],
        [2, 1],
      ]),
    )
  })
})
