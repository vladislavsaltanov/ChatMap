import { describe, expect, it } from 'vitest'
import { Intern } from '../src/core/intern'
import { buildUnits, edgeKey, parseEdgeKey, tally, type PairStat, type RawUnit } from '../src/core/tally'
import type { ChatExport } from '../src/core/types'

// total edge weight as select.ts sums it: nX over authors + nCross
const total = (s: PairStat | undefined): number =>
  s ? s.nCross + [...s.nX.values()].reduce((a, b) => a + b, 0) : 0

describe('tally', () => {
  it('(f) edgeKey is "min:max" for either argument order; parseEdgeKey inverts it', () => {
    expect(edgeKey(2, 5)).toBe('2:5')
    expect(edgeKey(5, 2)).toBe('2:5')
    expect(parseEdgeKey(edgeKey(5, 2))).toEqual([2, 5])
    expect(parseEdgeKey(edgeKey(1, 3006))).toEqual([1, 3006])
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

  it('(c) units within 120s merge into series with cross-boundary pairs; >120s separate', () => {
    // 60s pause -> merged
    const u1: RawUnit = { authorId: 10, dateMs: 1000, replyTo: null, tokens: new Uint32Array([1, 2]) }
    const u2: RawUnit = { authorId: 10, dateMs: 61000, replyTo: null, tokens: new Uint32Array([3, 4]) }
    const resMerged = tally([u1, u2])
    expect(resMerged.pairs.has(edgeKey(1, 3))).toBe(true)
    expect(resMerged.pairs.get(edgeKey(1, 2))?.nX.get(10)).toBe(1) // intra-unit, d=1
    expect(resMerged.pairs.get(edgeKey(1, 3))?.nX.get(10)).toBe(0.3) // cross-unit, beta

    // 150s pause -> separate
    const u3: RawUnit = { authorId: 10, dateMs: 1000, replyTo: null, tokens: new Uint32Array([1, 2]) }
    const u4: RawUnit = { authorId: 10, dateMs: 151000, replyTo: null, tokens: new Uint32Array([3, 4]) }
    const resSeparate = tally([u3, u4])
    expect(resSeparate.pairs.has(edgeKey(1, 3))).toBe(false)
  })

  it('(c2) seriesMax: pair adjacent in one unit and cross-unit in one series counts max, not sum', () => {
    const u1: RawUnit = { authorId: 10, dateMs: 1000, replyTo: null, tokens: new Uint32Array([1, 2]) }
    const u2: RawUnit = { authorId: 10, dateMs: 61000, replyTo: null, tokens: new Uint32Array([3, 1]) }
    const res = tally([u1, u2])
    // (1,2): adjacent in u1 (1.0) and cross-unit (0.3) in the same series -> 1.0, not 1.3
    expect(res.pairs.get(edgeKey(1, 2))?.nX.get(10)).toBe(1)
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

  it('(d) series caps at 30 tokens, splitting 35 tokens into two series', () => {
    const u1: RawUnit = { authorId: 10, dateMs: 1000, replyTo: null, tokens: new Uint32Array(Array.from({ length: 20 }, (_, i) => i + 1)) }
    const u2: RawUnit = { authorId: 10, dateMs: 2000, replyTo: null, tokens: new Uint32Array(Array.from({ length: 15 }, (_, i) => i + 21)) }
    const res = tally([u1, u2])
    // 20 + 15 = 35 > 30, so u2 is in a separate series; pair between 1 and 21 does not exist
    expect(res.pairs.has(edgeKey(1, 21))).toBe(false)
  })

  it('(e) reply to another author adds 0.5 to nCross; self-reply adds 0.5 to nX', () => {
    const target: RawUnit = { id: 100, authorId: 10, dateMs: 1000, replyTo: null, tokens: new Uint32Array([1]) }
    const replyOther: RawUnit = { id: 101, authorId: 20, dateMs: 2000, replyTo: 100, tokens: new Uint32Array([2]) }
    const resOther = tally([target, replyOther])
    const key = edgeKey(1, 2)
    expect(resOther.pairs.get(key)?.nCross).toBe(0.5)
    expect(resOther.pairs.get(key)?.nX.get(20) || 0).toBe(0)

    const replySelf: RawUnit = { id: 102, authorId: 10, dateMs: 150000, replyTo: 100, tokens: new Uint32Array([3]) }
    const resSelf = tally([target, replySelf])
    const keySelf = edgeKey(1, 3)
    expect(resSelf.pairs.get(keySelf)?.nCross).toBe(0)
    expect(resSelf.pairs.get(keySelf)?.nX.get(10)).toBe(0.5)
  })

  it('(g) different authors do not merge into serial even with short pause', () => {
    const u1: RawUnit = { authorId: 10, dateMs: 1000, replyTo: null, tokens: new Uint32Array([1, 2]) }
    const u2: RawUnit = { authorId: 20, dateMs: 2000, replyTo: null, tokens: new Uint32Array([3, 4]) }
    const res = tally([u1, u2])
    expect(res.pairs.has(edgeKey(1, 3))).toBe(false)
  })

  it('(h) pairs (1, 3006) and (2, 5) are two distinct edges, not a key collision', () => {
    const u1: RawUnit = { authorId: 10, dateMs: 1000, replyTo: null, tokens: new Uint32Array([1, 3006]) }
    const u2: RawUnit = { authorId: 20, dateMs: 2000, replyTo: null, tokens: new Uint32Array([2, 5]) }
    const res = tally([u1, u2])
    expect(edgeKey(1, 3006)).not.toBe(edgeKey(2, 5))
    expect(res.pairs.size).toBe(2)
    expect(res.pairs.get(edgeKey(1, 3006))?.nX).toEqual(new Map([[10, 1]]))
    expect(res.pairs.get(edgeKey(2, 5))?.nX).toEqual(new Map([[20, 1]]))
  })

  it('(i) undated units (dateMs 0) never glue into one series, in either order', () => {
    const u1: RawUnit = { authorId: 10, dateMs: 0, replyTo: null, tokens: new Uint32Array([1, 2]) }
    const u2: RawUnit = { authorId: 10, dateMs: 0, replyTo: null, tokens: new Uint32Array([3, 4]) }
    const u3: RawUnit = { authorId: 10, dateMs: 1000, replyTo: null, tokens: new Uint32Array([5, 6]) }
    const res = tally([u1, u2])
    expect(res.pairs.has(edgeKey(1, 2))).toBe(true)
    expect(res.pairs.has(edgeKey(3, 4))).toBe(true)
    expect(res.pairs.has(edgeKey(1, 3))).toBe(false)
    // a dated unit right after an undated one must not glue either
    expect(tally([u1, u3]).pairs.has(edgeKey(1, 5))).toBe(false)
  })

  it('(j) out-of-order timestamps (second dateMs < first) never glue into one series', () => {
    const u1: RawUnit = { authorId: 10, dateMs: 61000, replyTo: null, tokens: new Uint32Array([1, 2]) }
    const u2: RawUnit = { authorId: 10, dateMs: 1000, replyTo: null, tokens: new Uint32Array([3, 4]) }
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
